#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RESTART_EXIT_CODE=75
CRASH_THRESHOLD_SECS=30
MAX_RAPID_CRASHES=3
ERROR_DIR="$HOME/.db-coder"
LOG_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOG_DIR"

# Rotate log if > 10MB
rotate_log() {
    local log_file="$1"
    local max_size=$((10 * 1024 * 1024))
    if [[ -f "$log_file" ]] && [[ $(stat -c%s "$log_file" 2>/dev/null || echo 0) -gt $max_size ]]; then
        mv "$log_file" "${log_file}.1"
    fi
}

LOG_FILE="$LOG_DIR/supervisor.log"
rotate_log "$LOG_FILE"

# Redirect all output to log file (and keep stderr for nohup.out fallback)
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
    echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S')] $*"
}

rapid_crash_count=0

cleanup() {
    local sig="${1:-UNKNOWN}"
    log "Received signal $sig, forwarding TERM to child..."
    if [[ -n "${child_pid:-}" ]] && kill -0 "$child_pid" 2>/dev/null; then
        kill -TERM "$child_pid"
        wait "$child_pid" 2>/dev/null || true
    fi
    log "Supervisor exiting (signal=$sig, pid=$$)"
    exit 0
}
trap 'cleanup SIGTERM' SIGTERM
trap 'cleanup SIGINT' SIGINT
trap 'cleanup SIGHUP' SIGHUP

log "Supervisor started (pid=$$, ppid=$PPID)"
log "Working directory: $SCRIPT_DIR"
log "Node: $(node --version 2>/dev/null || echo 'not found')"

write_startup_error() {
    local error_msg="$1"
    mkdir -p "$ERROR_DIR"
    cat > "$ERROR_DIR/startup-error.json" <<ERREOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "type": "startup",
  "error": $(printf '%s' "$error_msg" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$error_msg\"")
}
ERREOF
}

while true; do
    # Backup current dist/ before starting
    if [[ -d dist ]]; then
        rm -rf dist.bak
        cp -a dist/ dist.bak/
    fi

    log "Starting db-coder (child)..."
    start_time=$(date +%s)

    node dist/index.js serve --project . &
    child_pid=$!
    log "Child started (pid=$child_pid)"
    wait "$child_pid" 2>/dev/null
    exit_code=$?
    child_pid=""

    end_time=$(date +%s)
    run_duration=$((end_time - start_time))

    log "Child exited (code=$exit_code, duration=${run_duration}s)"

    # Exit code 75: self-build restart — no rollback needed
    if [[ $exit_code -eq $RESTART_EXIT_CODE ]]; then
        log "Self-build restart requested, restarting immediately..."
        rapid_crash_count=0
        continue
    fi

    # Exit code 0: clean shutdown (SIGTERM/Ctrl+C forwarded)
    if [[ $exit_code -eq 0 ]]; then
        log "Clean shutdown."
        exit 0
    fi

    # Crash: check if it was a rapid crash (< 30 seconds)
    if [[ $run_duration -lt $CRASH_THRESHOLD_SECS ]]; then
        rapid_crash_count=$((rapid_crash_count + 1))
        log "Rapid crash detected ($rapid_crash_count/$MAX_RAPID_CRASHES)"

        # Rollback to dist.bak/
        if [[ -d dist.bak ]]; then
            log "Rolling back to dist.bak/"
            rm -rf dist
            mv dist.bak dist
        fi

        # Write startup error file for recovery on next boot
        write_startup_error "Process crashed with exit code $exit_code after ${run_duration}s (rapid crash $rapid_crash_count/$MAX_RAPID_CRASHES)"

        if [[ $rapid_crash_count -ge $MAX_RAPID_CRASHES ]]; then
            log "Too many rapid crashes ($MAX_RAPID_CRASHES), giving up."
            exit 1
        fi

        log "Restarting in 2s..."
        sleep 2
    else
        # Normal crash (ran for a while) — no rollback, just restart
        rapid_crash_count=0
        rm -rf dist.bak
        log "Restarting in 5s..."
        sleep 5
    fi
done
