// Package main is the sandbox exec daemon for a browser-session machine.
//
// This file holds everything that is platform-neutral on purpose: request
// validation, the bearer check and the output cap are the parts worth testing,
// and they have to compile on a developer's machine, not only on Linux. Every
// syscall-bearing piece lives in main.go behind a build tag.
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	// The body crosses a trust boundary and the whole request is already in
	// memory once it is read. 64 KiB is the same ceiling arachnefly enforces
	// before it forwards, so a request that reaches here has already passed it.
	maxBodyBytes = 64 * 1024

	// A command line, not a script. Anything larger is not a command.
	maxArgs = 64

	defaultTimeoutSeconds = 10
	minTimeoutSeconds     = 1
	maxTimeoutSeconds     = 30

	// stdout and stderr are held in memory to be returned, so they need a
	// ceiling of their own: `yes` alone would fill a machine's RAM otherwise.
	// Truncation is reported rather than silent — a caller that cannot tell a
	// truncated answer from a complete one will trust a wrong one.
	maxOutputBytes = 256 * 1024

	// What a command may be fed. Smaller than maxBodyBytes on purpose: base64
	// inflates by 4/3 and the argv and JSON framing share the same 64 KiB, so a
	// payload at this ceiling still fits the body a caller is allowed to send.
	maxStdinBytes = 40 * 1024
)

// execRequest is the accepted body. `command` is an argv, never a string: a
// string would need a shell to interpret it, and a shell is the whole thing this
// daemon exists to avoid.
//
// `stdin_b64` is the only way to hand a command its input, because there is no
// shell to pipe through and no writable path the caller controls. Base64 rather
// than a plain string because JSON cannot carry arbitrary bytes: a PDF or an
// image would arrive mangled and fail somewhere inside the command instead of
// here.
type execRequest struct {
	Command  []string `json:"command"`
	Timeout  int      `json:"timeout"`
	StdinB64 string   `json:"stdin_b64"`

	// Stdin is the decoded payload; wire field above, this one is what run()
	// reads, so the decode happens once, in the tested file.
	Stdin []byte `json:"-"`
}

// execResult is the answer. A command that RAN is a success whatever it
// returned, so the exit code travels in the body and the HTTP status stays 200 —
// the caller distinguishes "failed" from "never ran" by the status alone.
type execResult struct {
	ExitCode  int    `json:"exit_code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
}

// parseExecRequest validates a body or says why it cannot be run.
//
// A NUL byte is refused rather than passed on: execve takes NUL-terminated
// strings, so an embedded NUL silently truncates the argument the kernel
// receives — a command the caller did not write, executed on their behalf.
func parseExecRequest(raw []byte) (execRequest, error) {
	var req execRequest
	if len(raw) == 0 {
		return req, errors.New("empty body")
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return req, errors.New("body is not a JSON object with a command")
	}

	if len(req.Command) == 0 {
		return req, errors.New("command is required")
	}
	if len(req.Command) > maxArgs {
		return req, fmt.Errorf("command has more than %d arguments", maxArgs)
	}
	if strings.TrimSpace(req.Command[0]) == "" {
		return req, errors.New("command[0] is empty")
	}
	for _, arg := range req.Command {
		if strings.ContainsRune(arg, 0) {
			return req, errors.New("command arguments may not contain NUL bytes")
		}
	}

	decoded, err := decodeStdin(req.StdinB64)
	if err != nil {
		return req, err
	}
	req.Stdin = decoded

	req.Timeout = clampTimeout(req.Timeout)
	return req, nil
}

// decodeStdin turns the optional base64 payload into the bytes the command reads.
//
// The length is checked BEFORE decoding so a hostile body cannot make this
// allocate four times its allowance, and again after, because the encoded length
// only bounds the decoded one approximately.
func decodeStdin(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, nil
	}

	if len(encoded) > maxStdinBytes*4/3+8 {
		return nil, fmt.Errorf("stdin is larger than %d bytes", maxStdinBytes)
	}

	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("stdin_b64 is not valid base64")
	}
	if len(data) > maxStdinBytes {
		return nil, fmt.Errorf("stdin is larger than %d bytes", maxStdinBytes)
	}

	return data, nil
}

// clampTimeout keeps a caller's timeout inside the range the sandbox can honour.
// Zero or negative means "unset" rather than "no limit": a request that omitted
// the field must not become a command with no deadline.
func clampTimeout(seconds int) int {
	switch {
	case seconds <= 0:
		return defaultTimeoutSeconds
	case seconds < minTimeoutSeconds:
		return minTimeoutSeconds
	case seconds > maxTimeoutSeconds:
		return maxTimeoutSeconds
	default:
		return seconds
	}
}

// bearerOK compares the presented credential in constant time.
//
// `==` on a secret leaks its prefix through timing, and this daemon is the only
// thing standing between a bearer token and a shell.
func bearerOK(header, token string) bool {
	const prefix = "Bearer "
	if token == "" || !strings.HasPrefix(header, prefix) {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, prefix)), []byte(token)) == 1
}

// capWriter collects output up to a limit and records whether it had to stop.
type capWriter struct {
	limit     int
	buf       []byte
	truncated bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.limit - len(w.buf)
	if room <= 0 {
		w.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		w.buf = append(w.buf, p[:room]...)
		w.truncated = true
		return len(p), nil
	}

	w.buf = append(w.buf, p...)
	return len(p), nil
}

func (w *capWriter) String() string { return string(w.buf) }
