package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestClassifyResponse covers 1034 detection and false-positive guards.
func TestClassifyResponse(t *testing.T) {
	cases := []struct {
		code int
		body string
		want string
	}{
		{403, "error code: 1034", statusRestricted},
		{200, "<title>Edge IP Restricted | Cloudflare</title>", statusRestricted},
		{403, "Error 1034 ...", statusRestricted},
		{403, "<span>Error</span> <span>1034</span>", statusOK}, // markup in between: not matched, the title check covers real pages
		{403, "Ray ID: 8a1034b2c3d4e5f6", statusOK},
		{403, "error 10345", statusOK},
		{403, "error code: 10345", statusOK},
		{200, "error code: 10345", statusOK},
		{403, "error code: 1034\n", statusRestricted},
		{403, "error code: 1020", statusOK}, // WAF block is still an HTTP answer from a usable edge
		{200, "fl=123\nh=example.com\n", statusOK},
		{404, "not found", statusOK},
		{521, "error code: 521", statusOK},
		{200, "contains 1034 but not an error page", statusOK},
	}
	for _, c := range cases {
		if got := classifyResponse(c.code, c.body); got != c.want {
			t.Errorf("classifyResponse(%d, %q) = %s, want %s", c.code, c.body, got, c.want)
		}
	}
}

// TestAggregateIP checks the per-IP verdict across sentinels.
func TestAggregateIP(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{statusOK, statusOK}, statusOK},
		{[]string{statusOK, statusRestricted}, statusRestricted},
		{[]string{statusUnknown, statusRestricted}, statusRestricted},
		{[]string{statusOK, statusUnknown}, statusUnknown},
		{[]string{statusUnknown}, statusUnknown},
		{nil, statusUnknown},
	}
	for _, c := range cases {
		if got := aggregateIP(c.in); got != c.want {
			t.Errorf("aggregateIP(%v) = %s, want %s", c.in, got, c.want)
		}
	}
}

// mkSummary builds a summary with the given per-status counts.
func mkSummary(ok, restricted, unknown int) summary {
	return summary{Total: ok + restricted + unknown, Counts: map[string]int{statusOK: ok, statusRestricted: restricted, statusUnknown: unknown}}
}

// TestGuard checks the abnormal-environment thresholds.
func TestGuard(t *testing.T) {
	if err := guard(mkSummary(250, 24, 9), 0.5, 0.3); err != nil {
		t.Fatalf("normal run rejected: %v", err)
	}
	if err := guard(mkSummary(40, 60, 0), 0.5, 0.3); err == nil {
		t.Fatal("restricted > 50% must abort")
	}
	if err := guard(mkSummary(60, 0, 40), 0.5, 0.3); err == nil {
		t.Fatal("unknown > 30% must abort")
	}
	if err := guard(mkSummary(70, 0, 30), 0.5, 0.3); err != nil {
		t.Fatalf("exactly 30%% unknown should pass: %v", err)
	}
	if err := guard(mkSummary(0, 0, 0), 0.5, 0.3); err == nil {
		t.Fatal("empty run must abort")
	}
}

// TestSummarizeSortsRestricted checks counts and numeric IP ordering.
func TestSummarizeSortsRestricted(t *testing.T) {
	s := summarize([]ipResult{
		{IP: "198.41.208.26", Status: statusRestricted},
		{IP: "104.16.0.195", Status: statusOK},
		{IP: "162.159.136.89", Status: statusRestricted},
		{IP: "1.1.1.1", Status: statusUnknown},
	})
	if strings.Join(s.Restricted, ",") != "162.159.136.89,198.41.208.26" {
		t.Fatalf("restricted list = %v", s.Restricted)
	}
	if s.Counts[statusOK] != 1 || s.Counts[statusRestricted] != 2 || s.Counts[statusUnknown] != 1 {
		t.Fatalf("counts = %v", s.Counts)
	}
}

