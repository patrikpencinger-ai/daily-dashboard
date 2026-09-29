#!/usr/bin/env python3
"""strava_sync.py - make Strava strength activities readable by rewriting their
name + description from the matching Hevy workout.

The Garmin fenix 8 uploads a "Weight Training" activity to Strava whose exercise
list is watch auto-detection garbage. The truth is the Hevy workout. Strava's
API cannot edit the set list, only name/description, so the description carries
the clean log.

Commands
  auth                                   one-time OAuth flow (opens browser)
  sync [--days N] [--dry-run] [--force]  rewrite name/description from Hevy
       [--hevy-source api|freddy-cache] [--via-worker | --direct]
  selftest                               offline unit test of the builder + Worker client
  fetch-hr [--days N | --since YYYY-MM-DD] [--force] [--dry-run] [--via-worker | --direct]
                                         cache 1 s HR streams of strength activities
                                         (raw/strava_hr/<local date>_<strava id>.json)

Single Strava token owner. Strava may rotate the refresh token on every refresh,
so only ONE client may refresh it: the hevy-hook Worker (KV strava:tokens).
`sync` and `fetch-hr` therefore go through the Worker by default (whenever
secrets/hevy-webhook.txt exists): GET/POST https://hevy.er45.com/live/... with
the WEBHOOK_AUTH value as the Authorization header. `--direct` talks to the
Strava API with secrets/strava.json instead - emergencies only: it makes this
machine a second token owner and can invalidate the Worker's token. After using
it, run `auth` again and then `tools/set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN`.

Python stdlib only. Secrets live OUTSIDE the repo (see SECRETS_DIR); this script
never prints them and never asks for passwords.
"""
from __future__ import annotations

import argparse
import glob
import http.server
import json
import os
import secrets as _secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants / paths
# --------------------------------------------------------------------------- #

CACHE_ROOT = Path(os.environ.get("ZG_CACHE") or Path.home() / ".claude" / "cache" / "daily-dashboard")
SECRETS_DIR = CACHE_ROOT / "secrets"
STRAVA_JSON = SECRETS_DIR / "strava.json"
HEVY_ENV = SECRETS_DIR / "hevy.env"
WEBHOOK_FILE = SECRETS_DIR / "hevy-webhook.txt"   # WEBHOOK_AUTH of the hevy-hook Worker
HEVY_CACHE_DIR = CACHE_ROOT / "strength" / "raw" / "hevy"
STRAVA_HR_DIR = CACHE_ROOT / "strength" / "raw" / "strava_hr"

STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
HEVY_API = "https://api.hevyapp.com/v1"
LIVE_BASE = (os.environ.get("HEVY_LIVE_BASE") or "https://hevy.er45.com").rstrip("/")

CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 8765
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/callback"
SCOPE = "activity:read_all,activity:write"

FOOTER = "— synced from Hevy"
STRENGTH_SPORTS = {"WeightTraining", "Workout"}
MATCH_TOLERANCE = timedelta(minutes=30)
PLACEHOLDER_PREFIX = "PASTE_"

MUL = "×"      # x
DASH = "—"     # em dash
DOT = " · "    # middle dot separator
GE = "≥"

USER_AGENT = "daily-dashboard-strava-sync/1.0"


class SetupNeeded(Exception):
    """Raised when secrets are missing/incomplete; message is the instructions."""


