#!/usr/bin/env python3
"""hevy_fetch.py - fill the raw Hevy cache straight from the Hevy API (no model in the loop).

    python tools/hevy_fetch.py [--days N | --all] [--since YYYY-MM-DD]

Reads workouts from GET /v1/workouts (newest -> oldest, page size 10) until a page
is entirely older than the window, plus GET /v1/workouts/events?since=... so that
edited old workouts are refreshed and deleted workouts are retired.

Each workout is stored verbatim (compact JSON, the API's own shape) as
    <CACHE>/strength/raw/hevy/<start_time date>_<id>.json

  * no file for the id           -> written                       (counted "new")
  * file has an older updated_at -> replaced                      (counted "updated");
      if start_time changed, the old copy is kept next to it as <name>__superseded.json
      (build_strength.py's duplicate-id rule uses both copies)
  * same / newer updated_at      -> untouched                     (counted "unchanged")
  * "deleted" event              -> all copies of the id are moved to hevy/_deleted/

Idempotent. Prints counts only. Python stdlib only. The API key is read from
<CACHE>/secrets/hevy.env (HEVY_API_KEY=...) and is never printed.
"""
from __future__ import annotations

import argparse
import glob
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
HEVY_ENV = CACHE_ROOT / "secrets" / "hevy.env"
HEVY_DIR = CACHE_ROOT / "strength" / "raw" / "hevy"
HEVY_API = "https://api.hevyapp.com/v1"
PAGE_SIZE = 10          # API maximum for workouts + events
SUPERSEDED = "__superseded"
USER_AGENT = "daily-dashboard-hevy-fetch/1.0"


