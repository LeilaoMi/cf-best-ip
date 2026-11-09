package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	dnsTypeHTTPS   = 65
	dnsClassIN     = 1
	svcParamKeyECH = 5
	maxDoHResponse = 64 << 10
)

// buildDNSQuery builds an RFC 1035 query message (RD=1) for name/qtype.
// RFC 8484 recommends ID=0 for cache friendliness; we use a random ID and
// verify it on the response instead, which is also allowed.
func buildDNSQuery(name string, qtype uint16) ([]byte, uint16, error) {
	var idb [2]byte
	if _, err := rand.Read(idb[:]); err != nil {
		return nil, 0, err
	}
	id := binary.BigEndian.Uint16(idb[:])
	var b bytes.Buffer
	hdr := make([]byte, 12)
	binary.BigEndian.PutUint16(hdr[0:], id)
	binary.BigEndian.PutUint16(hdr[2:], 0x0100) // RD
	binary.BigEndian.PutUint16(hdr[4:], 1)      // QDCOUNT
	b.Write(hdr)
	name = strings.TrimSuffix(name, ".")
	if name == "" {
		return nil, 0, errors.New("empty name")
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 {
			return nil, 0, fmt.Errorf("invalid label in %q", name)
		}
		b.WriteByte(byte(len(label)))
		b.WriteString(label)
	}
	b.WriteByte(0)
	tail := make([]byte, 4)
	binary.BigEndian.PutUint16(tail[0:], qtype)
	binary.BigEndian.PutUint16(tail[2:], dnsClassIN)
	b.Write(tail)
	return b.Bytes(), id, nil
}

// skipName advances past a (possibly compressed) domain name starting at off.
func skipName(msg []byte, off int) (int, error) {
	for {
		if off >= len(msg) {
			return 0, errors.New("name overflows message")
		}
		l := int(msg[off])
		switch {
		case l == 0:
			return off + 1, nil
		case l&0xC0 == 0xC0:
			if off+2 > len(msg) {
				return 0, errors.New("truncated compression pointer")
			}
			return off + 2, nil
		case l&0xC0 != 0:
			return 0, errors.New("unsupported label type")
		default:
			off += 1 + l
		}
	}
}

// parseECHFromDNSResponse extracts the first ECHConfigList (SvcParamKey 5)
// found in a ServiceMode HTTPS RR of the answer section.
func parseECHFromDNSResponse(msg []byte, wantID uint16) ([]byte, error) {
	if len(msg) < 12 {
		return nil, errors.New("short DNS response")
	}
	if id := binary.BigEndian.Uint16(msg[0:]); id != wantID {
		return nil, fmt.Errorf("DNS id mismatch: got %d want %d", id, wantID)
	}
	flags := binary.BigEndian.Uint16(msg[2:])
	if flags&0x8000 == 0 {
		return nil, errors.New("not a DNS response")
	}
	// TC: the HTTPS RRset may be partial, so its ECH config cannot be
	// trusted; failing lets the caller try -ech-fallback or stop.
	if flags&0x0200 != 0 {
		return nil, errors.New("truncated DNS response (TC set)")
	}
	if rcode := flags & 0x000F; rcode != 0 {
		return nil, fmt.Errorf("DNS rcode %d", rcode)
	}
	qd := int(binary.BigEndian.Uint16(msg[4:]))
	an := int(binary.BigEndian.Uint16(msg[6:]))
	off := 12
	var err error
	for i := 0; i < qd; i++ {
		if off, err = skipName(msg, off); err != nil {
			return nil, err
		}
		off += 4
	}
	for i := 0; i < an; i++ {
		if off, err = skipName(msg, off); err != nil {
			return nil, err
		}
		if off+10 > len(msg) {
			return nil, errors.New("truncated RR header")
		}
		rtype := binary.BigEndian.Uint16(msg[off:])
		rdlen := int(binary.BigEndian.Uint16(msg[off+8:]))
		off += 10
		if off+rdlen > len(msg) {
			return nil, errors.New("truncated RDATA")
		}
		rdata := msg[off : off+rdlen]
		off += rdlen
		if rtype != dnsTypeHTTPS {
			continue // e.g. CNAME chain
		}
		if ech, ok := echFromSVCB(rdata); ok {
			return ech, nil
		}
	}
	return nil, errors.New("no ech SvcParam in HTTPS records")
}

// echFromSVCB parses SVCB/HTTPS RDATA (RFC 9460 §2.2). TargetName is never
// compressed in SVCB RDATA.
func echFromSVCB(rdata []byte) ([]byte, bool) {
	if len(rdata) < 3 {
		return nil, false
	}
	if binary.BigEndian.Uint16(rdata) == 0 { // AliasMode
		return nil, false
	}
	off := 2
	for {
		if off >= len(rdata) {
			return nil, false
		}
		l := int(rdata[off])
		off++
		if l == 0 {
			break
		}
		if l&0xC0 != 0 {
			return nil, false
		}
		off += l
	}
	for off+4 <= len(rdata) {
		key := binary.BigEndian.Uint16(rdata[off:])
		vlen := int(binary.BigEndian.Uint16(rdata[off+2:]))
		off += 4
		if off+vlen > len(rdata) {
			return nil, false
		}
		if key == svcParamKeyECH && vlen > 0 {
			return append([]byte(nil), rdata[off:off+vlen]...), true
		}
		off += vlen
	}
	return nil, false
}

// fetchECHConfig queries dohURL (RFC 8484 POST, wireformat) for host's HTTPS RR.
func fetchECHConfig(ctx context.Context, client *http.Client, dohURL, host string) ([]byte, error) {
	q, id, err := buildDNSQuery(host, dnsTypeHTTPS)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dohURL, bytes.NewReader(q))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/dns-message")
	req.Header.Set("accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DoH HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDoHResponse))
	if err != nil {
		return nil, err
	}
	return parseECHFromDNSResponse(body, id)
}