class ApiError(Exception):
    def __init__(self, status: int, message: str, retry_after: str | None = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.retry_after = retry_after


# --------------------------------------------------------------------------- #
# Description builder (pure, unit-tested by `selftest`)
# --------------------------------------------------------------------------- #

def fmt_num(x) -> str:
    """80.0 -> '80', 62.5 -> '62.5', 7.25 -> '7.25'."""
    f = float(x)
    if f.is_integer():
        return str(int(f))
    return f"{f:.2f}".rstrip("0").rstrip(".")


def fmt_set(s: dict) -> str:
    """One set -> 'kg x reps @RPE (marker)'. RPE omitted on warm-ups."""
    stype = (s.get("type") or "normal").lower()
    w = s.get("weight_kg")
    reps = s.get("reps")
    dur = s.get("duration_seconds")
    dist = s.get("distance_meters")
    has_w = w is not None and float(w) > 0

    if reps is not None:
        core = f"{fmt_num(w)}{MUL}{reps}" if has_w else f"BW{MUL}{reps}"
    elif dur:
        core = f"{fmt_num(w)}kg{MUL}{fmt_num(dur)}s" if has_w else f"{fmt_num(dur)}s"
    elif dist:
        core = f"{fmt_num(dist)}m"
    else:
        core = "?"

    rpe = s.get("rpe")
    if rpe is not None and stype != "warmup":
        core += f" @{fmt_num(rpe)}"
    if stype == "warmup":
        core += " (wu)"
    elif stype == "failure":
        core += " (f)"
    elif stype == "dropset":
        core += " (d)"
    return core


def fmt_exercise(ex: dict) -> str:
    title = (ex.get("title") or "Exercise").strip()
    sets = ex.get("sets") or []
    if not sets:
        return title
    return f"{title} {DASH} " + DOT.join(fmt_set(s) for s in sets)


def workout_totals(workout: dict) -> tuple[float, int, int]:
    """(work tonnage kg, work set count, hard sets RPE>=7). Warm-ups excluded."""
    tonnage = 0.0
    n_sets = 0
    hard = 0
    for ex in workout.get("exercises") or []:
        for s in ex.get("sets") or []:
            if (s.get("type") or "normal").lower() == "warmup":
                continue
            n_sets += 1
            w, r = s.get("weight_kg"), s.get("reps")
            if w is not None and r is not None:
                tonnage += float(w) * float(r)
            rpe = s.get("rpe")
            if rpe is not None and float(rpe) >= 7:
                hard += 1
    return tonnage, n_sets, hard


def build_description(workout: dict) -> str:
    lines = [fmt_exercise(ex) for ex in workout.get("exercises") or []]
    tonnage, n_sets, hard = workout_totals(workout)
    parts = ["\n".join(lines)] if lines else []
    parts.append(f"Work tonnage {tonnage:,.0f} kg · {n_sets} sets · hard sets (RPE{GE}7) {hard}")

    notes = []
    wdesc = (workout.get("description") or "").strip()
    if wdesc:
        notes.append(wdesc)
    for ex in workout.get("exercises") or []:
        n = (ex.get("notes") or "").strip()
        if n:
            notes.append(f"{(ex.get('title') or 'Exercise').strip()}: {n}")
    if notes:
        parts.append("Notes:\n" + "\n".join(notes))

    parts.append(FOOTER)
    return "\n\n".join(parts)


def build_name(workout: dict) -> str:
    return (workout.get("title") or "Weight Training").strip()


# --------------------------------------------------------------------------- #
# Time helpers
# --------------------------------------------------------------------------- #

def parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def workout_span(w: dict) -> tuple[datetime, datetime]:
    start = parse_ts(w["start_time"])
    end = parse_ts(w["end_time"]) if w.get("end_time") else start
    return start, max(start, end)


def match_activities(activities: list[dict], workouts: list[dict],
                     tol: timedelta = MATCH_TOLERANCE) -> list[tuple[dict, dict | None]]:
    """Pair each Strava activity with at most one Hevy workout (closest start
    wins) whose tolerance-widened span overlaps the activity's span."""
    pairs = []
    for ai, a in enumerate(activities):
        a0 = parse_ts(a["start_date"])
        a1 = a0 + timedelta(seconds=int(a.get("elapsed_time") or a.get("moving_time") or 0))
        for wi, w in enumerate(workouts):
            w0, w1 = workout_span(w)
            if a0 <= w1 + tol and w0 - tol <= a1:
                pairs.append((abs((a0 - w0).total_seconds()), ai, wi))
    pairs.sort()
    used_a, used_w, result = set(), set(), {}
    for _, ai, wi in pairs:
        if ai in used_a or wi in used_w:
            continue
        used_a.add(ai)
        used_w.add(wi)
        result[ai] = workouts[wi]
    return [(a, result.get(i)) for i, a in enumerate(activities)]


# --------------------------------------------------------------------------- #
# Secrets
# --------------------------------------------------------------------------- #

STRAVA_TEMPLATE = {
    "client_id": "PASTE_CLIENT_ID_HERE",
    "client_secret": "PASTE_CLIENT_SECRET_HERE",
    "refresh_token": "",
    "access_token": "",
    "expires_at": 0,
}
HEVY_TEMPLATE = (
    "# Hevy Pro API key from https://hevy.com/settings?developer\n"
    "HEVY_API_KEY=PASTE_HEVY_API_KEY_HERE\n"
)


def _is_placeholder(v) -> bool:
    return v is None or str(v).strip() == "" or str(v).strip().startswith(PLACEHOLDER_PREFIX)


def load_strava() -> dict:
    """Load strava.json; create a template and raise SetupNeeded if unusable."""
    if not STRAVA_JSON.exists():
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
        STRAVA_JSON.write_text(json.dumps(STRAVA_TEMPLATE, indent=2) + "\n", encoding="utf-8")
        raise SetupNeeded(
            f"Strava credentials file was missing; I created a template at:\n  {STRAVA_JSON}\n\n"
            + SETUP_TEXT
        )
    try:
        data = json.loads(STRAVA_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SetupNeeded(f"Cannot read {STRAVA_JSON} ({type(e).__name__}). Fix or delete it and re-run.")
    if _is_placeholder(data.get("client_id")) or _is_placeholder(data.get("client_secret")):
        raise SetupNeeded(
            f"{STRAVA_JSON} still has placeholder client_id / client_secret.\n\n" + SETUP_TEXT
        )
    return data


def save_strava(data: dict) -> None:
    tmp = STRAVA_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, STRAVA_JSON)


def load_hevy_key() -> str:
    if not HEVY_ENV.exists():
        SECRETS_DIR.mkdir(parents=True, exist_ok=True)
        HEVY_ENV.write_text(HEVY_TEMPLATE, encoding="utf-8")
        raise SetupNeeded(
            f"Hevy key file was missing; I created a template at:\n  {HEVY_ENV}\n"
            "Put your Hevy Pro API key (https://hevy.com/settings?developer) after HEVY_API_KEY=, "
            "or use --hevy-source freddy-cache."
        )
    key = None
    for line in HEVY_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == "HEVY_API_KEY":
            key = v.strip().strip('"').strip("'")
    if _is_placeholder(key):
        raise SetupNeeded(
            f"{HEVY_ENV} has no HEVY_API_KEY yet. Get it at https://hevy.com/settings?developer "
            "(Hevy Pro), or use --hevy-source freddy-cache."
        )
    return key


SETUP_TEXT = f"""SETUP (one time, done by you - this script never asks for passwords):
  1. Create a Strava API application at https://www.strava.com/settings/api
       Application name: anything | Category: Data Importer
       Website: http://localhost | Authorization Callback Domain: localhost
     Copy Client ID + Client Secret into:
       {STRAVA_JSON}
  2. (only for --hevy-source api) Hevy Pro API key from https://hevy.com/settings?developer into:
       {HEVY_ENV}
  3. Run once:   python tools/strava_sync.py auth      (click "Authorize" in the browser)
  4. Then:       python tools/strava_sync.py sync --days 7 --dry-run
                 python tools/strava_sync.py sync --days 7
Details: tools/README-strava.md"""


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #

def _http(method: str, url: str, headers: dict | None = None, body: bytes | None = None,
          timeout: int = 30):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, resp.headers, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise ApiError(e.code, raw[:300].replace("\n", " "),
                       retry_after=(e.headers.get("Retry-After") if e.headers else None)) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f"network error: {e.reason}") from None