// buildHTTPSAnswer builds a DNS response for qname with a CNAME (compressed
// owner name) followed by an HTTPS RR carrying alpn + ech.
func buildHTTPSAnswer(t *testing.T, id uint16, qname string, ech []byte) []byte {
	t.Helper()
	q, _, err := buildDNSQuery(qname, dnsTypeHTTPS)
	if err != nil {
		t.Fatal(err)
	}
	msg := append([]byte(nil), q...)
	binary.BigEndian.PutUint16(msg[0:], id)
	binary.BigEndian.PutUint16(msg[2:], 0x8180) // QR RD RA, rcode 0
	binary.BigEndian.PutUint16(msg[6:], 2)      // ANCOUNT
	rr := func(rtype uint16, rdata []byte) {
		msg = append(msg, 0xC0, 0x0C) // pointer to qname
		var h [10]byte
		binary.BigEndian.PutUint16(h[0:], rtype)
		binary.BigEndian.PutUint16(h[2:], dnsClassIN)
		binary.BigEndian.PutUint32(h[4:], 300)
		binary.BigEndian.PutUint16(h[8:], uint16(len(rdata)))
		msg = append(msg, h[:]...)
		msg = append(msg, rdata...)
	}
	rr(5, []byte{0xC0, 0x0C}) // CNAME pointing back (content irrelevant)
	var rd bytes.Buffer
	rd.Write([]byte{0, 1, 0})                 // priority 1, target "."
	rd.Write([]byte{0, 1, 0, 3, 2, 'h', '2'}) // alpn=h2
	rd.Write([]byte{0, 5})                    // ech
	binary.Write(&rd, binary.BigEndian, uint16(len(ech)))
	rd.Write(ech)
	rr(dnsTypeHTTPS, rd.Bytes())
	return msg
}

// TestParseECHFromDNSResponse parses a CNAME + HTTPS answer and rejects
// mismatched or truncated messages.
func TestParseECHFromDNSResponse(t *testing.T) {
	ech := []byte{0x00, 0x45, 0xfe, 0x0d, 0x01, 0x02}
	msg := buildHTTPSAnswer(t, 0x1234, "doh.example.com", ech)
	got, err := parseECHFromDNSResponse(msg, 0x1234)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, ech) {
		t.Fatalf("ech = %x, want %x", got, ech)
	}
	if _, err := parseECHFromDNSResponse(msg, 0x9999); err == nil {
		t.Fatal("id mismatch must fail")
	}
	if _, err := parseECHFromDNSResponse(msg[:len(msg)-3], 0x1234); err == nil {
		t.Fatal("truncated message must fail")
	}
}

// TestEchFromSVCB rejects AliasMode, missing and truncated ech params.
func TestEchFromSVCB(t *testing.T) {
	if _, ok := echFromSVCB([]byte{0, 0, 0}); ok {
		t.Fatal("AliasMode must not yield ech")
	}
	if _, ok := echFromSVCB([]byte{0, 1, 0, 0, 1, 0, 3, 2, 'h', '2'}); ok {
		t.Fatal("record without ech key must not yield ech")
	}
	if _, ok := echFromSVCB([]byte{0, 1, 0, 0, 5, 0, 9, 1}); ok {
		t.Fatal("truncated ech value must not yield ech")
	}
}

// TestBuildDNSQueryRejectsBadNames checks hostname validation.
func TestBuildDNSQueryRejectsBadNames(t *testing.T) {
	for _, n := range []string{"", ".", "a..b", strings.Repeat("a", 64) + ".com"} {
		if _, _, err := buildDNSQuery(n, dnsTypeHTTPS); err == nil {
			t.Errorf("buildDNSQuery(%q) should fail", n)
		}
	}
}

// TestFetchECHConfigOverDoH runs a full RFC 8484 POST round trip.
func TestFetchECHConfigOverDoH(t *testing.T) {
	ech := []byte{1, 2, 3, 4}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("content-type") != "application/dns-message" {
			http.Error(w, "bad request", 400)
			return
		}
		q, _ := io.ReadAll(r.Body)
		id := binary.BigEndian.Uint16(q)
		w.Header().Set("content-type", "application/dns-message")
		w.Write(buildHTTPSAnswer(t, id, "doh.example.com", ech))
	}))
	defer srv.Close()
	got, err := fetchECHConfig(context.Background(), srv.Client(), srv.URL, "doh.example.com")
	if err != nil || !bytes.Equal(got, ech) {
		t.Fatalf("fetchECHConfig = %x, %v", got, err)
	}
}

