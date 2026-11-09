package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClassifyResponse(t *testing.T) {
	cases := []struct {
		code int
		body string
		want string
	}{
		{403, "error code: 1034", statusRestricted},
		{200, "<title>Edge IP Restricted | Cloudflare</title>", statusRestricted},
		{403, "Error 1034 ...", statusRestricted},
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

func mkSummary(ok, restricted, unknown int) summary {
	return summary{Total: ok + restricted + unknown, Counts: map[string]int{statusOK: ok, statusRestricted: restricted, statusUnknown: unknown}}
}

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

func TestBuildDNSQueryRejectsBadNames(t *testing.T) {
	for _, n := range []string{"", ".", "a..b", strings.Repeat("a", 64) + ".com"} {
		if _, _, err := buildDNSQuery(n, dnsTypeHTTPS); err == nil {
			t.Errorf("buildDNSQuery(%q) should fail", n)
		}
	}
}

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

func TestParseOptions(t *testing.T) {
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

func TestRunRequiresTokenUnlessDryRun(t *testing.T) {
	t.Setenv("ECH_REPORT_TOKEN", "")
	if code := run([]string{"-ips", "1.2.3.4"}); code != 2 {
		t.Fatalf("run without token = %d, want 2", code)
	}
}