def _seconds_to_next_quarter_hour() -> int:
    now = datetime.now(timezone.utc)
    nxt = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0) + timedelta(minutes=15)
    return int((nxt - now).total_seconds()) + 5


class RateLimitExhausted(Exception):
    pass


def _parse_pair(h: str | None) -> tuple[int, int] | None:
    try:
        a, b = (int(x) for x in str(h).split(","))
        return a, b
    except (TypeError, ValueError):
        return None


def _throttle(headers) -> None:
    """Back off proactively when the 15-min window is (nearly) spent."""
    limit = _parse_pair(headers.get("X-RateLimit-Limit"))
    usage = _parse_pair(headers.get("X-RateLimit-Usage"))
    if not limit or not usage:
        return
    if usage[1] >= limit[1]:
        raise RateLimitExhausted("Strava daily rate limit reached; try again tomorrow.")
    if usage[0] >= limit[0] - 1:
        wait = _seconds_to_next_quarter_hour()
        print(f"  [rate limit] 15-min window nearly spent ({usage[0]}/{limit[0]}); waiting {wait}s")
        time.sleep(wait)


# --------------------------------------------------------------------------- #
# Strava client
# --------------------------------------------------------------------------- #

class Strava:
    def __init__(self, creds: dict):
        self.creds = creds

    def _token_request(self, fields: dict) -> dict:
        body = urllib.parse.urlencode(fields).encode()
        _, _, data = _http("POST", STRAVA_TOKEN_URL,
                           {"Content-Type": "application/x-www-form-urlencoded"}, body)
        return data

    def _store_token(self, tok: dict) -> None:
        self.creds["access_token"] = tok["access_token"]
        self.creds["refresh_token"] = tok["refresh_token"]
        self.creds["expires_at"] = int(tok["expires_at"])
        save_strava(self.creds)

    def ensure_token(self) -> None:
        if _is_placeholder(self.creds.get("refresh_token")):
            raise SetupNeeded("No Strava tokens yet. Run:  python tools/strava_sync.py auth")
        if self.creds.get("access_token") and int(self.creds.get("expires_at") or 0) > time.time() + 120:
            return
        try:
            tok = self._token_request({
                "client_id": str(self.creds["client_id"]),
                "client_secret": self.creds["client_secret"],
                "grant_type": "refresh_token",
                "refresh_token": self.creds["refresh_token"],
            })
        except ApiError as e:
            raise SetupNeeded(f"Strava token refresh failed ({e}). Re-run:  python tools/strava_sync.py auth")
        self._store_token(tok)

    def request(self, method: str, path: str, params: dict | None = None, payload: dict | None = None):
        self.ensure_token()
        url = f"{STRAVA_API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        body = json.dumps(payload).encode() if payload is not None else None
        for attempt in range(3):
            headers = {"Authorization": f"Bearer {self.creds['access_token']}"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            try:
                _, hdrs, data = _http(method, url, headers, body)
            except ApiError as e:
                if e.status == 429 and attempt < 2:
                    wait = _seconds_to_next_quarter_hour()
                    print(f"  [rate limit] HTTP 429; waiting {wait}s")
                    time.sleep(wait)
                    continue
                if e.status == 401 and attempt < 2:
                    self.creds["expires_at"] = 0   # force refresh
                    self.ensure_token()
                    continue
                if e.status == 401:
                    raise SetupNeeded("Strava rejected the token. Re-run:  python tools/strava_sync.py auth")
                raise
            _throttle(hdrs)
            return data
        raise ApiError(429, "rate limited after retries")

    def list_activities(self, after: datetime) -> list[dict]:
        out, page = [], 1
        while True:
            batch = self.request("GET", "/athlete/activities",
                                 {"after": int(after.timestamp()), "per_page": 100, "page": page})
            if not batch:
                break
            out.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        return out

    def get_activity(self, aid: int) -> dict:
        return self.request("GET", f"/activities/{aid}")

    def update_activity(self, aid: int, name: str, description: str) -> dict:
        return self.request("PUT", f"/activities/{aid}", payload={"name": name, "description": description})


# --------------------------------------------------------------------------- #
# hevy-hook Worker client (the Worker is the only Strava API client)
# --------------------------------------------------------------------------- #

DIRECT_WARNING = (
    "[direct] talking to the Strava API with secrets/strava.json - this makes this machine a SECOND\n"
    "         owner of the Strava refresh token and can break the hevy-hook Worker. Afterwards run:\n"
    "           python tools/strava_sync.py auth\n"
    "           powershell -ExecutionPolicy Bypass -File tools\\set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN")

SET_SECRETS_CMD = "powershell -ExecutionPolicy Bypass -File tools\\set_live_secrets.ps1"


def load_webhook_auth() -> str:
    """WEBHOOK_AUTH value (64 hex chars) from secrets/hevy-webhook.txt; never printed."""
    if not WEBHOOK_FILE.exists():
        raise SetupNeeded(
            f"Missing {WEBHOOK_FILE} (the hevy-hook Worker's WEBHOOK_AUTH). See "
            "workers/hevy-hook/README.md, or use --direct (emergency only: second token owner).")
    v = WEBHOOK_FILE.read_text(encoding="utf-8").strip()
    if len(v) != 64 or any(c not in "0123456789abcdef" for c in v):
        raise SetupNeeded(f"{WEBHOOK_FILE} does not contain 64 hex characters.")
    return v


def _worker_http(method: str, url: str, headers: dict, body: bytes | None = None, timeout: int = 60):
    """-> (status, parsed JSON or None, Retry-After). Never raises on HTTP errors;
    status 0 = network error (data = {"error": reason})."""
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None), resp.headers.get("Retry-After")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = {"error": raw[:200].decode("utf-8", "replace")}
        return e.code, data, (e.headers.get("Retry-After") if e.headers else None)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        return 0, {"error": str(getattr(e, "reason", e))}, None


