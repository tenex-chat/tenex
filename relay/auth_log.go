package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

type AuthLogger struct {
	logPath string
	mu      sync.Mutex
}

func newAuthLogger(config *Config) *AuthLogger {
	relayDir := filepath.Dir(config.DataDir)
	if relayDir == "." || relayDir == string(filepath.Separator) {
		relayDir = config.DataDir
	}
	return &AuthLogger{logPath: filepath.Join(relayDir, "auth.log")}
}

// LogREQRejected records a subscription that was rejected because the client
// was not authenticated.
func (l *AuthLogger) LogREQRejected(ctx context.Context, filter nostr.Filter) {
	ws := khatru.GetConnection(ctx)
	entry := map[string]any{
		"time":   time.Now().UTC().Format(time.RFC3339Nano),
		"event":  "req_rejected",
		"reason": "auth-required",
		"sub_id": khatru.GetSubscriptionID(ctx),
		"ip":     clientIP(ws),
	}
	if len(filter.Kinds) > 0 {
		entry["kinds"] = filter.Kinds
	}
	l.write(entry)
}

// LogEventWithheld records a single event that was not delivered to a viewer.
// delivery is either "historical" (query results) or "broadcast" (live).
func (l *AuthLogger) LogEventWithheld(viewer string, event *nostr.Event, delivery string) {
	l.write(map[string]any{
		"time":         time.Now().UTC().Format(time.RFC3339Nano),
		"event":        "event_withheld",
		"delivery":     delivery,
		"viewer":       viewer,
		"event_id":     event.ID,
		"event_kind":   event.Kind,
		"event_pubkey": event.PubKey,
	})
}

func (l *AuthLogger) write(entry map[string]any) {
	line, err := json.Marshal(entry)
	if err != nil {
		log.Printf("[auth] failed to marshal log entry: %v", err)
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(l.logPath), 0755); err != nil {
		log.Printf("[auth] failed to create log dir: %v", err)
		return
	}
	file, err := os.OpenFile(l.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("[auth] failed to open %s: %v", l.logPath, err)
		return
	}
	defer file.Close()

	if _, err := file.Write(append(line, '\n')); err != nil {
		log.Printf("[auth] failed to write %s: %v", l.logPath, err)
	}
}

func clientIP(ws *khatru.WebSocket) string {
	if ws == nil || ws.Request == nil {
		return ""
	}
	return extractIP(ws.Request)
}

func extractIP(req *http.Request) string {
	if v := strings.TrimSpace(req.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	if v := strings.TrimSpace(req.Header.Get("X-Forwarded-For")); v != "" {
		return strings.TrimSpace(strings.SplitN(v, ",", 2)[0])
	}
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err == nil {
		return host
	}
	return req.RemoteAddr
}
