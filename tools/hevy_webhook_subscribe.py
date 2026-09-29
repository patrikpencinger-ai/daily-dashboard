#!/usr/bin/env python3
"""hevy_webhook_subscribe.py - connect Hevy's workout webhook to the hevy-hook Worker.

Hevy's public API (https://api.hevyapp.com/docs, checked 2026-09-29) has NO
webhook-subscription endpoint: /v1/workouts, /workouts/count, /workouts/events,
/workouts/{id}, /user/info, /routines, /exercise_templates, /routine_folders,
/exercise_history, /body_measurements only. The webhook is set in the Hevy web
UI, so this script prints the steps (default command).

Commands
  instructions [--copy | --show]   step-by-step for the Hevy web UI (default)
                                   --copy puts the Authorization value on the clipboard
                                   --show prints it (your terminal only)
  check-api                        re-check the Hevy OpenAPI for a webhook endpoint
  test [--workout-id ID]           POST {"workoutId": ID} to <LIVE_BASE>/hook/hevy with the
                                   Authorization header (default ID: your latest Hevy workout),
                                   then show /live/health and whether the workout appears in
                                   /live/recent

LIVE_BASE defaults to https://hevy.er45.com (override: --base or env LIVE_BASE).
Secrets are read from <ZG_CACHE or ~/.claude/cache/daily-dashboard>/secrets and are
never printed unless you pass --show. Python stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("ZG_CACHE") or Path.home() / ".claude" / "cache" / "daily-dashboard")
SECRETS_DIR = CACHE_ROOT / "secrets"
HEVY_ENV = SECRETS_DIR / "hevy.env"
WEBHOOK_FILE = SECRETS_DIR / "hevy-webhook.txt"
DEFAULT_BASE = os.environ.get("LIVE_BASE") or "https://hevy.er45.com"
HEVY_API = "https://api.hevyapp.com/v1"
DOCS_INIT = "https://api.hevyapp.com/docs/swagger-ui-init.js"
UA = "daily-dashboard-hevy-webhook/1.0"


def read_webhook_auth() -> str:
    if not WEBHOOK_FILE.exists():
        raise SystemExit(f"missing {WEBHOOK_FILE} - it holds the random WEBHOOK_AUTH value")
    v = WEBHOOK_FILE.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", v):
        raise SystemExit(f"{WEBHOOK_FILE} does not contain 64 hex characters")
    return v


def read_hevy_key() -> str:
    if not HEVY_ENV.exists():
        raise SystemExit(f"missing {HEVY_ENV} (HEVY_API_KEY=...)")
    for line in HEVY_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("HEVY_API_KEY="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v and not v.startswith("PASTE_"):
                return v
    raise SystemExit(f"no HEVY_API_KEY in {HEVY_ENV}")


def http(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: int = 30):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def copy_to_clipboard(text: str) -> bool:
    try:
        if sys.platform.startswith("win"):
            subprocess.run(["clip"], input=text.encode("utf-16-le"), check=True)
        elif sys.platform == "darwin":
            subprocess.run(["pbcopy"], input=text.encode(), check=True)
        else:
            subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode(), check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def cmd_instructions(args) -> int:
    base = args.base.rstrip("/")
    auth = read_webhook_auth()
    copied = copy_to_clipboard(auth) if args.copy else False
    print(f"""Hevy webhook -> hevy-hook Worker ({base})

Prerequisite: the Worker secrets are set (once):
    powershell -ExecutionPolicy Bypass -File tools\\set_live_secrets.ps1
  and {base}/live/health shows "status":"ok".

In the Hevy web app (Hevy Pro):
  1. Open https://hevy.com/settings?developer  (Settings -> Developer).
  2. In the Webhooks section, add / edit the webhook:
       URL:                   {base}/hook/hevy
       Authorization header:  the 64-character value in
                              {WEBHOOK_FILE}""")
    if args.show:
        print(f"                              value: {auth}")
    elif copied:
        print("                              (copied to your clipboard - paste it)")
    else:
        print("                              (re-run with --copy to put it on the clipboard)")
    print(f"""     Paste the value exactly, without "Bearer " (the Worker accepts both forms).
  3. Save. Hevy then POSTs {{"workoutId": "..."}} after every saved workout.
  4. Verify:  python tools\\hevy_webhook_subscribe.py test
     (sends one authenticated test call for your latest workout).