class WorkerClient:
    """GET /live/hr?since=, GET /live/hr/<id>, POST /live/strava/sync on the hevy-hook Worker.
    Maps Worker errors onto this script's exit codes: 401 / 503 not-configured / strava-auth
    -> SetupNeeded (2); 503 rate-limited -> RateLimitExhausted (3); anything else -> ApiError (1).
    Network errors and 500/502/504 are retried twice (2 s, 4 s)."""

    ATTEMPTS = 3

    def __init__(self, auth: str, base: str = LIVE_BASE, http=None, sleep=None):
        self.base = base.rstrip("/")
        self._auth = auth
        self.http = http or _worker_http
        self.sleep = sleep or time.sleep

    def call(self, method: str, path: str, ok404: bool = False):
        url = self.base + path
        status, data, retry_after = 0, None, None
        for attempt in range(self.ATTEMPTS):
            status, data, retry_after = self.http(method, url, {"Authorization": self._auth},
                                                  b"" if method == "POST" else None)
            if status in (0, 500, 502, 504) and attempt < self.ATTEMPTS - 1:
                self.sleep(2 * (attempt + 1))
                continue
            break
        err = data if isinstance(data, dict) else {}
        msg = str(err.get("error") or "")[:200]
        code = err.get("code")
        if 200 <= status < 300:
            return data
        if status == 404 and ok404:
            return None
        if status == 401:
            raise SetupNeeded(
                f"Worker {self.base} rejected the Authorization header (401): WEBHOOK_AUTH is not set on the "
                f"Worker yet, or differs from {WEBHOOK_FILE}. Run:\n  {SET_SECRETS_CMD}")
        if status == 503 and code == "rate-limited":
            raise RateLimitExhausted(f"Strava rate limit (via Worker): {msg} Retry-After {retry_after or '?'} s.")
        if status == 503 and code in ("not-configured", "strava-auth"):
            hint = ("  (first `python tools/strava_sync.py auth` if the Strava token was revoked, then "
                    "`-Only STRAVA_REFRESH_TOKEN`)" if code == "strava-auth" else "")
            raise SetupNeeded(f"Worker is not ready ({code}): {msg}\nRun:  {SET_SECRETS_CMD}{hint}")
        if status == 0:
            raise ApiError(0, f"Worker {self.base} unreachable ({msg}); check {self.base}/live/health "
                              "(--direct only in an emergency)")
        raise ApiError(status, f"Worker {method} {path.split('?')[0]}: {msg or 'error'}")

    def hr_list(self, since: date) -> list[dict]:
        data = self.call("GET", f"/live/hr?since={since.isoformat()}")
        items = data.get("activities") if isinstance(data, dict) else data
        if not isinstance(items, list):
            raise ApiError(502, "Worker /live/hr returned an unexpected shape")
        return items

    def hr_doc(self, strava_id) -> dict | None:
        """The raw HR doc, or None when the activity has no heart-rate stream (404)."""
        return self.call("GET", f"/live/hr/{int(strava_id)}", ok404=True)

    def strava_sync(self, days: int, dry_run: bool, force: bool) -> dict:
        q = {"days": days}
        if dry_run:
            q["dryRun"] = 1
        if force:
            q["force"] = 1
        return self.call("POST", "/live/strava/sync?" + urllib.parse.urlencode(q))


def normalize_hr_doc(doc: dict, strava_id) -> dict:
    """Validate a Worker HR doc and rebuild it in hr_cache_doc's exact key order."""
    try:
        vals = doc["streams"]["heart_rate"]["values"]
        ts = doc["timestamps"]
        ok = (isinstance(vals, list) and isinstance(ts, list) and 0 < len(vals) == len(ts)
              and int(doc["sampleCount"]) == len(vals) and str(doc["stravaId"]) == str(strava_id)
              and doc.get("source") == "strava")
        parse_ts(doc["startTime"])
    except (KeyError, TypeError, ValueError):
        ok = False
    if not ok:
        raise ApiError(502, f"Worker returned a malformed HR doc for activity {strava_id}")
    return {"startTime": doc["startTime"], "sampleCount": len(vals),
            "streams": {"heart_rate": {"unit": doc["streams"]["heart_rate"].get("unit") or "bpm",
                                       "values": vals}},
            "timestamps": ts, "source": "strava", "stravaId": doc["stravaId"], "name": doc.get("name") or ""}


def write_hr_file(path: Path, doc: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, path)


def fetch_hr_via_worker(client: WorkerClient, since: date, out_dir: Path,
                        force: bool = False, dry_run: bool = False) -> dict:
    """List strength activities via the Worker and write raw/strava_hr/<local date>_<id>.json
    (same naming and bytes as the direct path). Returns counts."""
    items = client.hr_list(since)
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
    c = {"activities": len(items), "written": 0, "skipped_existing": 0, "no_hr_stream": 0, "would_fetch": 0}
    for it in sorted(items, key=lambda x: str(x.get("startTime") or "")):
        sid = it["stravaId"]
        local_day = str(it.get("startDateLocal") or it["startTime"])[:10]
        path = out_dir / f"{local_day}_{sid}.json"
        if path.exists() and not force:
            c["skipped_existing"] += 1
            continue
        if dry_run:
            c["would_fetch"] += 1
            print(f"  would GET {client.base}/live/hr/{sid} -> {path.name}")
            continue
        doc = client.hr_doc(sid)
        if doc is None:
            c["no_hr_stream"] += 1
            continue
        write_hr_file(path, normalize_hr_doc(doc, sid))
        c["written"] += 1
    return c


