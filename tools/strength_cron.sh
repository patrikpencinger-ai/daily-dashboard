#!/bin/bash
# strength_cron.sh - strength pipeline for the Mac mini, run by launchd every 30 min
# (tools/launchd/com.dash.strength-pipeline.plist). bash 3.2 / Python 3.9 compatible.
#
#   lock check -> git pull --ff-only -> hevy_fetch --days 3 -> strava_sync fetch-hr --days 3
#   -> build_strength.py -> commit + push strength-data.json / training-data.json (volWork)
#   ONLY if their content changed (meta.refreshedAt alone does not count) -> heartbeat.
#
# Skips (exit 0) while the morning routine runs: ~/.claude/cache/daily-dashboard/routine.lock
# younger than 90 min (the routine creates it at start and deletes it at the end; an older
# lock is treated as stale and ignored).
#
# Exit codes
#   0  ok: ran (changed or not), or skipped on purpose (fresh routine.lock / another run active)
#   1  a pipeline step failed (hevy_fetch / fetch-hr / build_strength); nothing is committed
#      when build_strength itself failed; fetch failures still build from the cached data
#   2  git fetch / pull --ff-only failed (not a fast-forward, conflict, network): aborted
#   3  commit / push failed, or origin/main != HEAD after the push
#   4  setup problem: repo or python3 missing, unexpected local commits, or
#      strength-data.json / training-data.json dirty before the run (not ours to discard)
# A heartbeat is POSTed on every exit (HTTP errors are logged, never change the exit code).
# Env overrides (testing): DASH_REPO, ZG_CACHE, DASH_PYTHON, DASH_NO_PUSH=1, DASH_NO_HEARTBEAT=1.
# Secrets are read from files, passed to curl via stdin, never printed or logged.

set -u
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:${PATH:-}"
export PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1 PYTHONIOENCODING=utf-8
export GIT_TERMINAL_PROMPT=0

REPO="${DASH_REPO:-$HOME/daily-dashboard}"
CACHE="${ZG_CACHE:-$HOME/.claude/cache/daily-dashboard}"
PY="${DASH_PYTHON:-python3}"
LOGDIR="$CACHE/strength"
LOG="$LOGDIR/cron.log"
ROUTINE_LOCK="$CACHE/routine.lock"
RUN_LOCK="$LOGDIR/cron.run.lock"      # directory; guards against overlapping cron runs
HOOK_URL="https://hevy.er45.com/live/pipeline"
WEBHOOK_FILE="$CACHE/secrets/hevy-webhook.txt"
LOCK_MAX_AGE_S=$((90 * 60))
RUN_LOCK_MAX_AGE_S=$((60 * 60))
LOG_MAX_BYTES=1048576

START_EPOCH=$(date +%s)
RAN_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date '+%Y-%m-%d %H:%M')
CHANGED=false
COMMIT=""
ERRS=""
HAVE_RUN_LOCK=0

mkdir -p "$LOGDIR" 2>/dev/null

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  printf '%s\n' "$line" >> "$LOG"
  if [ -t 1 ]; then printf '%s\n' "$line"; fi
}

add_err() {
  if [ -z "$ERRS" ]; then ERRS="$1"; else ERRS="$ERRS"$'\n'"$1"; fi
  log "ERROR: $1"
}

file_age_s() {   # seconds since mtime of $1 (macOS stat, GNU fallback)
  local m
  m=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo "$START_EPOCH")
  echo $(( $(date +%s) - m ))
}

