package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Config represents the relay configuration
type Config struct {
	Port        int          `json:"port"`
	BindAddress string       `json:"bind_address"`
	DataDir     string       `json:"data_dir"`
	NIP11       NIP11Config  `json:"nip11"`
	Limits      LimitsConfig `json:"limits"`
	Sync        SyncConfig   `json:"sync"`
}

// NIP11Config contains all NIP-11 relay information document fields
type NIP11Config struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Pubkey        string `json:"pubkey"`
	Contact       string `json:"contact"`
	SupportedNIPs []int  `json:"supported_nips"`
	Software      string `json:"software"`
	Version       string `json:"version"`
}

// LimitsConfig contains relay limits
type LimitsConfig struct {
	MaxMessageLength    int `json:"max_message_length"`
	MaxSubscriptions    int `json:"max_subscriptions"`
	MaxFilters          int `json:"max_filters"`
	MaxEventTags        int `json:"max_event_tags"`
	MaxContentLength    int `json:"max_content_length"`
	DefaultQueryLimit   int `json:"default_query_limit"`
	MaxQueryLimit       int `json:"max_query_limit"`
	MaxQueryWindowHours int `json:"max_query_window_hours"`
}

// SyncConfig contains relay sync settings
type SyncConfig struct {
	Relays []string `json:"relays"`
	Kinds  []int    `json:"kinds"`
}

func defaultDataDir() string {
	if base := os.Getenv("TENEX_BASE_DIR"); base != "" {
		return filepath.Join(base, "relay", "data")
	}
	return expandPath("~/.tenex/relay/data")
}

// DefaultConfig returns the default configuration
func DefaultConfig() *Config {
	return &Config{
		Port:        7777,
		BindAddress: "127.0.0.1",
		DataDir:     defaultDataDir(),
		NIP11: NIP11Config{
			Name:          "TENEX Local Relay",
			Description:   "Local Nostr relay for TENEX",
			Pubkey:        "",
			Contact:       "",
			SupportedNIPs: []int{1, 2, 4, 9, 11, 12, 16, 20, 22, 33, 40, 42, 77},
			Software:      "tenex-khatru-relay",
			Version:       "0.1.0",
		},
		Limits: LimitsConfig{
			MaxMessageLength:    2097152,
			MaxSubscriptions:    200,
			MaxFilters:          50,
			MaxEventTags:        8192,
			MaxContentLength:    1048576,
			DefaultQueryLimit:   100,
			MaxQueryLimit:       500,
			MaxQueryWindowHours: 168,
		},
		Sync: SyncConfig{
			Relays: []string{"wss://relay.tenex.chat"},
			Kinds:  []int{1, 4199, 14199, 4129, 4200, 4201, 4202, 34199, 30023},
		},
	}
}

// LoadConfig loads configuration from the given path
// If the file doesn't exist, it returns the default config
func LoadConfig(path string) (*Config, error) {
	path = expandPath(path)

	// Check if config file exists
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return DefaultConfig(), nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// Start with defaults and overlay loaded config
	config := DefaultConfig()
	if err := json.Unmarshal(data, config); err != nil {
		return nil, err
	}

	// Expand paths
	config.DataDir = expandPath(config.DataDir)

	// Validate
	if err := config.Validate(); err != nil {
		return nil, err
	}

	return config, nil
}

// Validate checks if the configuration is valid
func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}

	if c.DataDir == "" {
		return errors.New("data_dir cannot be empty")
	}

	if c.Limits.DefaultQueryLimit < 1 {
		return errors.New("limits.default_query_limit must be greater than 0")
	}

	if c.Limits.MaxQueryLimit < c.Limits.DefaultQueryLimit {
		return errors.New("limits.max_query_limit must be greater than or equal to limits.default_query_limit")
	}

	if c.Limits.MaxQueryWindowHours < 1 {
		return errors.New("limits.max_query_window_hours must be greater than 0")
	}

	return nil
}

// EnsureDataDir creates the data directory if it doesn't exist
func (c *Config) EnsureDataDir() error {
	return os.MkdirAll(c.DataDir, 0755)
}

// expandPath expands ~ to the user's home directory
func expandPath(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		return filepath.Join(home, path[2:])
	}
	return path
}