def use_worker(args) -> bool:
    """--via-worker / --direct; otherwise ON when secrets/hevy-webhook.txt exists."""
    if getattr(args, "direct", False):
        return False
    if getattr(args, "via_worker", False):
        return True
    return WEBHOOK_FILE.exists()


# --------------------------------------------------------------------------- #
# Hevy sources
# --------------------------------------------------------------------------- #

HEVY_ATTEMPTS = 6


def _hevy_get(url: str, key: str, http=None, sleep=None):
    """GET a Hevy API URL; like tools/hevy_fetch.py, retry HTTP 429 / 5xx and network
    errors with backoff (Retry-After if given, else 2, 4, 6 ... s), up to HEVY_ATTEMPTS."""
    http = http or _http
    sleep = sleep or time.sleep
    last = None
    for attempt in range(HEVY_ATTEMPTS):
        try:
            return http("GET", url, {"api-key": key})
        except ApiError as e:
            if not (e.status == 0 or e.status == 429 or e.status >= 500):
                raise
            last = e
            if attempt == HEVY_ATTEMPTS - 1:
                break
            try:
                wait = int(e.retry_after or 0)
            except (TypeError, ValueError):
                wait = 0
            sleep(max(wait, 2 * (attempt + 1)))
    raise ApiError(last.status, f"Hevy: gave up after {HEVY_ATTEMPTS} attempts ({last})")


def hevy_from_api(key: str, since: datetime) -> list[dict]:
    """Newest-first pagination; stop once a page is entirely older than window."""
    out, page = [], 1
    cutoff = since - MATCH_TOLERANCE
    while True:
        url = f"{HEVY_API}/workouts?page={page}&pageSize=10"
        _, _, data = _hevy_get(url, key)
        workouts = (data or {}).get("workouts") or []
        out.extend(workouts)
        page_count = int((data or {}).get("page_count") or page)
        if not workouts or page >= page_count:
            break
        if all(workout_span(w)[0] < cutoff for w in workouts):
            break
        page += 1
    return out


def hevy_from_cache(since: datetime) -> list[dict]:
    files = sorted(glob.glob(str(HEVY_CACHE_DIR / "*.json")))
    if not files:
        raise SetupNeeded(
            f"No Hevy cache files found in {HEVY_CACHE_DIR}\\*.json. "
            "Fill the cache first, or use --hevy-source api (needs HEVY_API_KEY)."
        )
    seen, out = set(), []
    for f in files:
        try:
            data = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            print(f"  [warn] skipping unreadable cache file {Path(f).name}")
            continue
        items = data if isinstance(data, list) else data.get("workouts", [data]) if isinstance(data, dict) else []
        for w in items:
            if not isinstance(w, dict) or not w.get("start_time"):
                continue
            wid = w.get("id") or (w["start_time"], w.get("title"))
            if wid in seen:
                continue
            seen.add(wid)
            out.append(w)
    return out


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #

def _selftest_worker_client() -> list[tuple[str, bool]]:
    """Worker client against a scripted HTTP function (no network, nothing outside a temp dir)."""
    import tempfile
    auth = "ab" * 32
    base = "https://worker.test"
    act = {"id": 555, "start_date": "2026-09-26T07:08:00Z", "start_date_local": "2026-09-26T09:08:00Z",
           "name": "Legs A"}
    expected = hr_cache_doc(act, {"time": {"data": [0, 1, 2]}, "heartrate": {"data": [90, 95, 99]}})
    listing = [{"stravaId": 555, "name": "Legs A", "startTime": expected["startTime"],
                "startDateLocal": act["start_date_local"], "workoutId": "h1", "sampleCount": 3},
               {"stravaId": 777, "name": "No strap", "startTime": "2026-09-27T07:00:00.000Z",
                "startDateLocal": "2026-09-27T09:00:00Z", "workoutId": None, "sampleCount": 0}]
    calls: list[tuple] = []

    def fake(routes):
        def f(method, url, headers, body=None):
            calls.append((method, url, headers.get("Authorization")))
            for m, suffix, resp in routes:
                if m == method and url.endswith(suffix):
                    return resp() if callable(resp) else resp
            return 404, {"ok": False, "code": "not-found"}, None
        return f

    ok_routes = [("GET", "/live/hr?since=2026-09-20", (200, listing, None)),
                 ("GET", "/live/hr/555", (200, dict(expected), None)),
                 ("GET", "/live/hr/777", (404, {"ok": False, "code": "no-hr"}, None)),
                 ("POST", "/live/strava/sync?days=3&dryRun=1",
                  (200, {"ok": True, "updated": 1, "skipped": 0, "unchanged": 0, "unmatched": 0,
                         "activities": 1, "workouts": 1, "items": []}, None))]
    out: list[tuple[str, bool]] = []
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        cl = WorkerClient(auth, base=base, http=fake(ok_routes), sleep=lambda _s: None)
        dry = fetch_hr_via_worker(cl, date(2026, 9, 20), d, dry_run=True)
        out.append(("worker fetch-hr dry-run: lists only, writes nothing",
                    dry["would_fetch"] == 2 and not any(d.iterdir())
                    and [c[1] for c in calls] == [f"{base}/live/hr?since=2026-09-20"]))
        calls.clear()
        c = fetch_hr_via_worker(cl, date(2026, 9, 20), d)
        f555 = d / "2026-09-26_555.json"
        same_bytes = f555.exists() and f555.read_text(encoding="utf-8") == json.dumps(
            expected, ensure_ascii=False, separators=(",", ":"))
        out.append(("worker fetch-hr: same file name + bytes as direct mode, 404 -> no_hr",
                    c["written"] == 1 and c["no_hr_stream"] == 1 and same_bytes
                    and not (d / "2026-09-27_777.json").exists()))
        out.append(("worker calls carry the Authorization header",
                    bool(calls) and all(a == auth for _m, _u, a in calls)))
        calls.clear()
        again = fetch_hr_via_worker(cl, date(2026, 9, 20), d)
        out.append(("worker fetch-hr: existing file skipped (no re-download)",
                    again["skipped_existing"] == 1 and not any(u.endswith("/555") for _m, u, _a in calls)))
        bad = WorkerClient(auth, base=base, sleep=lambda _s: None, http=fake([
            ("GET", "/live/hr?since=2026-09-20", (200, listing[:1], None)),
            ("GET", "/live/hr/555", (200, {**expected, "sampleCount": 99}, None))]))
        try:
            fetch_hr_via_worker(bad, date(2026, 9, 20), d, force=True)
            malformed = False
        except ApiError as e:
            malformed = e.status == 502
        out.append(("worker fetch-hr: malformed doc rejected", malformed))

    ns = argparse.Namespace(days=3, dry_run=True, force=False)
    calls.clear()
    rc = cmd_sync_via_worker(ns, WorkerClient(auth, base=base, http=fake(ok_routes), sleep=lambda _s: None))
    out.append(("worker sync: POST /live/strava/sync?days=3&dryRun=1",
                rc == 0 and calls == [("POST", f"{base}/live/strava/sync?days=3&dryRun=1", auth)]))

    def raises(resp, exc):
        seq = iter(resp)
        slept: list[int] = []
        cl = WorkerClient(auth, base=base, http=lambda *_a, **_k: next(seq), sleep=slept.append)
        try:
            cl.hr_list(date(2026, 9, 20))
        except exc:
            return slept
        except Exception:  # noqa: BLE001 - wrong type = failed check
            return None
        return None
    out.append(("worker 401 -> SetupNeeded (exit 2)",
                raises([(401, {"ok": False, "code": "unauthorized"}, None)], SetupNeeded) == []))
    out.append(("worker 503 not-configured -> SetupNeeded (exit 2)",
                raises([(503, {"code": "not-configured", "error": "x"}, None)], SetupNeeded) == []))
    out.append(("worker 503 rate-limited -> RateLimitExhausted (exit 3)",
                raises([(503, {"code": "rate-limited", "error": "x"}, "60")], RateLimitExhausted) == []))
    out.append(("worker unreachable -> 2 retries (2 s, 4 s) then ApiError (exit 1)",
                raises([(0, {"error": "down"}, None)] * 3, ApiError) == [2, 4]))
    out.append(("route: --direct / --via-worker flags win over the default",
                use_worker(argparse.Namespace(direct=True, via_worker=False)) is False
                and use_worker(argparse.Namespace(direct=False, via_worker=True)) is True))
    return out


