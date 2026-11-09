// Command ech-probe tags the cf-best-ip pool with ECH usability.
//
// Some Cloudflare edge IPs answer "error code: 1034 / Edge IP Restricted" when
// a client connects to a Free-plan site with Encrypted Client Hello, while the
// same IP works without ECH. This tool connects to every pool IP with ECH for a
// few sentinel hostnames, classifies each IP as ok / restricted / unknown and
// reports the result to the Worker's POST /api/ech-report.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultDoH   = "https://cloudflare-dns.com/dns-query"
	maxReportIPs = 2000 // must match the Worker's limit
	poolLimit    = 2000 // /api/ips row cap for ECH_REPORT_TOKEN holders (Worker ECH_READER_MAX_TOP)
	userAgent    = "cf-best-ip-ech-probe/1"
)

type options struct {
	apiBase       string
	dohURL        string
	echFallback   string
	sentinels     []string
	path          string
	concurrency   int
	timeout       time.Duration
	dryRun        bool
	ipsOverride   []string
	maxRestricted float64
	maxUnknown    float64
	verbose       bool
}

// splitList splits a comma-separated list, trimming, lowercasing and
// deduplicating entries while keeping their order.
func splitList(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range strings.Split(s, ",") {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// envOr returns the trimmed value of env var key, or def when it is empty.
func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// parseOptions parses command-line flags (with env var defaults) and
// validates them.
func parseOptions(args []string) (options, error) {
	var o options
	fs := flag.NewFlagSet("ech-probe", flag.ContinueOnError)
	fs.StringVar(&o.apiBase, "api", envOr("ECH_API_BASE", ""),
		"your cf-best-ip Worker HTTPS base URL, pool source and report target (env ECH_API_BASE; no default)")
	fs.StringVar(&o.dohURL, "doh", envOr("ECH_DOH_URL", defaultDoH), "DoH endpoint (RFC 8484) used to fetch ECH configs")
	fs.StringVar(&o.echFallback, "ech-fallback", envOr("ECH_FALLBACK_HOST", "cloudflare-ech.com"),
		"host whose ECH config is used for sentinels that publish none (Cloudflare shares one ECH key; empty disables)")
	sentinels := fs.String("sentinels", envOr("ECH_SENTINELS", ""),
		"comma-separated sentinel hostnames: your own Cloudflare-proxied hosts that answer 1034 on restricted IPs (env ECH_SENTINELS; required, no default)")
	fs.StringVar(&o.path, "path", "/cdn-cgi/trace", "HTTP path requested on each sentinel")
	fs.IntVar(&o.concurrency, "concurrency", 16, "parallel IP probes")
	fs.DurationVar(&o.timeout, "timeout", 8*time.Second, "timeout per connection attempt")
	fs.BoolVar(&o.dryRun, "dry-run", false, "print the summary only, do not report")
	ips := fs.String("ips", "", "comma-separated IPv4 list to probe instead of the live pool (testing)")
	fs.Float64Var(&o.maxRestricted, "max-restricted", 0.5, "abort without reporting if restricted share exceeds this")
	fs.Float64Var(&o.maxUnknown, "max-unknown", 0.3, "abort without reporting if unknown share exceeds this")
	fs.BoolVar(&o.verbose, "v", false, "print every probe result")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	o.sentinels = splitList(*sentinels)
	// No built-in default: a sentinel the operator does not control can
	// change plan, drop ECH or alter its responses, silently turning
	// restricted IPs into "ok".
	if len(o.sentinels) == 0 {
		return o, errors.New("sentinels not set: set ECH_SENTINELS (Actions variable) or -sentinels to your own Cloudflare-proxied hostnames that return error 1034 on restricted IPs")
	}
	for _, s := range splitList(*ips) {
		a, err := netip.ParseAddr(s)
		if err != nil || !a.Is4() {
			return o, fmt.Errorf("-ips: %q is not an IPv4 address", s)
		}
		o.ipsOverride = append(o.ipsOverride, a.String())
	}
	if o.concurrency < 1 {
		o.concurrency = 1
	}
	if !strings.HasPrefix(o.path, "/") {
		return o, errors.New("-path must start with /")
	}
	o.apiBase = strings.TrimRight(o.apiBase, "/")
	// The API base receives the ECH_REPORT_TOKEN, so it has no default and
	// must be an explicit https URL whenever it is used: to fetch the pool
	// (no -ips) or to report (no -dry-run).
	if o.apiBase == "" {
		if len(o.ipsOverride) == 0 || !o.dryRun {
			return o, errors.New("API base not set: set ECH_API_BASE (Actions variable) or -api to your own Worker's https URL")
		}
	} else if err := checkAPIBase(o.apiBase); err != nil {
		return o, err
	}
	return o, nil
}

// checkAPIBase requires an absolute https URL without query or fragment.
func checkAPIBase(s string) error {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("-api / ECH_API_BASE %q must be an https URL like https://bestip.example.com", s)
	}
	return nil
}

// ---------------------------------------------------------------- pool

type ipsResponse struct {
	OK    bool `json:"ok"`
	Total int  `json:"total"`
	IPs   []struct {
		IP     string `json:"ip"`
		Family string `json:"family"`
	} `json:"ips"`
}

// getJSON fetches u (with the optional Bearer token), retrying once on
// transport errors and 5xx. Older Workers' per-IP rate limiter could answer
// 500 when KV rejected a same-key write, so one retry is cheap insurance.
func getJSON(ctx context.Context, client *http.Client, u, token string, v any) error {
	err := getJSONOnce(ctx, client, u, token, v)
	if err == nil || errors.Is(err, errClientStatus) {
		return err
	}
	select {
	case <-ctx.Done():
		return err
	case <-time.After(1500 * time.Millisecond):
	}
	return getJSONOnce(ctx, client, u, token, v)
}

var errClientStatus = errors.New("client error status")

// getJSONOnce performs a single GET of u and decodes the JSON body into v.
// 4xx responses wrap errClientStatus so callers do not retry them.
func getJSONOnce(ctx context.Context, client *http.Client, u, token string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("user-agent", userAgent)
	req.Header.Set("accept", "application/json")
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return fmt.Errorf("GET %s: HTTP %d: %w", u, resp.StatusCode, errClientStatus)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", u, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(v)
}

// poolResult is the deduplicated IPv4 part of one /api/ips response.
type poolResult struct {
	IPs      []string // deduplicated IPv4, pool order
	Total    int      // pool size reported by the Worker (v4 + v6)
	Returned int      // rows in the response (v4 + v6)
}

// fetchPool reads the whole pool in one request: /api/ips?limit=2000 with
// the ECH_REPORT_TOKEN, which the Worker honours by lifting its public
// 200-row cap. Without a token (dry-run) or against a Worker that predates
// that change the answer is capped at 200 rows; warnings name the gap.
func fetchPool(ctx context.Context, client *http.Client, base, token string) (poolResult, error) {
	var r ipsResponse
	u := fmt.Sprintf("%s/api/ips?limit=%d&perCountry=0", base, poolLimit)
	if err := getJSON(ctx, client, u, token, &r); err != nil {
		return poolResult{}, err
	}
	res := poolResult{Total: r.Total, Returned: len(r.IPs)}
	seen := map[string]bool{}
	for _, x := range r.IPs {
		a, err := netip.ParseAddr(x.IP)
		if err != nil || !a.Is4() {
			continue
		}
		if s := a.String(); !seen[s] {
			seen[s] = true
			res.IPs = append(res.IPs, s)
		}
	}
	for _, w := range poolWarnings(res, token != "") {
		fmt.Fprintln(os.Stderr, "warn: "+w)
	}
	return res, nil
}

// poolWarnings explains why a pool response may not cover the whole pool.
func poolWarnings(r poolResult, withToken bool) []string {
	var w []string
	if r.Returned >= poolLimit {
		w = append(w, fmt.Sprintf("/api/ips returned %d rows = the %d-row cap; the pool may be larger and the rest is not probed", r.Returned, poolLimit))
	}
	if r.Total > r.Returned {
		why := "the Worker may not have the ECH_REPORT_TOKEN cap lift deployed, or the token does not match"
		if !withToken {
			why = "no ECH_REPORT_TOKEN, public cap is 200 rows"
		}
		w = append(w, fmt.Sprintf("only %d of %d pool rows fetched (%s)", r.Returned, r.Total, why))
	}
	return w
}

// ---------------------------------------------------------------- run

type ipResult struct {
	IP        string            `json:"ip"`
	Status    string            `json:"status"`
	PerTarget map[string]string `json:"-"`
}

// runProbes probes every IP against every target with o.concurrency
// workers and returns one aggregated result per IP, in input order. IPs not
// reached before ctx is cancelled are reported as unknown.
func runProbes(ctx context.Context, o options, ips []string, targets []probeTarget) []ipResult {
	results := make([]ipResult, len(ips))
	jobs := make(chan int)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for w := 0; w < o.concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				per := map[string]string{}
				var statuses []string
				for _, t := range targets {
					r := probeWithRetry(ctx, ips[i], t, o.path, o.timeout)
					statuses = append(statuses, r.Status)
					per[t.Host] = r.Status
					if o.verbose {
						mu.Lock()
						if r.Err != nil {
							fmt.Fprintf(os.Stderr, "  %-16s %-28s %-10s %v\n", ips[i], t.Host, r.Status, r.Err)
						} else {
							fmt.Fprintf(os.Stderr, "  %-16s %-28s %-10s HTTP %d\n", ips[i], t.Host, r.Status, r.Code)
						}
						mu.Unlock()
					}
				}
				results[i] = ipResult{IP: ips[i], Status: aggregateIP(statuses), PerTarget: per}
			}
		}()
	}
	for i := range ips {
		select {
		case jobs <- i:
		case <-ctx.Done():
			for j := i; j < len(ips); j++ {
				results[j] = ipResult{IP: ips[j], Status: statusUnknown}
			}
			close(jobs)
			wg.Wait()
			return results
		}
	}
	close(jobs)
	wg.Wait()
	return results
}

