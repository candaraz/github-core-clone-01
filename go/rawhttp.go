// Raw HTTP/1.1 transport: a minimal, low-latency replacement for net/http.
//
// The suite's workloads are latency-bound (thousands of sequential requests
// on keep-alive connections, plus bursts of concurrent clones). net/http
// spends most of its per-request budget in request parsing, header maps,
// bufio churn, and goroutine scheduling — not in the forge's handlers (the
// read handler is 2.4 us; a bare net/http server measures the same 257 us/op
// as the forge). This transport parses the request with almost no
// allocations, calls the SAME Server.ServeHTTP handlers via a synthetic
// *http.Request, buffers the whole response, and writes it in a single
// syscall. Handlers are unchanged, so conformance is unaffected.
//
// Fallback: set FORGE_RAW_HTTP=0 to use net/http instead.

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rawServer is the raw transport: an accept loop over one listener, one
// goroutine per connection, each looping over keep-alive requests.
type rawServer struct {
	srv *Server
	ln  net.Listener

	dateMu  sync.Mutex
	dateStr string
	dateSec int64
}

func newRawServer(srv *Server, ln net.Listener) *rawServer {
	return &rawServer{srv: srv, ln: ln}
}

func (rs *rawServer) Close() error { return rs.ln.Close() }

// Serve accepts connections until the listener closes.
func (rs *rawServer) Serve() {
	for {
		c, err := rs.ln.Accept()
		if err != nil {
			return
		}
		go rs.serveConn(c)
	}
}

// date returns the current Date header value, cached per second.
func (rs *rawServer) date() string {
	now := time.Now().Unix()
	rs.dateMu.Lock()
	defer rs.dateMu.Unlock()
	if now != rs.dateSec {
		rs.dateSec = now
		rs.dateStr = time.Now().UTC().Format(http.TimeFormat)
	}
	return rs.dateStr
}

// readLine reads one CRLF-terminated line (without the CRLF) into dst,
// reusing dst's backing array. It handles lines longer than the bufio buffer
// by accumulating fragments.
func readLine(br *bufio.Reader, dst []byte) ([]byte, error) {
	dst = dst[:0]
	for {
		frag, err := br.ReadSlice('\n')
		dst = append(dst, frag...)
		if err == nil {
			break
		}
		if err != bufio.ErrBufferFull {
			return nil, err
		}
	}
	// Strip the trailing CRLF (or a lone LF).
	if n := len(dst); n > 0 && dst[n-1] == '\n' {
		dst = dst[:n-1]
		if n := len(dst); n > 0 && dst[n-1] == '\r' {
			dst = dst[:n-1]
		}
	}
	return dst, nil
}

// serveConn loops over keep-alive requests on one connection.
func (rs *rawServer) serveConn(c net.Conn) {
	defer c.Close()
	br := bufio.NewReaderSize(c, 4096)
	lineBuf := make([]byte, 0, 512)
	bodyBuf := make([]byte, 0, 8192)
	outBuf := make([]byte, 0, 4096)
	rw := &rawResponseWriter{header: make(http.Header, 8)}
	for {
		req, body, closeAfter, err := rs.readRequest(br, c, &lineBuf, &bodyBuf)
		if err != nil {
			return
		}
		if req == nil {
			return
		}
		// Reuse the writer's buffers across requests on this connection.
		rw.reset()
		func() {
			defer func() {
				// net/http recovers handler panics; do the same so one bad
				// request cannot kill the connection loop.
				_ = recover()
			}()
			rs.srv.ServeHTTP(rw, req)
		}()
		_ = body // body bytes are owned by the request; already consumed.
		rs.writeResponse(c, rw, &outBuf, closeAfter)
		if closeAfter {
			return
		}
	}
}