def cmd_selftest(_args) -> int:
    sample = {
        "title": "Legs A",
        "exercises": [{
            "title": "Front Squat",
            "sets": [
                {"type": "warmup", "weight_kg": 60, "reps": 6, "rpe": 6},
                {"type": "normal", "weight_kg": 80, "reps": 10, "rpe": 7.5},
                {"type": "normal", "weight_kg": 80, "reps": 10, "rpe": 8},
                {"type": "normal", "weight_kg": 80, "reps": 10, "rpe": 9},
            ],
        }],
    }
    line = fmt_exercise(sample["exercises"][0])
    want = f"Front Squat {DASH} 60{MUL}6 (wu){DOT}80{MUL}10 @7.5{DOT}80{MUL}10 @8{DOT}80{MUL}10 @9"
    tonnage, n_sets, hard = workout_totals(sample)
    desc = build_description(sample)
    checks = [
        ("exercise line", line == want),
        ("tonnage 2,400", f"{tonnage:,.0f}" == "2,400"),
        ("work sets 3 (warm-up excluded)", n_sets == 3),
        ("hard sets 3", hard == 3),
        ("totals line in description", f"Work tonnage 2,400 kg · 3 sets · hard sets (RPE{GE}7) 3" in desc),
        ("footer last", desc.endswith(FOOTER)),
        ("failure/dropset markers", fmt_set({"type": "failure", "weight_kg": 62.5, "reps": 8, "rpe": 10}) == f"62.5{MUL}8 @10 (f)"
         and fmt_set({"type": "dropset", "weight_kg": 40, "reps": 12}) == f"40{MUL}12 (d)"),
        ("bodyweight set", fmt_set({"type": "normal", "reps": 12}) == f"BW{MUL}12"),
    ]
    # matching: Strava 10:05Z (60 min) vs Hevy 10:00-11:00Z matches; 14:00Z does not
    acts = [{"id": 1, "start_date": "2026-09-29T10:05:00Z", "elapsed_time": 3600},
            {"id": 2, "start_date": "2026-09-29T14:00:00Z", "elapsed_time": 3600}]
    wks = [{"id": "h1", "start_time": "2026-09-29T12:00:00+02:00", "end_time": "2026-09-29T13:00:00+02:00"}]
    m = match_activities(acts, wks)
    checks.append(("time-overlap matching", m[0][1] is not None and m[1][1] is None))

    # Hevy GET retries 429 / 5xx with backoff (Retry-After honoured), never other 4xx
    def fake_http(seq):
        it = iter(seq)

        def f(*_a, **_k):
            x = next(it)
            if isinstance(x, Exception):
                raise x
            return x
        return f
    slept: list[int] = []
    got = _hevy_get("u", "k", http=fake_http([ApiError(429, "slow", "7"), ApiError(503, "down"),
                                              (200, {}, {"workouts": []})]), sleep=slept.append)
    try:
        _hevy_get("u", "k", http=fake_http([ApiError(404, "nope")]), sleep=slept.append)
        no_retry_4xx = False
    except ApiError as e:
        no_retry_4xx = e.status == 404
    checks.append(("hevy retry on 429/5xx with backoff", got[0] == 200 and slept == [7, 4] and no_retry_4xx))
    checks.extend(_selftest_worker_client())

    print(line)
    print(f"Work tonnage {tonnage:,.0f} kg")
    print("--- full description ---")
    print(desc)
    print("--- checks ---")
    ok = True
    for name, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
        ok &= passed
    print("SELFTEST " + ("OK" if ok else "FAILED"))
    return 0 if ok else 1