rotate_log() {
  local size
  size=$(stat -f %z "$LOG" 2>/dev/null || stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "${size:-0}" -ge "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
    log "log rotated (previous: cron.log.1, $size bytes)"
  fi
}

heartbeat() {
  if [ "${DASH_NO_HEARTBEAT:-0}" = "1" ]; then log "heartbeat disabled"; return 0; fi
  if [ ! -s "$WEBHOOK_FILE" ]; then log "heartbeat skipped: $WEBHOOK_FILE missing"; return 0; fi
  local dur body code tok
  dur=$(( $(date +%s) - START_EPOCH ))
  body=$("$PY" -c '
import json, sys
a = sys.argv
errs = [e for e in a[5].split("\n") if e]
print(json.dumps({"host": "mac", "ranAt": a[1], "changed": a[2] == "true",
                  "commit": a[3] or None, "durationS": int(a[4]), "errors": errs}))
' "$RAN_AT" "$CHANGED" "$COMMIT" "$dur" "$ERRS" 2>/dev/null)
  if [ -z "$body" ]; then log "heartbeat skipped: could not build JSON"; return 0; fi
  tok=$(tr -d '[:space:]' < "$WEBHOOK_FILE")
  code=$(printf 'header = "Authorization: %s"\n' "$tok" | curl -sS -m 20 -o /dev/null -w '%{http_code}' \
         -K - -X POST -H 'Content-Type: application/json' --data-binary "$body" "$HOOK_URL" 2>>"$LOG") || true
  tok=""
  log "heartbeat POST $HOOK_URL -> HTTP ${code:-000}"
}

finish() {   # finish <exit code>
  local rc=$1
  if [ "$HAVE_RUN_LOCK" = "1" ]; then rmdir "$RUN_LOCK" 2>/dev/null; fi
  log "done rc=$rc changed=$CHANGED commit=${COMMIT:-none} durationS=$(( $(date +%s) - START_EPOCH ))"
  heartbeat
  exit "$rc"
}

run_step() {   # run_step <label> <cmd...>; output (counts only) goes to the log
  local label=$1; shift
  log "step $label: $*"
  "$@" >> "$LOG" 2>&1
  local rc=$?
  log "step $label: exit $rc"
  return $rc
}

# Everything below lives in main() so bash parses the whole script before running it:
# 'git pull' may replace this very file while it executes.
adopt_identical() {   # drop local copies that are byte-identical to origin's version so the pull can proceed
  local f
  for f in $(git diff --name-only HEAD origin/main 2>/dev/null); do
    [ -f "$f" ] || continue
    if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
      git diff --quiet -- "$f" && continue
    fi
    if [ "$(git hash-object -- "$f")" = "$(git rev-parse "origin/main:$f" 2>/dev/null)" ]; then
      log "local $f is identical to origin/main: adopting origin's copy"
      if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then git checkout -q -- "$f"; else rm -f -- "$f"; fi
    fi
  done
}

main() {
  rotate_log
  log "---- start ($STAMP) repo=$REPO"

  # --- routine lock -----------------------------------------------------------
  if [ -e "$ROUTINE_LOCK" ]; then
    age=$(file_age_s "$ROUTINE_LOCK")
    if [ "$age" -lt "$LOCK_MAX_AGE_S" ]; then
      log "skip: routine.lock is ${age}s old (< ${LOCK_MAX_AGE_S}s), morning routine is running"
      ERRS="skipped: routine.lock active (${age}s)"
      finish 0
    fi
    log "routine.lock is ${age}s old (stale, >= ${LOCK_MAX_AGE_S}s): ignoring it"
  fi

  # --- one cron run at a time --------------------------------------------------
  if ! mkdir "$RUN_LOCK" 2>/dev/null; then
    age=$(file_age_s "$RUN_LOCK")
    if [ "$age" -ge "$RUN_LOCK_MAX_AGE_S" ]; then
      log "stale cron.run.lock (${age}s): taking over"
      rmdir "$RUN_LOCK" 2>/dev/null; mkdir "$RUN_LOCK" 2>/dev/null
    else
      log "skip: another strength_cron run is active (${age}s)"
      ERRS="skipped: another run active (${age}s)"
      finish 0
    fi
  fi
  HAVE_RUN_LOCK=1

  # --- setup -------------------------------------------------------------------
  if [ ! -d "$REPO/.git" ]; then add_err "repo not found: $REPO"; finish 4; fi
  if ! command -v "$PY" >/dev/null 2>&1; then add_err "python not found: $PY"; finish 4; fi
  cd "$REPO" || { add_err "cannot cd $REPO"; finish 4; }

  # --- sync with origin (fast-forward only) -------------------------------------
  if ! git fetch -q origin main >> "$LOG" 2>&1; then add_err "git fetch failed"; finish 2; fi

  # Our own earlier commit that never reached origin (push raced/failed): drop it, it is rebuilt below.
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  if [ "$AHEAD" != "0" ]; then
    if [ -z "$(git log --format=%s origin/main..HEAD | grep -v '^strength: ')" ]; then
      log "dropping $AHEAD unpushed 'strength:' commit(s): git reset --keep origin/main"
      git reset -q --keep origin/main >> "$LOG" 2>&1 || { add_err "could not drop unpushed strength commit"; finish 4; }
    else
      add_err "unexpected local commits ahead of origin/main ($AHEAD)"; finish 4
    fi
  fi

  # Generated files must be clean: whatever is dirty there is not ours to discard.
  if [ -n "$(git status --porcelain -- strength-data.json training-data.json)" ]; then
    add_err "strength-data.json / training-data.json have uncommitted changes before the run"; finish 4
  fi

  adopt_identical
  if ! git pull --ff-only -q >> "$LOG" 2>&1; then
    add_err "git pull --ff-only failed (not a fast-forward or conflict)"; finish 2
  fi
  log "pulled: HEAD=$(git rev-parse --short HEAD)"

  # --- pipeline ----------------------------------------------------------------
  RC=0
  run_step hevy_fetch "$PY" tools/hevy_fetch.py --days 3
  r=$?; if [ $r -ne 0 ]; then add_err "hevy_fetch exit $r"; RC=1; fi
  run_step fetch-hr "$PY" tools/strava_sync.py fetch-hr --days 3
  r=$?; if [ $r -ne 0 ]; then add_err "fetch-hr exit $r"; RC=1; fi
  run_step build_strength "$PY" tools/build_strength.py
  r=$?
  if [ $r -ne 0 ]; then
    add_err "build_strength exit $r"
    git checkout -q -- strength-data.json training-data.json 2>/dev/null
    COMMIT=$(git rev-parse --short HEAD)
    finish 1
  fi

  # --- changed? (strength-data.json: ignore meta.refreshedAt, it moves on every run) ---
  STRENGTH_SAME=$("$PY" -c '
import json, subprocess
try:
    old = json.loads(subprocess.check_output(["git", "show", "HEAD:strength-data.json"]))
    new = json.load(open("strength-data.json", encoding="utf-8"))
    for d in (old, new):
        d.get("meta", {}).pop("refreshedAt", None)
    print("same" if old == new else "diff")
except Exception:
    print("diff")
  ' 2>>"$LOG")
  TO_ADD=""
  if [ "$STRENGTH_SAME" = "same" ]; then
    git checkout -q -- strength-data.json            # only refreshedAt moved: keep the tree clean
  else
    TO_ADD="strength-data.json"
  fi
  if [ -n "$(git status --porcelain -- training-data.json)" ]; then
    TO_ADD="$TO_ADD training-data.json"
  fi

  COMMIT=$(git rev-parse --short HEAD)
  if [ -z "$TO_ADD" ]; then
    log "no content change: nothing to commit"
    finish $RC
  fi

  # --- commit + push -------------------------------------------------------------
  log "changed:$( [ -n "$TO_ADD" ] && echo " $TO_ADD")"
  CHANGED=true
  # word splitting is intended: TO_ADD holds file names without spaces
  git add -- $TO_ADD >> "$LOG" 2>&1
  if ! git commit -q -m "strength: $STAMP" >> "$LOG" 2>&1; then
    add_err "git commit failed"
    git reset -q >> "$LOG" 2>&1
    git checkout -q -- $TO_ADD 2>/dev/null
    CHANGED=false
    finish 3
  fi
  COMMIT=$(git rev-parse --short HEAD)

  if [ "${DASH_NO_PUSH:-0}" = "1" ]; then
    log "DASH_NO_PUSH=1: committed $COMMIT locally, not pushing"
    finish $RC
  fi

  if ! git push -q origin main >> "$LOG" 2>&1; then
    add_err "git push failed (commit $COMMIT dropped locally, rebuilt next run)"
    git fetch -q origin main >> "$LOG" 2>&1 && git reset -q --keep origin/main >> "$LOG" 2>&1
    CHANGED=false
    COMMIT=$(git rev-parse --short HEAD)
    finish 3
  fi
  REMOTE=$(git ls-remote origin refs/heads/main 2>>"$LOG" | cut -f1)
  LOCAL=$(git rev-parse HEAD)
  if [ "$REMOTE" != "$LOCAL" ]; then
    add_err "origin/main (${REMOTE:0:7}) != HEAD (${LOCAL:0:7}) after push"
    finish 3
  fi
  log "pushed $COMMIT, origin/main == HEAD"
  finish $RC
}

main "$@"
exit $?
