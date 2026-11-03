#!/usr/bin/env python3
"""garmin_sync.py - pull sleep + daily wellness straight from the Garmin Personal API.

    python tools/garmin_sync.py [--days N | --since YYYY-MM-DD] [--json]

Three range calls cover the whole window (chunked at 28 days):
    /sleep-service/sleep/dailySleepSummariesByDate   sleep stages, score, bed/wake
    /hrv-service/hrv/daily/{from}/{to}               last-night HRV, weekly avg, status
    /usersummary-service/v2/dailysummaries           RHR, stress, BMR/active kcal, Body Battery

Rows are normalised to the connector's metric names (REFRESH.md §1), one row per Garmin
calendarDate (= the WAKE date; §1b night attribution is applied by the refresh, not here),
and merged into
    <CACHE>/garmin/wellness.json        {"meta": {...}, "days": {"YYYY-MM-DD": row}}
Days in the window are replaced, days outside it are kept. A day with no sleep record still
gets a row (sleep fields null) so untracked nights stay visible (§1d rule 2).

The API key is read from <CACHE>/secrets/garmin.env (GARMIN_PERSONAL_API_KEY=...) and is
never printed. The 24 h access token is cached in <CACHE>/garmin/token.json.

Exit codes:
    0  ok, and today's sleep record is present
    1  API / network error
    2  key missing, expired or rejected  -> fall back to the connector
    3  ok, but no sleep record for today yet (watch not synced) -> retry later
Python stdlib only. On the Mac use /opt/homebrew/bin/python3.14 (the system 3.9 has no CA
bundle for this host).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("ZG_CACHE") or Path.home() / ".claude" / "cache" / "daily-dashboard")
GARMIN_ENV = CACHE_ROOT / "secrets" / "garmin.env"
GARMIN_DIR = CACHE_ROOT / "garmin"
TOKEN_FILE = GARMIN_DIR / "token.json"
OUT_FILE = GARMIN_DIR / "wellness.json"
API = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
CHUNK_DAYS = 28
TOKEN_MARGIN_S = 600
USER_AGENT = "daily-dashboard-garmin-sync/1.0"


class FetchError(Exception):
    pass


class AuthError(FetchError):
    pass


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #

def load_key() -> str:
    if not GARMIN_ENV.exists():
        raise AuthError(f"missing {GARMIN_ENV} (needs GARMIN_PERSONAL_API_KEY=...)")
    for line in GARMIN_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("GARMIN_PERSONAL_API_KEY="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v and not v.startswith("PASTE_"):
                return v
    raise AuthError(f"no usable GARMIN_PERSONAL_API_KEY in {GARMIN_ENV}")


def jwt_exp(token: str) -> int:
    try:
        seg = token.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        return int(json.loads(base64.urlsafe_b64decode(seg))["exp"])
    except (IndexError, ValueError, KeyError, TypeError):
        return 0


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def fetch_token(key: str) -> str:
    req = urllib.request.Request(API + TOKEN_PATH, data=b"", method="POST",
                                 headers={"Authorization": f"ApiKey {key}", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8").strip()
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403):
            raise AuthError(f"token: HTTP {e.code} (key expired or revoked?)") from None
        raise FetchError(f"token: HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise FetchError(f"token: network error ({type(e).__name__})") from None
    token = body
    if body.startswith("{"):
        d = json.loads(body)
        token = d.get("access_token") or d.get("accessToken") or d.get("token") or ""
    if token.count(".") != 2:
        raise AuthError("token: unexpected response shape")
    write_private(TOKEN_FILE, json.dumps({"access_token": token, "exp": jwt_exp(token)}))
    return token


def get_token(force: bool = False) -> str:
    if not force and TOKEN_FILE.exists():
        try:
            d = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            if int(d.get("exp") or 0) - time.time() > TOKEN_MARGIN_S:
                return d["access_token"]
        except (OSError, ValueError, KeyError):
            pass
    return fetch_token(load_key())


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

class Client:
    def __init__(self) -> None:
        self.token = get_token()
        self.calls = 0

    def get(self, path: str, params: dict | None = None):
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        last = "unknown"
        refreshed = False
        for attempt in range(5):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}",
                                                       "accept": "application/json",
                                                       "User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    self.calls += 1
                    raw = r.read().decode("utf-8")
                    return json.loads(raw) if raw.strip() else None
            except urllib.error.HTTPError as e:
                last = f"HTTP {e.code}"
                if e.code == 401 and not refreshed:
                    self.token = get_token(force=True)
                    refreshed = True
                    continue
                if e.code in (401, 403):
                    raise AuthError(f"{path}: {last}") from None
                if e.code == 429 or e.code >= 500:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise FetchError(f"{path}: {last}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                last = f"network error ({type(e).__name__})"
                time.sleep(2 * (attempt + 1))
        raise FetchError(f"{path}: gave up after retries ({last})")


def chunks(start: date, end: date):
    cur = start
    while cur <= end:
        stop = min(end, cur + timedelta(days=CHUNK_DAYS - 1))
        yield cur, stop
        cur = stop + timedelta(days=1)


# --------------------------------------------------------------------------- #
# normalise
# --------------------------------------------------------------------------- #

SLEEP_KEYS = ("sleep_overallSleepScore", "sleep_durationInSeconds", "sleep_deepSleepDurationInSeconds",
              "sleep_lightSleepDurationInSeconds", "sleep_remSleepInSeconds", "sleep_awakeDurationInSeconds",
              "sleep_startTimeInSeconds", "sleep_startTimeOffsetInSeconds", "sleep_bedLocal",
              "sleep_wakeLocal")


def empty_row(d: str) -> dict:
    row = {"calendarDate": d}
    for k in SLEEP_KEYS:
        row[k] = None
    row.update({"hrv_lastNightAvg": None, "hrv_weeklyAvg": None, "hrv_status": None,
                "daily_restingHeartRateInBeatsPerMinute": None, "daily_averageStressLevel": None,
                "daily_bmrKilocalories": None, "daily_activeKilocalories": None,
                "bb_charged": None, "bb_drained": None, "bb_max": None, "bb_min": None})
    return row


def _hhmm(local_ms) -> str | None:
    if local_ms is None:
        return None
    # Garmin's *Local timestamps are wall-clock time encoded as if it were UTC
    return datetime.fromtimestamp(int(local_ms) / 1000, tz=timezone.utc).strftime("%H:%M")


def sleep_date(rec: dict) -> str | None:
    return rec.get("calendarDate") or (rec.get("sleepNeed") or {}).get("calendarDate")


def apply_sleep(row: dict, rec: dict) -> None:
    if not rec.get("sleepTimeSeconds"):
        return                                 # untracked night: keep the nulls
    gmt, loc = rec.get("sleepStartTimestampGMT"), rec.get("sleepStartTimestampLocal")
    row.update({
        "sleep_overallSleepScore": ((rec.get("sleepScores") or {}).get("overall") or {}).get("value"),
        # the connector's duration counts unmeasurable seconds as sleep; match it so the
        # trend history stays one series
        "sleep_durationInSeconds": rec["sleepTimeSeconds"] + (rec.get("unmeasurableSleepSeconds") or 0),
        "sleep_deepSleepDurationInSeconds": rec.get("deepSleepSeconds"),
        "sleep_lightSleepDurationInSeconds": rec.get("lightSleepSeconds"),
        "sleep_remSleepInSeconds": rec.get("remSleepSeconds"),
        "sleep_awakeDurationInSeconds": rec.get("awakeSleepSeconds"),
        "sleep_startTimeInSeconds": int(gmt) // 1000 if gmt is not None else None,
        "sleep_startTimeOffsetInSeconds": (int(loc) - int(gmt)) // 1000 if None not in (gmt, loc) else None,
        "sleep_bedLocal": _hhmm(loc),
        "sleep_wakeLocal": _hhmm(rec.get("sleepEndTimestampLocal")),
    })


def apply_hrv(row: dict, rec: dict) -> None:
    row.update({"hrv_lastNightAvg": rec.get("lastNightAvg"), "hrv_weeklyAvg": rec.get("weeklyAvg"),
                "hrv_status": rec.get("status")})


def apply_summary(row: dict, rec: dict) -> None:
    hr, st = rec.get("heartRate") or {}, rec.get("stress") or {}
    cal, bb = rec.get("calories") or {}, rec.get("bodyBattery") or {}
    row.update({"daily_restingHeartRateInBeatsPerMinute": hr.get("restingValue"),
                "daily_averageStressLevel": st.get("avgLevel"),
                "daily_bmrKilocalories": cal.get("burnedResting"),
                "daily_activeKilocalories": cal.get("burnedActive"),
                "bb_charged": bb.get("chargedValue"), "bb_drained": bb.get("drainedValue"),
                "bb_max": bb.get("maxValue"), "bb_min": bb.get("minValue")})


def build_rows(start: date, end: date, sleep: list, hrv: list, summaries: list) -> dict:
    rows = {}
    d = start
    while d <= end:
        rows[d.isoformat()] = empty_row(d.isoformat())
        d += timedelta(days=1)
    for rec in sleep:
        k = sleep_date(rec)
        if k in rows:
            apply_sleep(rows[k], rec)
    for rec in hrv:
        if rec.get("calendarDate") in rows:
            apply_hrv(rows[rec["calendarDate"]], rec)
    for rec in summaries:
        if rec.get("calendarDate") in rows:
            apply_summary(rows[rec["calendarDate"]], rec)
    for row in rows.values():
        if not row["sleep_durationInSeconds"]:
            row["hrv_lastNightAvg"] = None     # untracked night: §1d rule 2 keeps hrv null
    return rows


def fetch_window(client: Client, start: date, end: date) -> dict:
    sleep, hrv, summaries = [], [], []
    for a, b in chunks(start, end):
        sa, sb = a.isoformat(), b.isoformat()
        sleep += client.get("/sleep-service/sleep/dailySleepSummariesByDate",
                            {"startDate": sa, "endDate": sb}) or []
        hrv += (client.get(f"/hrv-service/hrv/daily/{sa}/{sb}") or {}).get("hrvSummaries") or []
        summaries += (client.get("/usersummary-service/v2/dailysummaries",
                                 {"startDate": sa, "endDate": sb}) or {}).get("data") or []
    return build_rows(start, end, sleep, hrv, summaries)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def merge(rows: dict) -> dict:
    try:
        cur = json.loads(OUT_FILE.read_text(encoding="utf-8"))
        days = cur.get("days") or {}
    except (OSError, ValueError):
        days = {}
    days.update(rows)
    out = {"meta": {"source": "Garmin Personal API", "fetchedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "dateKey": "Garmin calendarDate (wake date)"},
           "days": {k: days[k] for k in sorted(days)}}
    write_private(OUT_FILE, json.dumps(out, ensure_ascii=False, indent=1))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=8, help="window ending today (default 8, per REFRESH.md §1)")
    ap.add_argument("--since", help="window start YYYY-MM-DD (overrides --days)")
    ap.add_argument("--json", action="store_true", help="print the window rows as JSON on stdout")
    a = ap.parse_args(argv)

    end = date.today()
    start = date.fromisoformat(a.since) if a.since else end - timedelta(days=max(1, a.days) - 1)
    try:
        client = Client()
        rows = fetch_window(client, start, end)
    except AuthError as e:
        print(f"garmin_sync: auth: {e}", file=sys.stderr)
        return 2
    except FetchError as e:
        print(f"garmin_sync: {e}", file=sys.stderr)
        return 1
    merge(rows)

    today = rows[end.isoformat()]
    slept = sum(1 for r in rows.values() if r["sleep_durationInSeconds"])
    if a.json:
        print(json.dumps(list(rows.values()), ensure_ascii=False, indent=1))
    print(f"garmin_sync: window={start}..{end} days={len(rows)} nights={slept} calls={client.calls} "
          f"today_sleep={'yes' if today['sleep_durationInSeconds'] else 'no'} out={OUT_FILE}",
          file=sys.stderr if a.json else sys.stdout)
    return 0 if today["sleep_durationInSeconds"] else 3


if __name__ == "__main__":
    sys.exit(main())