// TestParseOptions checks env defaults, dedup and flag validation.
func TestParseOptions(t *testing.T) {
	t.Setenv("ECH_API_BASE", "")
	t.Setenv("ECH_SENTINELS", " A.example.com, b.example.com ,a.example.com,")
	o, err := parseOptions([]string{"-dry-run", "-ips", "1.2.3.4, 5.6.7.8"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(o.sentinels, ",") != "a.example.com,b.example.com" {
		t.Fatalf("sentinels = %v", o.sentinels)
	}
	if !o.dryRun || strings.Join(o.ipsOverride, ",") != "1.2.3.4,5.6.7.8" {
		t.Fatalf("options = %+v", o)
	}
	if _, err := parseOptions([]string{"-ips", "2606:4700::1"}); err == nil {
		t.Fatal("IPv6 in -ips must be rejected")
	}
	if _, err := parseOptions([]string{"-path", "cdn-cgi/trace"}); err == nil {
		t.Fatal("relative path must be rejected")
	}
}

// TestReport checks the report request and non-2xx handling.
func TestReport(t *testing.T) {
	var got reportBody
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("authorization")
		if r.URL.Path != "/api/ech-report" {
			http.NotFound(w, r)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true,"accepted":1}`))
	}))
	defer srv.Close()
	body := reportBody{RunID: "42", Sentinels: []string{"a.example.com"}, Results: []ipResult{{IP: "1.2.3.4", Status: statusRestricted}}}
	if err := report(context.Background(), srv.Client(), srv.URL, "tok", body); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer tok" || got.RunID != "42" || len(got.Results) != 1 || got.Results[0].Status != statusRestricted {
		t.Fatalf("auth=%q body=%+v", auth, got)
	}

	fail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"ok":false,"error":"unauthorized"}`, http.StatusUnauthorized)
	}))
	defer fail.Close()
	if err := report(context.Background(), fail.Client(), fail.URL, "bad", body); err == nil {
		t.Fatal("non-2xx report must fail")
	}
}

// TestRunRequiresTokenUnlessDryRun checks the missing-secret exit code.
func TestRunRequiresTokenUnlessDryRun(t *testing.T) {
	t.Setenv("ECH_REPORT_TOKEN", "")
	t.Setenv("ECH_SENTINELS", "sentinel.example.com")
	t.Setenv("ECH_API_BASE", "https://bestip.example.com")
	if code := run([]string{"-ips", "1.2.3.4"}); code != 2 {
		t.Fatalf("run without token = %d, want 2", code)
	}
}

// TestAPIBaseHasNoDefault checks that the report/pool URL must be given
// explicitly (env ECH_API_BASE or -api) and must be https.
func TestAPIBaseHasNoDefault(t *testing.T) {
	t.Setenv("ECH_API_BASE", "")
	t.Setenv("ECH_SENTINELS", "sentinel.example.com")
	for _, args := range [][]string{
		{"-dry-run"},        // dry-run still fetches the pool
		{"-ips", "1.2.3.4"}, // reporting needs a target
		{"-api", "http://bestip.example.com"},
		{"-api", "bestip.example.com"},
		{"-api", "https://bestip.example.com/?x=1"},
	} {
		if _, err := parseOptions(args); err == nil {
			t.Fatalf("parseOptions(%v) must fail", args)
		}
	}
	// dry-run on fixed IPs needs no API at all
	if _, err := parseOptions([]string{"-dry-run", "-ips", "1.2.3.4"}); err != nil {
		t.Fatal(err)
	}
	o, err := parseOptions([]string{"-api", "https://bestip.example.com/"})
	if err != nil || o.apiBase != "https://bestip.example.com" {
		t.Fatalf("-api: %+v %v", o.apiBase, err)
	}
	t.Setenv("ECH_API_BASE", "https://env.example.com")
	if o, err := parseOptions(nil); err != nil || o.apiBase != "https://env.example.com" {
		t.Fatalf("env: %+v %v", o.apiBase, err)
	}
	t.Setenv("ECH_API_BASE", "")
	t.Setenv("ECH_REPORT_TOKEN", "tok")
	if code := run([]string{"-ips", "1.2.3.4"}); code != 2 {
		t.Fatalf("run without API base = %d, want 2", code)
	}
}

