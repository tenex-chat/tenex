package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fiatjaf/khatru"
)

type relayConnectionLogger struct {
	logPath string
	counter atomic.Uint64

	stateMu sync.Mutex
	states  map[*khatru.WebSocket]connectionState

	writeMu sync.Mutex
}

type connectionState struct {
	ID        string
	StartedAt time.Time
	Meta      connectionMeta
}

func newRelayConnectionLogger(config *Config) *relayConnectionLogger {
	return &relayConnectionLogger{
		logPath: relayConnectionLogPath(config),
		states:  make(map[*khatru.WebSocket]connectionState),
	}
}

func relayConnectionLogPath(config *Config) string {
	relayDir := filepath.Dir(config.DataDir)
	if relayDir == "." || relayDir == string(filepath.Separator) {
		relayDir = config.DataDir
	}
	return filepath.Join(relayDir, "connections.log")
}

func (l *relayConnectionLogger) OnConnect(ctx context.Context) {
	ws := khatru.GetConnection(ctx)
	if ws == nil || ws.Request == nil {
		return
	}

	startedAt := time.Now().UTC()
	id := fmt.Sprintf("%d-%d", os.Getpid(), l.counter.Add(1))
	meta := connectionLogMeta(ws.Request)

	l.stateMu.Lock()
	l.states[ws] = connectionState{
		ID:        id,
		StartedAt: startedAt,
		Meta:      meta,
	}
	l.stateMu.Unlock()

	l.write("connect", id, startedAt, 0, meta)
}

func (l *relayConnectionLogger) OnDisconnect(ctx context.Context) {
	ws := khatru.GetConnection(ctx)
	if ws == nil {
		return
	}

	l.stateMu.Lock()
	state, ok := l.states[ws]
	if ok {
		delete(l.states, ws)
	}
	l.stateMu.Unlock()

	if !ok {
		return
	}

	l.write("disconnect", state.ID, time.Now().UTC(), time.Since(state.StartedAt), state.Meta)
}

type connectionMeta struct {
	IP            string
	RemoteAddr    string
	XForwardedFor string
	XRealIP       string
	UserAgent     string
	Origin        string
	Path          string
	Protocol      string
}

func connectionLogMeta(req *http.Request) connectionMeta {
	xRealIP := strings.TrimSpace(req.Header.Get("X-Real-IP"))
	xForwardedFor := strings.TrimSpace(req.Header.Get("X-Forwarded-For"))

	ip := xRealIP
	if ip == "" && xForwardedFor != "" {
		ip = strings.TrimSpace(strings.Split(xForwardedFor, ",")[0])
	}
	if ip == "" {
		host, _, err := net.SplitHostPort(req.RemoteAddr)
		if err == nil {
			ip = host
		} else {
			ip = req.RemoteAddr
		}
	}

	return connectionMeta{
		IP:            ip,
		RemoteAddr:    req.RemoteAddr,
		XForwardedFor: xForwardedFor,
		XRealIP:       xRealIP,
		UserAgent:     req.UserAgent(),
		Origin:        req.Header.Get("Origin"),
		Path:          req.URL.RequestURI(),
		Protocol:      req.Proto,
	}
}

func (l *relayConnectionLogger) write(event string, id string, at time.Time, duration time.Duration, meta connectionMeta) {
	entry := map[string]any{
		"time":            at.Format(time.RFC3339Nano),
		"event":           event,
		"connection_id":   id,
		"ip":              meta.IP,
		"remote_addr":     meta.RemoteAddr,
		"x_forwarded_for": meta.XForwardedFor,
		"x_real_ip":       meta.XRealIP,
		"user_agent":      meta.UserAgent,
		"origin":          meta.Origin,
		"path":            meta.Path,
		"protocol":        meta.Protocol,
	}
	if duration > 0 {
		entry["duration_ms"] = duration.Milliseconds()
	}

	line, err := json.Marshal(entry)
	if err != nil {
		log.Printf("[connections] failed to marshal %s log: %v", event, err)
		return
	}

	l.writeMu.Lock()
	defer l.writeMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(l.logPath), 0755); err != nil {
		log.Printf("[connections] failed to create log dir for %s: %v", l.logPath, err)
		return
	}
	file, err := os.OpenFile(l.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("[connections] failed to open %s: %v", l.logPath, err)
		return
	}
	defer file.Close()

	if _, err := file.Write(append(line, '\n')); err != nil {
		log.Printf("[connections] failed to write %s: %v", l.logPath, err)
	}
}
