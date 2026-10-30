package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

// TestParseExecRequest pins the refusals and the timeout clamp.
//
// The clamp matters as much as the refusals: an omitted `timeout` used to be a
// zero, and a zero deadline is a command with no end — the one state a sandbox
// must never reach.
func TestParseExecRequest(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		wantErr     string
		wantTimeout int
	}{
		{name: "a plain argv is accepted", body: `{"command":["ls","-l","/work"]}`, wantTimeout: defaultTimeoutSeconds},
		{name: "an explicit timeout is kept", body: `{"command":["sleep","1"],"timeout":5}`, wantTimeout: 5},
		{name: "a timeout above the ceiling is clamped", body: `{"command":["a"],"timeout":900}`, wantTimeout: maxTimeoutSeconds},
		{name: "a negative timeout falls back to the default", body: `{"command":["a"],"timeout":-4}`, wantTimeout: defaultTimeoutSeconds},
		{name: "a zero timeout falls back to the default", body: `{"command":["a"],"timeout":0}`, wantTimeout: defaultTimeoutSeconds},
		{name: "an empty body is refused", body: ``, wantErr: "empty body"},
		{name: "a body that is not JSON is refused", body: `command=ls`, wantErr: "not a JSON object"},
		{name: "a missing command is refused", body: `{}`, wantErr: "command is required"},
		{name: "an empty argv is refused", body: `{"command":[]}`, wantErr: "command is required"},
		{name: "a blank argv[0] is refused", body: `{"command":["  "]}`, wantErr: "command[0] is empty"},
		{
			// execve stops at the first NUL, so this would run `sh` with a shorter
			// argument list than the caller wrote.
			name:    "a NUL inside an argument is refused",
			body:    `{"command":["sh","-c\u0000; rm -rf /"]}`,
			wantErr: "NUL bytes",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := parseExecRequest([]byte(tt.body))

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected an error containing %q, got none", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if req.Timeout != tt.wantTimeout {
				t.Fatalf("timeout = %d, want %d", req.Timeout, tt.wantTimeout)
			}
		})
	}
}

// TestBearerOK: the daemon is the only thing between a token and a shell, so the
// negative cases are the ones that matter.
func TestBearerOK(t *testing.T) {
	const token = "machine-token"

	if !bearerOK("Bearer "+token, token) {
		t.Fatal("a matching bearer should be accepted")
	}
	for _, header := range []string{"", "machine-token", "Bearer ", "Bearer wrong", "bearer " + token} {
		if bearerOK(header, token) {
			t.Fatalf("header %q should be refused", header)
		}
	}
	// An unset token must never authenticate, even against an empty header, or a
	// misconfigured machine becomes an open shell on loopback.
	if bearerOK("Bearer ", "") {
		t.Fatal("an empty configured token must never authenticate")
	}
}

// TestCapWriterTruncates: a caller that cannot tell a cut answer from a complete
// one will trust a wrong one.
func TestCapWriterTruncates(t *testing.T) {
	w := &capWriter{limit: 8}

	if _, err := w.Write([]byte("abcdefgh")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if w.truncated {
		t.Fatal("exactly filling the limit is not truncation")
	}

	if _, err := w.Write([]byte("ij")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !w.truncated {
		t.Fatal("writing past the limit must set truncated")
	}
	if w.String() != "abcdefgh" {
		t.Fatalf("buffer = %q, want the first 8 bytes", w.String())
	}

	partial := &capWriter{limit: 4}
	if _, err := partial.Write([]byte("abcdef")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if partial.String() != "abcd" || !partial.truncated {
		t.Fatalf("buffer = %q truncated = %v, want %q and true", partial.String(), partial.truncated, "abcd")
	}
}

// TestParseExecRequestStdin pins the payload channel: bytes survive the round
// trip unchanged, and a body that cannot be decoded is refused here rather than
// handed to a command as garbage.
func TestParseExecRequestStdin(t *testing.T) {
	// Bytes no JSON string can carry directly, which is the whole reason the
	// field is base64.
	original := []byte{0x00, 0xff, 0x10, '\n', 0x7f, 0x80}
	encoded := base64.StdEncoding.EncodeToString(original)

	req, err := parseExecRequest([]byte(`{"command":["cat"],"stdin_b64":"` + encoded + `"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(req.Stdin) != string(original) {
		t.Fatalf("stdin = %v, want %v", req.Stdin, original)
	}

	req, err = parseExecRequest([]byte(`{"command":["cat"]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Stdin != nil {
		t.Fatalf("stdin = %v, want nil when the field is absent", req.Stdin)
	}

	if _, err := parseExecRequest([]byte(`{"command":["cat"],"stdin_b64":"not base64!!"}`)); err == nil ||
		!strings.Contains(err.Error(), "not valid base64") {
		t.Fatalf("expected a base64 refusal, got %v", err)
	}

	// One byte over the ceiling, encoded: refused before it is decoded.
	over := base64.StdEncoding.EncodeToString(make([]byte, maxStdinBytes+1))
	if _, err := parseExecRequest([]byte(`{"command":["cat"],"stdin_b64":"` + over + `"}`)); err == nil ||
		!strings.Contains(err.Error(), "larger than") {
		t.Fatalf("expected a size refusal, got %v", err)
	}
}