type summary struct {
	Total      int
	Counts     map[string]int
	Restricted []string
}

// summarize counts results per status and lists restricted IPs in address
// order.
func summarize(results []ipResult) summary {
	s := summary{Total: len(results), Counts: map[string]int{statusOK: 0, statusRestricted: 0, statusUnknown: 0}}
	for _, r := range results {
		s.Counts[r.Status]++
		if r.Status == statusRestricted {
			s.Restricted = append(s.Restricted, r.IP)
		}
	}
	sort.Slice(s.Restricted, func(i, j int) bool {
		a, _ := netip.ParseAddr(s.Restricted[i])
		b, _ := netip.ParseAddr(s.Restricted[j])
		return a.Less(b)
	})
	return s
}

// guard returns an error when the run looks like a broken probe environment
// rather than a real picture of the pool.
func guard(s summary, maxRestricted, maxUnknown float64) error {
	if s.Total == 0 {
		return errors.New("no IPs probed")
	}
	r := float64(s.Counts[statusRestricted]) / float64(s.Total)
	u := float64(s.Counts[statusUnknown]) / float64(s.Total)
	if r > maxRestricted {
		return fmt.Errorf("restricted share %.1f%% > %.0f%%: probe environment looks abnormal", r*100, maxRestricted*100)
	}
	if u > maxUnknown {
		return fmt.Errorf("unknown share %.1f%% > %.0f%%: probe environment looks abnormal", u*100, maxUnknown*100)
	}
	return nil
}

