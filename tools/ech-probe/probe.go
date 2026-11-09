package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	statusOK         = "ok"
	statusRestricted = "restricted"
	statusUnknown    = "unknown"
	maxProbeBody     = 32 << 10
)

// error1034RE matches "Error 1034" / "error code: 1034" as whole words, so a
// Ray ID that merely contains the digits 1034 does not count.
var error1034RE = regexp.MustCompile(`(?i)\berror(?:\s+code)?\s*:?\s*1034\b`)

// classifyResponse decides restricted/ok from an HTTP response that was
// actually received. Network-level failures never reach this function.
func classifyResponse(code int, body string) string {
	if strings.Contains(body, "error code: 1034") || strings.Contains(body, "Edge IP Restricted") {
		return statusRestricted
	}
	if code == http.StatusForbidden && error1034RE.MatchString(body) {
		return statusRestricted
	}
	return statusOK
}

// aggregateIP folds per-sentinel results into one verdict:
// any restricted -> restricted; all ok -> ok; otherwise unknown.
func aggregateIP(results []string) string {
	if len(results) == 0 {
		return statusUnknown
	}
	allOK := true
	for _, r := range results {
		if r == statusRestricted {
			return statusRestricted
		}
		if r != statusOK {
			allOK = false
		}
	}
	if allOK {
		return statusOK
	}
	return statusUnknown
}

type probeTarget struct {
	Host string
	ECH  []byte
}

type attemptResult struct {
	Status string
	Code   int
	Err    error
}

// probeOnce dials ip:443, performs a TLS 1.3 handshake with ECH for host and
// sends a single HTTP/1.1 GET for path.
func probeOnce(ctx context.Context, ip string, t probeTarget, path string, timeout time.Duration) attemptResult {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	d := net.Dialer{}
	raw, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, "443"))
	if err != nil {
		return attemptResult{Status: statusUnknown, Err: fmt.Errorf("dial: %w", err)}
	}
	defer raw.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(dl)
	}
	conn := tls.Client(raw, &tls.Config{
		ServerName:                     t.Host,
		MinVersion:                     tls.VersionTLS13,
		NextProtos:                     []string{"http/1.1"},
		EncryptedClientHelloConfigList: t.ECH,
	})
	if err := conn.HandshakeContext(ctx); err != nil {
		var rej *tls.ECHRejectionError
		if errors.As(err, &rej) {
			return attemptResult{Status: statusUnknown, Err: fmt.Errorf("ech rejected (retry configs %d bytes)", len(rej.RetryConfigList))}
		}
		return attemptResult{Status: statusUnknown, Err: fmt.Errorf("handshake: %w", err)}
	}
	if !conn.ConnectionState().ECHAccepted {
		return attemptResult{Status: statusUnknown, Err: errors.New("ech not accepted")}
	}
	req := "GET " + path + " HTTP/1.1\r\nHost: " + t.Host +
		"\r\nUser-Agent: cf-best-ip-ech-probe/1\r\nAccept: */*\r\nConnection: close\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		return attemptResult{Status: statusUnknown, Err: fmt.Errorf("write: %w", err)}
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		return attemptResult{Status: statusUnknown, Err: fmt.Errorf("read response: %w", err)}
	}
	defer resp.Body.Close()
	// A short read of the body is fine: the 1034 page is tiny and fits.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxProbeBody))
	return attemptResult{Status: classifyResponse(resp.StatusCode, string(body)), Code: resp.StatusCode}
}

// probeWithRetry retries exactly once on network/handshake errors.
func probeWithRetry(ctx context.Context, ip string, t probeTarget, path string, timeout time.Duration) attemptResult {
	r := probeOnce(ctx, ip, t, path, timeout)
	if r.Err == nil {
		return r
	}
	select {
	case <-ctx.Done():
		return r
	case <-time.After(300 * time.Millisecond):
	}
	return probeOnce(ctx, ip, t, path, timeout)
}