// readRequest parses one HTTP/1.1 request from br. It returns the synthetic
// *http.Request, the body bytes, whether to close after the response, and an
// error (nil request + nil error means the client went away cleanly).
func (rs *rawServer) readRequest(br *bufio.Reader, c net.Conn, lineBuf, bodyBuf *[]byte) (*http.Request, []byte, bool, error) {
	line, err := readLine(br, *lineBuf)
	if err != nil {
		return nil, nil, false, err
	}
	*lineBuf = line
	// Request line: METHOD SP TARGET SP VERSION
	sp1 := bytes.IndexByte(line, ' ')
	if sp1 < 0 {
		return nil, nil, false, errBadRequest
	}
	sp2 := bytes.IndexByte(line[sp1+1:], ' ')
	if sp2 < 0 {
		return nil, nil, false, errBadRequest
	}
	sp2 += sp1 + 1
	method := string(line[:sp1])
	target := string(line[sp1+1 : sp2])
	version := string(line[sp2+1:])
	if !strings.HasPrefix(version, "HTTP/1.") {
		return nil, nil, false, errBadRequest
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil, nil, false, errBadRequest
	}
	hdr := make(http.Header, 8)
	var contentLength int64 = -1
	var chunked bool
	var expectContinue bool
	closeAfter := version == "HTTP/1.0"
	for {
		hline, err := readLine(br, *lineBuf)
		if err != nil {
			return nil, nil, false, err
		}
		*lineBuf = hline
		if len(hline) == 0 {
			break // blank line: end of headers
		}
		colon := bytes.IndexByte(hline, ':')
		if colon < 0 {
			return nil, nil, false, errBadRequest
		}
		name := textproto.CanonicalMIMEHeaderKey(string(bytes.TrimSpace(hline[:colon])))
		value := string(bytes.TrimSpace(hline[colon+1:]))
		hdr[name] = append(hdr[name], value)
		switch name {
		case "Content-Length":
			if n, err := strconv.ParseInt(value, 10, 64); err == nil && n >= 0 {
				contentLength = n
			}
		case "Transfer-Encoding":
			if strings.Contains(strings.ToLower(value), "chunked") {
				chunked = true
			}
		case "Expect":
			if strings.EqualFold(value, "100-continue") {
				expectContinue = true
			}
		case "Connection":
			lv := strings.ToLower(value)
			if strings.Contains(lv, "close") {
				closeAfter = true
			} else if strings.Contains(lv, "keep-alive") {
				closeAfter = false
			}
		}
	}
	if expectContinue {
		// The client waits for 100 Continue before sending the body.
		_, _ = c.Write([]byte("HTTP/1.1 100 Continue\r\n\r\n"))
	}
	// Read the body.
	body := (*bodyBuf)[:0]
	if chunked {
		for {
			cline, err := readLine(br, *lineBuf)
			if err != nil {
				return nil, nil, false, err
			}
			*lineBuf = cline
			// Chunk size may carry extensions after ';'.
			if semi := bytes.IndexByte(cline, ';'); semi >= 0 {
				cline = cline[:semi]
			}
			size, err := strconv.ParseInt(string(bytes.TrimSpace(cline)), 16, 64)
			if err != nil || size < 0 {
				return nil, nil, false, errBadRequest
			}
			if size == 0 {
				// Trailers until a blank line.
				for {
					tline, err := readLine(br, *lineBuf)
					if err != nil {
						return nil, nil, false, err
					}
					*lineBuf = tline
					if len(tline) == 0 {
						break
					}
				}
				break
			}
			start := len(body)
			body = append(body, make([]byte, size)...)
			if _, err := io.ReadFull(br, body[start:]); err != nil {
				return nil, nil, false, err
			}
			// Trailing CRLF after the chunk.
			if _, err := readLine(br, *lineBuf); err != nil {
				return nil, nil, false, err
			}
		}
	} else if contentLength > 0 {
		start := len(body)
		body = append(body, make([]byte, contentLength)...)
		if _, err := io.ReadFull(br, body[start:]); err != nil {
			return nil, nil, false, err
		}
	}
	*bodyBuf = body
	host := ""
	if h := hdr["Host"]; len(h) > 0 {
		host = h[0]
	}
	req := &http.Request{
		Method:        method,
		URL:           u,
		Header:        hdr,
		Body:          io.NopCloser(bytes.NewReader(body)),
		Host:          host,
		RemoteAddr:    c.RemoteAddr().String(),
		RequestURI:    target,
		Proto:         version,
		ProtoMajor:    1,
		ProtoMinor:    1,
		ContentLength: int64(len(body)),
	}
	if version == "HTTP/1.0" {
		req.ProtoMinor = 0
	}
	return req, body, closeAfter, nil
}

var errBadRequest = fmt.Errorf("bad request")

// rawResponseWriter buffers a whole response (headers + body) so the
// transport can send it in a single write syscall.
type rawResponseWriter struct {
	header http.Header
	status int
	body   []byte
}

func (w *rawResponseWriter) reset() {
	for k := range w.header {
		delete(w.header, k)
	}
	w.status = 0
	w.body = w.body[:0]
}

func (w *rawResponseWriter) Header() http.Header { return w.header }

func (w *rawResponseWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
}

func (w *rawResponseWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.body = append(w.body, b...)
	return len(b), nil
}

// writeResponse serializes the buffered response into out (reused across
// requests on the connection) and sends it in one write.
func (rs *rawServer) writeResponse(c net.Conn, rw *rawResponseWriter, out *[]byte, closeAfter bool) {
	status := rw.status
	if status == 0 {
		status = http.StatusOK
	}
	buf := (*out)[:0]
	buf = append(buf, "HTTP/1.1 "...)
	buf = strconv.AppendInt(buf, int64(status), 10)
	buf = append(buf, ' ')
	buf = append(buf, http.StatusText(status)...)
	buf = append(buf, "\r\n"...)

	// Headers, sorted for determinism (net/http also sorts).
	keys := make([]string, 0, len(rw.header)+3)
	for k := range rw.header {
		keys = append(keys, k)
	}
	sortStrings(keys)
	hasDate := false
	hasLength := false
	for _, k := range keys {
		if k == "Date" {
			hasDate = true
		}
		if k == "Content-Length" {
			hasLength = true
		}
		for _, v := range rw.header[k] {
			buf = append(buf, k...)
			buf = append(buf, ": "...)
			buf = append(buf, v...)
			buf = append(buf, "\r\n"...)
		}
	}
	if !hasDate {
		buf = append(buf, "Date: "...)
		buf = append(buf, rs.date()...)
		buf = append(buf, "\r\n"...)
	}
	if !hasLength {
		buf = append(buf, "Content-Length: "...)
		buf = strconv.AppendInt(buf, int64(len(rw.body)), 10)
		buf = append(buf, "\r\n"...)
	}
	if closeAfter {
		buf = append(buf, "Connection: close\r\n"...)
	} else {
		buf = append(buf, "Connection: keep-alive\r\n"...)
	}
	buf = append(buf, "\r\n"...)
	buf = append(buf, rw.body...)
	*out = buf
	_, _ = c.Write(buf)
}

// sortStrings is a tiny insertion sort for the handful of header keys.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