type reportBody struct {
	RunID     string     `json:"runId"`
	Sentinels []string   `json:"sentinels"`
	Results   []ipResult `json:"results"`
}

// report POSTs the run to base/api/ech-report with the Bearer token and
// fails on any non-2xx answer.
func report(ctx context.Context, client *http.Client, base, token string, body reportBody) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/ech-report", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("report HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	fmt.Printf("report accepted: %s\n", strings.TrimSpace(string(respBody)))
	return nil
}

// runID identifies the run: GITHUB_RUN_ID (plus the attempt number on
// re-runs) in Actions, a UTC timestamp otherwise.
func runID() string {
	if id := strings.TrimSpace(os.Getenv("GITHUB_RUN_ID")); id != "" {
		if a := strings.TrimSpace(os.Getenv("GITHUB_RUN_ATTEMPT")); a != "" && a != "1" {
			return id + "." + a
		}
		return id
	}
	return "local-" + time.Now().UTC().Format("20060102T150405Z")
}

// errInsecureRedirect is returned for redirects that would leave HTTPS.
var errInsecureRedirect = errors.New("refusing redirect to a non-https URL")

// checkRedirect refuses any redirect that leaves https (requests may carry
// the ECH_REPORT_TOKEN) and keeps Go's default limit of 10 redirects. Go
// already drops Authorization on redirects to another host.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" {
		return fmt.Errorf("%w: %s", errInsecureRedirect, req.URL.Redacted())
	}
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	return nil
}