def cmd_auth(_args) -> int:
    creds = load_strava()
    state = _secrets.token_urlsafe(16)
    result: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            u = urllib.parse.urlparse(self.path)
            if u.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            q = urllib.parse.parse_qs(u.query)
            result.update({k: v[0] for k, v in q.items()})
            ok = "code" in q and q.get("state", [""])[0] == state
            msg = ("Strava authorized. You can close this tab and return to the terminal."
                   if ok else "Authorization failed or was denied. Check the terminal.")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"<html><body style='font-family:sans-serif'><h3>{msg}</h3></body></html>".encode())

        def log_message(self, *a):  # never log the URL (contains the auth code)
            pass

    try:
        server = http.server.HTTPServer((CALLBACK_HOST, CALLBACK_PORT), Handler)
    except OSError as e:
        print(f"Cannot listen on port {CALLBACK_PORT}: {e}. Close whatever uses it and retry.")
        return 1
    server.timeout = 1

    url = STRAVA_AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": str(creds["client_id"]),
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": SCOPE,
        "state": state,
    })
    print(f"Waiting for the Strava callback on {REDIRECT_URI} (timeout 5 min).")
    print("Opening the browser; if it does not open, visit this URL:\n  " + url)
    webbrowser.open(url)

    deadline = time.time() + 300
    while time.time() < deadline and "code" not in result and "error" not in result:
        server.handle_request()
    server.server_close()

    if "error" in result:
        print(f"Strava returned an error: {result['error']}")
        return 1
    if "code" not in result:
        print("Timed out waiting for authorization.")
        return 1
    if result.get("state") != state:
        print("State mismatch on callback; aborting.")
        return 1
    granted = result.get("scope", "")
    if "activity:write" not in granted:
        print(f"Warning: granted scope is '{granted}' - activity:write is missing; "
              "re-run auth and leave the write checkbox ticked.")

    try:
        tok = Strava(creds)._token_request({
            "client_id": str(creds["client_id"]),
            "client_secret": creds["client_secret"],
            "code": result["code"],
            "grant_type": "authorization_code",
        })
    except ApiError as e:
        print(f"Token exchange failed: {e}")
        return 1
    creds["access_token"] = tok["access_token"]
    creds["refresh_token"] = tok["refresh_token"]
    creds["expires_at"] = int(tok["expires_at"])
    save_strava(creds)
    who = tok.get("athlete") or {}
    print(f"OK - tokens stored in {STRAVA_JSON} (athlete: {who.get('firstname', '?')} {who.get('lastname', '')}).")
    print("Next: python tools/strava_sync.py sync --days 7 --dry-run")
    return 0


def cmd_sync_via_worker(args, client: WorkerClient | None = None) -> int:
    client = client or WorkerClient(load_webhook_auth())
    mode = "DRY-RUN" if args.dry_run else "LIVE"
    print(f"[{mode}] via Worker {client.base}: POST /live/strava/sync?days={args.days}"
          + (" (force)" if args.force else "") + "; Hevy source: the Worker's Hevy API key")
    r = client.strava_sync(args.days, args.dry_run, args.force)
    for it in r.get("items") or []:
        label = f"{str(it.get('start') or '')[:16]}Z '{it.get('name')}' (id {it.get('stravaId')})"
        extra = f" -> '{it['newName']}'" if it.get("newName") else ""
        print(f"- {str(it.get('action')).upper():<12} {label}{extra}")
    skipped = int(r.get("skipped") or 0) + int(r.get("unchanged") or 0)
    print(f"Done: {r.get('updated', 0)} {'planned' if args.dry_run else 'updated'}, {skipped} skipped, "
          f"{r.get('unmatched', 0)} unmatched"
          + (f", {r['deferred']} deferred (run again)" if r.get("deferred") else "")
          + f" (Strava strength activities {r.get('activities', 0)}, Hevy workouts {r.get('workouts', 0)}).")
    return 0


def cmd_sync(args) -> int:
    if use_worker(args):
        return cmd_sync_via_worker(args)
    print(DIRECT_WARNING)
    creds = load_strava()
    strava = Strava(creds)
    strava.ensure_token()

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)
    mode = "DRY-RUN" if args.dry_run else "LIVE"
    print(f"[{mode}] window: last {args.days} day(s) since {since:%Y-%m-%d %H:%MZ}; hevy source: {args.hevy_source}")

    acts = [a for a in strava.list_activities(since)
            if (a.get("sport_type") or a.get("type")) in STRENGTH_SPORTS]
    print(f"Strava strength activities in window: {len(acts)}")
    if not acts:
        return 0

    if args.hevy_source == "api":
        workouts = hevy_from_api(load_hevy_key(), since)
    else:
        workouts = hevy_from_cache(since)
    print(f"Hevy workouts loaded: {len(workouts)}")

    changed = skipped = unmatched = 0
    for act, w in match_activities(acts, workouts):
        label = f"{act['start_date'][:16]}Z '{act.get('name')}' (id {act['id']})"
        if w is None:
            unmatched += 1
            print(f"- NO MATCH  {label}")
            continue
        new_name, new_desc = build_name(w), build_description(w)
        detail = strava.get_activity(act["id"])
        cur_name, cur_desc = detail.get("name") or "", (detail.get("description") or "")
        if FOOTER in cur_desc and not args.force:
            skipped += 1
            print(f"- SKIP      {label}: already synced (use --force to rewrite)")
            continue
        if cur_name == new_name and cur_desc.strip() == new_desc.strip():
            skipped += 1
            print(f"- UNCHANGED {label}")
            continue
        changed += 1
        print(f"- {'WOULD UPDATE' if args.dry_run else 'UPDATE'}  {label}\n"
              f"    name: '{cur_name}' -> '{new_name}'"
              + (f"\n    (replaces existing description, {len(cur_desc)} chars)" if cur_desc.strip() else ""))
        print("    " + new_desc.replace("\n", "\n    "))
        if not args.dry_run:
            strava.update_activity(act["id"], new_name, new_desc)
            print("    -> written")
    print(f"Done: {changed} {'planned' if args.dry_run else 'updated'}, {skipped} skipped, {unmatched} unmatched.")
    return 0


