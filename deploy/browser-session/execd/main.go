//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// 9224 is obscura's CDP endpoint — see entrypoint.sh — so the next free
	// loopback port after webrain's 9223 is taken by the browser, not by us.
	listenAddr = "127.0.0.1:9225"

	// A numeric uid with no passwd entry: this base ships no `useradd`, and
	// syscall.Credential needs neither a passwd entry nor a package.
	sandboxUID = 10001
	sandboxGID = 10001

	workDir = "/work"

	// RLIMIT_AS. Generous for a shell, small enough that a runaway allocation
	// fails inside the sandbox instead of taking the browser down with it.
	memoryLimitBytes = 512 * 1024 * 1024
)

func main() {
	token := os.Getenv("WEBRAIN_HTTP_TOKEN")
	if token == "" {
		log.Fatal("execd: WEBRAIN_HTTP_TOKEN is not set — refusing to expose a shell unauthenticated")
	}

	// Refused at startup rather than per request: a missing working directory
	// would make every command fail with a message about the command, not about
	// the machine, and that reads as a broken feature instead of a broken image.
	if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
		log.Fatalf("execd: %s is missing; the image must create it for uid %d", workDir, sandboxUID)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/exec", func(w http.ResponseWriter, r *http.Request) {
		handleExec(w, r, token)
	})

	server := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("execd: listening on %s, cwd %s, uid %d", listenAddr, workDir, sandboxUID)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("execd: %v", err)
	}
}

func handleExec(w http.ResponseWriter, r *http.Request, token string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}

	if !bearerOK(r.Header.Get("Authorization"), token) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "payload too large"})
		return
	}

	request, err := parseExecRequest(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, run(r.Context(), request))
}

// run executes one argv and reports what happened.
func run(parent context.Context, request execRequest) execResult {
	ctx, cancel := context.WithTimeout(parent, time.Duration(request.Timeout)*time.Second)
	defer cancel()

	// `prlimit` is the launcher because Go's SysProcAttr cannot set rlimits, and
	// this daemon must not fork through a shell to get them. util-linux's prlimit
	// lowers its own limits and then execs the command, which an unprivileged user
	// may do because lowering never needs a capability.
	args := append(prlimitArgs(request.Timeout), request.Command...)

	command := exec.CommandContext(ctx, "prlimit", args...)
	command.Dir = workDir
	command.Env = sandboxEnv()
	command.SysProcAttr = sandboxSysProcAttr()

	// Only when there is something to feed: a reader over an empty slice would
	// still hand the child a pipe instead of the null device, and a command that
	// reads stdin (a REPL, `sort` without arguments) would then wait for input
	// that will never come, burning its whole deadline instead of failing fast.
	if len(request.Stdin) > 0 {
		command.Stdin = bytes.NewReader(request.Stdin)
	}

	stdout := &capWriter{limit: maxOutputBytes}
	stderr := &capWriter{limit: maxOutputBytes}
	command.Stdout = stdout
	command.Stderr = stderr

	// A command can fork, and killing only the direct child would leave its
	// children running inside a sandbox nobody is watching. The process group is
	// killed instead, which is why Setpgid is set below.
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
	command.WaitDelay = 2 * time.Second

	err := command.Run()

	result := execResult{
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		Truncated: stdout.truncated || stderr.truncated,
	}

	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		result.ExitCode = -1
		result.Stderr = strings.TrimSpace(
			result.Stderr + "\ntimed out after " + strconv.Itoa(request.Timeout) + "s")
	case err != nil:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
			result.Stderr = strings.TrimSpace(result.Stderr + "\n" + err.Error())
		}
	}

	return result
}

// prlimitArgs are the limits applied to every command.
func prlimitArgs(cpuSeconds int) []string {
	return []string{
		fmt.Sprintf("--as=%d", memoryLimitBytes),
		"--nproc=64",
		"--nofile=256",
		fmt.Sprintf("--cpu=%d", cpuSeconds+1),
		"--",
	}
}

// sandboxEnv is a SCRUBBED environment.
//
// It does not inherit: this process holds WEBRAIN_HTTP_TOKEN, and an inherited
// environment would hand a tenant's command the credential that authenticates
// the machine.
func sandboxEnv() []string {
	return []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + workDir,
		"LANG=C.UTF-8",
	}
}

// sandboxSysProcAttr drops the child to a uid that owns nothing but /work, and
// gives it a network namespace with no interfaces.
//
// The namespace is the load-bearing part. This image carries perl, openssl,
// webrain and chromium — each reaches any host in a single command — so an
// egress ALLOWLIST is not something that can exist here; removing the network
// entirely is. CLONE_NEWNET needs CAP_SYS_ADMIN at fork, which this process has
// because a Fly machine runs the image as the microVM's own root rather than as
// a nested container with a dropped capability set.
func sandboxSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: sandboxUID, Gid: sandboxGID},
		Setpgid:    true,
		Cloneflags: syscall.CLONE_NEWNET,
	}
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	// A command's output is a snapshot of one moment and may contain anything.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("execd: writing response failed: %v", err)
	}
}