// newHTTPClient is the client used for DoH, the pool and the report.
func newHTTPClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second, CheckRedirect: checkRedirect}
}

// run is the whole program; it returns the process exit code (0 ok,
// 1 probe/report failure or guard tripped, 2 usage error).
func run(args []string) int {
	o, err := parseOptions(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 2
	}
	token := strings.TrimSpace(os.Getenv("ECH_REPORT_TOKEN"))
	if !o.dryRun && token == "" {
		fmt.Fprintln(os.Stderr, "error: ECH_REPORT_TOKEN is not set (set the Actions secret ECH_REPORT_TOKEN, or use -dry-run)")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	httpClient := newHTTPClient()

	var targets []probeTarget
	var fallbackECH []byte
	for _, h := range o.sentinels {
		ech, err := fetchECHConfig(ctx, httpClient, o.dohURL, h)
		if err != nil && o.echFallback != "" {
			if fallbackECH == nil {
				fallbackECH, _ = fetchECHConfig(ctx, httpClient, o.dohURL, o.echFallback)
			}
			if fallbackECH != nil {
				fmt.Fprintf(os.Stderr, "note: sentinel %s publishes no ECH config (%v); using %s's\n", h, err, o.echFallback)
				ech, err = fallbackECH, nil
			}
		}
		if err != nil {
			// Probing with fewer sentinels than configured would weaken the
			// verdict (e.g. losing the strict Free-plan sentinel turns
			// restricted IPs into ok), so stop instead of reporting.
			fmt.Fprintf(os.Stderr, "error: sentinel %s has no ECH config (and no fallback): %v; nothing reported\n", h, err)
			return 1
		}
		targets = append(targets, probeTarget{Host: h, ECH: ech})
	}

	ips := o.ipsOverride
	poolTotal := 0
	if len(ips) == 0 {
		pool, err := fetchPool(ctx, httpClient, o.apiBase, token)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error: fetch pool:", err)
			return 1
		}
		ips, poolTotal = pool.IPs, pool.Total
	}
	if len(ips) > maxReportIPs {
		fmt.Fprintf(os.Stderr, "warn: %d IPs, probing the first %d only\n", len(ips), maxReportIPs)
		ips = ips[:maxReportIPs]
	}
	var hosts []string
	for _, t := range targets {
		hosts = append(hosts, t.Host)
	}
	fmt.Printf("probing %d IPv4 (pool total incl. v6: %d) x %d sentinels [%s] path=%s concurrency=%d timeout=%s\n",
		len(ips), poolTotal, len(targets), strings.Join(hosts, ","), o.path, o.concurrency, o.timeout)

	start := time.Now()
	results := runProbes(ctx, o, ips, targets)
	s := summarize(results)
	fmt.Printf("done in %s: total=%d ok=%d restricted=%d unknown=%d\n",
		time.Since(start).Round(time.Second), s.Total, s.Counts[statusOK], s.Counts[statusRestricted], s.Counts[statusUnknown])
	if len(s.Restricted) > 0 {
		fmt.Printf("restricted IPs (%d):\n", len(s.Restricted))
		for _, ip := range s.Restricted {
			fmt.Println("  " + ip)
		}
	}
	if ctx.Err() != nil {
		fmt.Fprintln(os.Stderr, "error: interrupted; nothing reported")
		return 1
	}
	if err := guard(s, o.maxRestricted, o.maxUnknown); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err, "- nothing reported")
		return 1
	}
	if o.dryRun {
		fmt.Println("dry-run: not reporting")
		return 0
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := report(rctx, httpClient, o.apiBase, token, reportBody{RunID: runID(), Sentinels: hosts, Results: results}); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	return 0
}

// main exits with run's status code.
func main() {
	os.Exit(run(os.Args[1:]))
}