def hr_cache_doc(act: dict, streams: dict) -> dict | None:
    """Strava streams (key_by_type) -> the Garmin-schema doc build_strength.py reads;
    None when the activity has no usable heart-rate stream."""
    hr = ((streams or {}).get("heartrate") or {}).get("data")
    tm = ((streams or {}).get("time") or {}).get("data")
    if not hr or not tm or len(hr) != len(tm):
        return None
    return {"startTime": parse_ts(act["start_date"]).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "sampleCount": len(hr),
            "streams": {"heart_rate": {"unit": "bpm", "values": hr}},
            "timestamps": tm,
            "source": "strava", "stravaId": act["id"], "name": act.get("name") or ""}


def cmd_fetch_hr(args) -> int:
    if args.since:
        since = datetime.combine(date.fromisoformat(args.since), datetime.min.time(), timezone.utc)
    else:
        since = datetime.now(timezone.utc) - timedelta(days=args.days if args.days is not None else 14)

    if use_worker(args):
        client = WorkerClient(load_webhook_auth())
        print(f"fetch-hr via Worker: GET {client.base}/live/hr?since={since.date().isoformat()}"
              + ("  [DRY-RUN: nothing is written]" if args.dry_run else ""))
        c = fetch_hr_via_worker(client, since.date(), STRAVA_HR_DIR, force=args.force, dry_run=args.dry_run)
        print(f"fetch-hr: since {since:%Y-%m-%d} activities={c['activities']} "
              + (f"would_fetch={c['would_fetch']} " if args.dry_run else f"written={c['written']} ")
              + f"skipped_existing={c['skipped_existing']} no_hr_stream={c['no_hr_stream']} (via worker)")
        return 0

    print(DIRECT_WARNING)
    creds = load_strava()
    strava = Strava(creds)
    strava.ensure_token()
    acts = [a for a in strava.list_activities(since)
            if (a.get("sport_type") or a.get("type")) in STRENGTH_SPORTS]
    if not args.dry_run:
        STRAVA_HR_DIR.mkdir(parents=True, exist_ok=True)
    written = skipped = no_hr = planned = 0
    for act in sorted(acts, key=lambda a: a["start_date"]):
        local_day = (act.get("start_date_local") or act["start_date"])[:10]
        path = STRAVA_HR_DIR / f"{local_day}_{act['id']}.json"
        if path.exists() and not args.force:
            skipped += 1
            continue
        if args.dry_run:
            planned += 1
            print(f"  would fetch streams of {act['id']} -> {path.name}")
            continue
        try:
            streams = strava.request("GET", f"/activities/{act['id']}/streams",
                                     {"keys": "time,heartrate", "key_by_type": "true"})
        except ApiError as e:
            if e.status == 404:          # manual activity / no streams
                no_hr += 1
                continue
            raise
        doc = hr_cache_doc(act, streams)
        if doc is None:
            no_hr += 1
            continue
        write_hr_file(path, doc)
        written += 1
    print(f"fetch-hr: since {since:%Y-%m-%d} activities={len(acts)} "
          + (f"would_fetch={planned} " if args.dry_run else f"written={written} ")
          + f"skipped_existing={skipped} no_hr_stream={no_hr} (direct)")
    return 0


def _route_args(sp) -> None:
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--via-worker", action="store_true",
                   help="go through the hevy-hook Worker (default when secrets/hevy-webhook.txt exists)")
    g.add_argument("--direct", action="store_true",
                   help="EMERGENCY: call Strava directly with secrets/strava.json (second token owner; "
                        "afterwards `auth` + set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN)")


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    p = argparse.ArgumentParser(description="Rewrite Strava strength activities from Hevy.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("auth", help="one-time Strava OAuth flow")
    s = sub.add_parser("sync", help="rewrite Strava name/description from Hevy")
    s.add_argument("--days", type=int, default=7)
    s.add_argument("--dry-run", action="store_true", help="print planned changes only")
    s.add_argument("--force", action="store_true", help="also rewrite activities already synced")
    s.add_argument("--hevy-source", choices=["api", "freddy-cache"], default="api",
                   help="direct mode only; via the Worker the Worker's Hevy API key is used")
    _route_args(s)
    sub.add_parser("selftest", help="offline test of the description builder")
    f = sub.add_parser("fetch-hr", help="cache 1 s HR streams of strength activities")
    f.add_argument("--days", type=int, default=None, help="window in days (default 14)")
    f.add_argument("--since", metavar="YYYY-MM-DD", help="window start (overrides --days)")
    f.add_argument("--force", action="store_true", help="re-fetch files that already exist")
    f.add_argument("--dry-run", action="store_true", help="list what would be fetched; write nothing")
    _route_args(f)
    args = p.parse_args(argv)

    try:
        return {"auth": cmd_auth, "sync": cmd_sync, "selftest": cmd_selftest,
                "fetch-hr": cmd_fetch_hr}[args.cmd](args)
    except SetupNeeded as e:
        print(str(e))
        return 2
    except RateLimitExhausted as e:
        print(str(e))
        return 3
    except ApiError as e:
        print(f"API error: {e}")
        return 1
    except KeyboardInterrupt:
        print("Interrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