class FetchError(Exception):
    pass


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def load_key() -> str:
    if not HEVY_ENV.exists():
        raise FetchError(f"missing {HEVY_ENV} (needs HEVY_API_KEY=...)")
    for line in HEVY_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("HEVY_API_KEY="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v and not v.startswith("PASTE_"):
                return v
    raise FetchError(f"no usable HEVY_API_KEY in {HEVY_ENV}")


def parse_ts(s: str) -> datetime:
    dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def api_get(key: str, path: str, params: dict) -> dict:
    url = f"{HEVY_API}{path}?{urllib.parse.urlencode(params)}"
    last = "unknown"
    for attempt in range(6):
        req = urllib.request.Request(url, headers={"api-key": key, "accept": "application/json",
                                                   "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 429 or e.code >= 500:
                try:
                    wait = int(e.headers.get("Retry-After") or 0)
                except (TypeError, ValueError):
                    wait = 0
                time.sleep(max(wait, 2 * (attempt + 1)))
                continue
            raise FetchError(f"{path}: {last}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            last = f"network error ({type(e).__name__})"
            time.sleep(2 * (attempt + 1))
    raise FetchError(f"{path}: gave up after retries ({last})")


def dump(w: dict) -> str:
    return json.dumps(w, ensure_ascii=False, separators=(",", ":"))


def write_text(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# cache
# --------------------------------------------------------------------------- #

def index_cache(hevy_dir: Path) -> dict[str, list[dict]]:
    """id -> [{path, updated_at, start_time}] for every readable *.json in hevy_dir."""
    by_id: dict[str, list[dict]] = {}
    for f in sorted(glob.glob(str(hevy_dir / "*.json"))):
        try:
            d = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict) or not d.get("id"):
            continue
        by_id.setdefault(d["id"], []).append(
            {"path": Path(f), "updated_at": d.get("updated_at") or "", "start_time": d.get("start_time") or ""})
    return by_id


def _unique_superseded(path: Path) -> Path:
    cand = path.with_name(path.stem + SUPERSEDED + path.suffix)
    n = 2
    while cand.exists():
        cand = path.with_name(f"{path.stem}{SUPERSEDED}{n}{path.suffix}")
        n += 1
    return cand


def save_workout(hevy_dir: Path, by_id: dict, w: dict) -> str:
    """Store one workout; returns 'new' | 'updated' | 'unchanged'."""
    wid = w["id"]
    name = f"{str(w['start_time'])[:10]}_{wid}.json"
    copies = by_id.get(wid, [])
    if not copies:
        write_text(hevy_dir / name, dump(w))
        by_id[wid] = [{"path": hevy_dir / name, "updated_at": w.get("updated_at") or "",
                       "start_time": w["start_time"]}]
        return "new"
    newest = max(parse_ts(c["updated_at"]) if c["updated_at"] else datetime.min.replace(tzinfo=timezone.utc)
                 for c in copies)
    if not w.get("updated_at") or parse_ts(w["updated_at"]) <= newest:
        return "unchanged"
    mains = [c for c in copies if SUPERSEDED not in c["path"].name]
    main = max(mains, key=lambda c: c["updated_at"]) if mains else None
    if main is not None and main["start_time"] != w["start_time"]:
        os.replace(main["path"], _unique_superseded(main["path"]))   # keep old times for HR matching
    elif main is not None and main["path"].name != name:
        main["path"].unlink()
    write_text(hevy_dir / name, dump(w))
    by_id.clear()
    by_id.update(index_cache(hevy_dir))
    return "updated"


def retire(hevy_dir: Path, by_id: dict, wid: str) -> int:
    copies = by_id.get(wid, [])
    if not copies:
        return 0
    dest = hevy_dir / "_deleted"
    dest.mkdir(parents=True, exist_ok=True)
    for c in copies:
        os.replace(c["path"], dest / c["path"].name)
    by_id.pop(wid, None)
    return 1


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Fetch Hevy workouts into the raw strength cache.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--days", type=int, default=None, help="window in days (default 14)")
    g.add_argument("--all", action="store_true", help="fetch the full history")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="window start (overrides --days)")
    args = ap.parse_args(argv)

    if args.all:
        since = None
    elif args.since:
        since = datetime.combine(date.fromisoformat(args.since), datetime.min.time(), timezone.utc)
    else:
        since = datetime.now(timezone.utc) - timedelta(days=args.days if args.days is not None else 14)

    try:
        key = load_key()
        HEVY_DIR.mkdir(parents=True, exist_ok=True)
        by_id = index_cache(HEVY_DIR)
        counts = {"new": 0, "updated": 0, "unchanged": 0}
        live_ids: set[str] = set()

        # 1) workouts, newest -> oldest
        page = pages = 0
        while True:
            page += 1
            d = api_get(key, "/workouts", {"page": page, "pageSize": PAGE_SIZE})
            pages += 1
            ws = d.get("workouts") or []
            for w in ws:
                live_ids.add(w["id"])
                if since is None or parse_ts(w["start_time"]) >= since:
                    counts[save_workout(HEVY_DIR, by_id, w)] += 1
            if not ws or page >= int(d.get("page_count") or page):
                break
            if since is not None and all(parse_ts(w["start_time"]) < since for w in ws):
                break

        # 2) events: refresh edited workouts, retire deleted ones
        ev_since = since if since is not None else datetime(1970, 1, 1, tzinfo=timezone.utc)
        updated_ev: dict[str, dict] = {}
        deleted_ev: set[str] = set()
        page = ev_pages = 0
        while True:
            page += 1
            d = api_get(key, "/workouts/events",
                        {"page": page, "pageSize": PAGE_SIZE,
                         "since": ev_since.strftime("%Y-%m-%dT%H:%M:%SZ")})
            ev_pages += 1
            for ev in d.get("events") or []:
                if ev.get("type") == "deleted":
                    wid = ev.get("id") or (ev.get("workout") or {}).get("id")
                    if wid:
                        deleted_ev.add(wid)
                elif ev.get("type") == "updated" and ev.get("workout"):
                    w = ev["workout"]
                    prev = updated_ev.get(w["id"])
                    if prev is None or parse_ts(w["updated_at"]) > parse_ts(prev["updated_at"]):
                        updated_ev[w["id"]] = w
            if page >= int(d.get("page_count") or page) or not (d.get("events") or []):
                break
        ev_saved = 0
        for wid, w in updated_ev.items():
            if wid in deleted_ev or wid in live_ids:
                continue                      # live workouts were handled by the list above
            res = save_workout(HEVY_DIR, by_id, w)
            if res != "unchanged":
                counts[res] += 1
                ev_saved += 1
        deleted = sum(retire(HEVY_DIR, by_id, wid) for wid in deleted_ev if wid not in live_ids)
    except FetchError as e:
        print(f"hevy_fetch: {e}")
        return 1

    window = "all" if since is None else f"since {since:%Y-%m-%d}"
    print(f"hevy_fetch: window={window} pages={pages} event_pages={ev_pages} "
          f"new={counts['new']} updated={counts['updated']} unchanged={counts['unchanged']} "
          f"from_events={ev_saved} deleted={deleted} cached_ids={len(by_id)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