Rotate the secret later: see workers\\hevy-hook\\README.md ("Rotate WEBHOOK_AUTH").""")
    return 0


def cmd_check_api(_args) -> int:
    status, text = http("GET", DOCS_INIT)
    if status != 200:
        print(f"could not load {DOCS_INIT} (HTTP {status})")
        return 1
    paths = sorted(set(re.findall(r'"(/v1/[^"]+)"\s*:\s*\{', text)))
    hooks = [p for p in paths if "hook" in p.lower() or "subscri" in p.lower()]
    print(f"Hevy API paths ({len(paths)}): " + ", ".join(paths))
    if hooks:
        print("Webhook-related endpoints now exist: " + ", ".join(hooks)
              + "\n-> this script could automate the subscription; update it.")
    else:
        print("No webhook-subscription endpoint -> use the web UI (run without arguments).")
    return 0


def cmd_test(args) -> int:
    base = args.base.rstrip("/")
    auth = read_webhook_auth()
    wid = args.workout_id
    if not wid:
        status, text = http("GET", f"{HEVY_API}/workouts?page=1&pageSize=1",
                            {"api-key": read_hevy_key(), "Accept": "application/json"})
        if status != 200:
            print(f"Hevy /workouts failed (HTTP {status}); pass --workout-id")
            return 1
        ws = json.loads(text).get("workouts") or []
        if not ws:
            print("no Hevy workouts found; pass --workout-id")
            return 1
        wid = ws[0]["id"]
        print(f"latest Hevy workout: {ws[0].get('start_time', '')[:16]} '{ws[0].get('title', '')}' ({wid})")

    status, text = http("POST", f"{base}/hook/hevy",
                        {"Authorization": auth, "Content-Type": "application/json"},
                        json.dumps({"workoutId": wid}).encode())
    print(f"POST {base}/hook/hevy -> HTTP {status} {text[:120]}")
    if status != 200:
        if status == 401:
            print("401: WEBHOOK_AUTH on the Worker differs from the local file -> run tools\\set_live_secrets.ps1")
        return 1

    print("waiting 15 s for background processing ...")
    time.sleep(15)
    _, health = http("GET", f"{base}/live/health")
    print(f"health: {health[:400]}")
    _, recent = http("GET", f"{base}/live/recent?days=14")
    try:
        items = json.loads(recent).get("workouts") or []
    except ValueError:
        items = []
    hit = next((w for w in items if w.get("id") == wid), None)
    if hit:
        print(f"/live/recent has it: status={hit.get('status')} tonnageWork={hit.get('totals', {}).get('tonnageWork')}")
        return 0
    print("not in /live/recent yet (older than 14 days, or processing still running / queued for the cron)")
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    p = argparse.ArgumentParser(description="Connect Hevy's webhook to the hevy-hook Worker.")
    p.add_argument("--base", default=DEFAULT_BASE, help=f"LIVE_BASE (default {DEFAULT_BASE})")
    sub = p.add_subparsers(dest="cmd")
    i = sub.add_parser("instructions", help="print the Hevy web UI steps (default)")
    g = i.add_mutually_exclusive_group()
    g.add_argument("--copy", action="store_true", help="copy the Authorization value to the clipboard")
    g.add_argument("--show", action="store_true", help="print the Authorization value")
    sub.add_parser("check-api", help="re-check the Hevy API docs for a webhook endpoint")
    t = sub.add_parser("test", help="send one authenticated test webhook")
    t.add_argument("--workout-id", help="Hevy workout id (default: latest)")
    args = p.parse_args(argv)
    if args.cmd is None:
        args.cmd, args.copy, args.show = "instructions", False, False
    return {"instructions": cmd_instructions, "check-api": cmd_check_api, "test": cmd_test}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