// TestSentinelsHaveNoDefault checks that sentinels must be given explicitly
// (env ECH_SENTINELS or -sentinels), dry-run included.
func TestSentinelsHaveNoDefault(t *testing.T) {
	t.Setenv("ECH_API_BASE", "https://bestip.example.com")
	t.Setenv("ECH_REPORT_TOKEN", "tok")
	for _, v := range []string{"", " , ,"} {
		t.Setenv("ECH_SENTINELS", v)
		for _, args := range [][]string{
			nil,
			{"-dry-run"},
			{"-dry-run", "-ips", "1.2.3.4"},
			{"-sentinels", " , "},
		} {
			if _, err := parseOptions(args); err == nil || !strings.Contains(err.Error(), "ECH_SENTINELS") {
				t.Fatalf("ECH_SENTINELS=%q parseOptions(%v) err = %v, want sentinels error", v, args, err)
			}
		}
		if code := run([]string{"-dry-run", "-ips", "1.2.3.4"}); code != 2 {
			t.Fatalf("run without sentinels = %d, want 2", code)
		}
	}
	o, err := parseOptions([]string{"-sentinels", "One.example.com,two.example.com"})
	if err != nil || strings.Join(o.sentinels, ",") != "one.example.com,two.example.com" {
		t.Fatalf("-sentinels: %v %v", o.sentinels, err)
	}
	// reporting is capped at the Worker's limit; dry-run is not
	var many []string
	for i := 0; i <= maxSentinels; i++ {
		many = append(many, fmt.Sprintf("s%d.example.com", i))
	}
	if _, err := parseOptions([]string{"-sentinels", strings.Join(many, ",")}); err == nil {
		t.Fatalf("%d sentinels must be rejected when reporting", len(many))
	}
	if _, err := parseOptions([]string{"-sentinels", strings.Join(many[:maxSentinels], ",")}); err != nil {
		t.Fatalf("%d sentinels must be accepted: %v", maxSentinels, err)
	}
	if _, err := parseOptions([]string{"-dry-run", "-sentinels", strings.Join(many, ",")}); err != nil {
		t.Fatalf("dry-run must accept %d sentinels: %v", len(many), err)
	}
	t.Setenv("ECH_SENTINELS", "env.example.com")
	if o, err := parseOptions([]string{"-sentinels", "flag.example.com"}); err != nil || strings.Join(o.sentinels, ",") != "flag.example.com" {
		t.Fatalf("flag must override env: %v %v", o.sentinels, err)
	}
}

// TestFetchPoolOneRequestWithToken checks the single full-pool request.
func TestFetchPoolOneRequestWithToken(t *testing.T) {
	var calls int
	var auth, query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		auth, query = r.Header.Get("authorization"), r.URL.RawQuery
		if r.URL.Path != "/api/ips" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"ok":true,"total":4,"ips":[{"ip":"1.2.3.4"},{"ip":"2606:4700::1"},{"ip":"5.6.7.8"},{"ip":"1.2.3.4"}]}`))
	}))
	defer srv.Close()
	got, err := fetchPool(context.Background(), srv.Client(), srv.URL, "tok")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || auth != "Bearer tok" || query != "limit=2000&perCountry=0" {
		t.Fatalf("calls=%d auth=%q query=%q", calls, auth, query)
	}
	if strings.Join(got.IPs, ",") != "1.2.3.4,5.6.7.8" || got.Total != 4 || got.Returned != 4 {
		t.Fatalf("pool = %+v", got)
	}
	if _, err := fetchPool(context.Background(), srv.Client(), srv.URL, ""); err != nil || auth != "" {
		t.Fatalf("no token: auth=%q err=%v", auth, err)
	}
}

// TestPoolWarnings checks the truncation warnings.
func TestPoolWarnings(t *testing.T) {
	if w := poolWarnings(poolResult{Total: 328, Returned: 328}, true); len(w) != 0 {
		t.Fatalf("full pool warned: %v", w)
	}
	if w := poolWarnings(poolResult{Total: 2500, Returned: 2000}, true); len(w) != 2 || !strings.Contains(w[0], "cap") {
		t.Fatalf("cap hit: %v", w)
	}
	if w := poolWarnings(poolResult{Total: 2000, Returned: 2000}, true); len(w) != 1 {
		t.Fatalf("exactly at cap must warn: %v", w)
	}
	if w := poolWarnings(poolResult{Total: 328, Returned: 200}, false); len(w) != 1 || !strings.Contains(w[0], "no ECH_REPORT_TOKEN") {
		t.Fatalf("public cap: %v", w)
	}
	if w := poolWarnings(poolResult{Total: 328, Returned: 200}, true); len(w) != 1 || !strings.Contains(w[0], "not have") {
		t.Fatalf("old worker: %v", w)
	}
}

// TestCheckRedirectRefusesDowngrade checks that credentials never follow a
// redirect to plain http and that the default redirect limit stays.
func TestCheckRedirectRefusesDowngrade(t *testing.T) {
	mk := func(u string) *http.Request {
		r, err := http.NewRequest(http.MethodGet, u, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	via := []*http.Request{mk("https://bestip.example.com/api/ips")}
	if err := checkRedirect(mk("http://bestip.example.com/api/ips"), via); !errors.Is(err, errInsecureRedirect) {
		t.Fatalf("http redirect: %v", err)
	}
	if err := checkRedirect(mk("https://bestip.example.com/api/ips/"), via); err != nil {
		t.Fatalf("https redirect: %v", err)
	}
	ten := make([]*http.Request, 10)
	for i := range ten {
		ten[i] = via[0]
	}
	if err := checkRedirect(mk("https://bestip.example.com/x"), ten); err == nil {
		t.Fatal("11th redirect must stop")
	}
	if newHTTPClient().CheckRedirect == nil {
		t.Fatal("client must install checkRedirect")
	}
}
