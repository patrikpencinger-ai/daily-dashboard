#!/usr/bin/env python3
"""build_dashboard.py - the deterministic part of the morning refresh, without the connector.

    python tools/build_dashboard.py [--date YYYY-MM-DD] [--repo DIR] [--facts PATH] [--dry-run]
                                    [--record DIR | --replay DIR]

Writes every NUMBER and every formulaic label of sleep-data.json and training-data.json
(conventions: .foreman/scratch/conventions.md + REFRESH.md), from
    Garmin Personal API    sleep / HRV / daily summaries (via garmin_sync.fetch_window),
                           activities, per-day usersummary + dailyHeartRate (rest-day HR)
    Hevy raw cache         <CACHE>/strength/raw/hevy/*.json (hevy_fetch.py)
    Open-Meteo archive     gym/swim air tmax/tmin (failure -> null + warning)
    strength-data.json     mld per-set peaks (build_strength.py must have run first)
    data.json              food-log days (energy.eint, burn, bridge)
Free narrative (rec, i1t..i4, eNote, bNote, wNote, training today, c5d) is left byte-identical;
the agent writes it from the facts file:
    <CACHE>/garmin/facts-<date>.json   (--facts PATH overrides)

Append-only blocks (trend, gym, swim, mld) get every missing row since the last stored one
(backfill after a gap); the 7-day blocks are rebuilt. Existing rows are never rewritten, with one
exception (LEAD D14): a gym row of the last 7 days whose vol is null (appended before Hevy synced) is
completed (t, lift, vol, sets, reps, top) once the Hevy workout is cached, and its mld row added.
gym[].volWork belongs to build_strength.py, which runs again after this script.

--record DIR saves every network response (and the Hevy files used) under DIR;
--replay DIR reads only those files, so a run is reproducible offline.

Exit codes (nothing is written unless the exit is 0; --dry-run writes the facts file only):
    0  written
    1  network / API error (Garmin; --replay: recording missing)
    2  Garmin key/auth problem
    3  no Garmin sleep record for --date yet (watch not synced)
    4  sleep-data.json meta.snapshot is already --date
    5  local input problem (missing/invalid repo JSON, strength-data.json, Hevy cache, or --date
       earlier than sleep-data.json meta.snapshot)
    6  internal error (a bug in this script; traceback on stderr) -> the routine falls back to the
       connector like exit 1, and reports it as a build_dashboard bug
Python stdlib only, 3.9+ syntax. The Garmin key and token are never printed.
"""
from __future__ import annotations

import argparse
import copy
import glob
import http.client
import json
import os
import re
import shutil
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_DOWN, ROUND_HALF_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import garmin_sync as GS  # noqa: E402

CACHE_ROOT = GS.CACHE_ROOT
HEVY_DIR = CACHE_ROOT / "strength" / "raw" / "hevy"
FACTS_DIR = CACHE_ROOT / "garmin"
REPO = Path(__file__).resolve().parent.parent
SUPERSEDED = "__superseded"

ACT_PATH = "/activitylist-service/activities/search/activities"
USERSUMMARY_PATH = "/usersummary-service/usersummary/daily"
DAILY_HR_PATH = "/wellness-service/wellness/dailyHeartRate"
ACT_PAGE = 50
METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
METEO_LAT, METEO_LON = 45.815, 15.982
USER_AGENT = "daily-dashboard-build/1.0"

EXIT_OK, EXIT_NET, EXIT_AUTH, EXIT_NOSLEEP, EXIT_DONE, EXIT_LOCAL, EXIT_BUG = 0, 1, 2, 3, 4, 5, 6

BMR_DEFAULT = 2414
INTAKE_PLACEHOLDER = 2000
EFFORT_RHR, EFFORT_MAX = 53, 174
SRC_SLEEP = {"en": "Garmin fenix 8 via the Garmin Connect API", "hr": "Garmin fenix 8 putem Garmin Connect API-ja"}
SRC_TRAIN = {"en": "Garmin fenix 8 via the Garmin Connect API + Hevy",
             "hr": "Garmin fenix 8 putem Garmin Connect API-ja + Hevy"}

EN_WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
HR_WD = ["Pon", "Uto", "Sri", "Čet", "Pet", "Sub", "Ned"]
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MINUS = "−"

LIFT_DAY = {"hack": "Hack squat day — hack squat + accessories",
            "front": "Front squat day — front squat + accessories",
            "bbdl": "Deadlift day — barbell deadlift + accessories"}
MAIN_EX = {"hack": "hack squat", "front": "front squat", "bbdl": "deadlift (barbell)", "trap": "trap bar",
           "goblet": "goblet squat", "squat": "squat (barbell)"}
LIFT_NAME = {"en": {"hack": "hack squat", "front": "front squat", "bbdl": "barbell deadlift",
                    "trap": "trap bar deadlift", "goblet": "goblet squat", "squat": "back squat"},
             "hr": {"hack": "hack čučanj", "front": "prednji čučanj", "bbdl": "mrtvo dizanje sa šipkom",
                    "trap": "mrtvo dizanje s trap šipkom", "goblet": "goblet čučanj", "squat": "stražnji čučanj"}}
KIND = {"strength_training": "str", "lap_swimming": "pool", "open_water_swimming": "ows",
        "walking": "walk", "hiking": "hike", "squash": "squash"}
SWIM_TYPES = ("lap_swimming", "open_water_swimming")


class LocalInputError(Exception):
    pass


# --------------------------------------------------------------------------- #
# rounding and formatting
# --------------------------------------------------------------------------- #

def rhu(x, nd: int = 0):
    """Round half up (JS Math.round semantics: ties toward +infinity); int when nd == 0."""
    if x is None:
        return None
    v = Decimal(repr(x)) if isinstance(x, float) else Decimal(x)
    q = Decimal(1).scaleb(-nd)
    r = v.quantize(q, rounding=ROUND_HALF_UP) if v >= 0 else -((-v).quantize(q, rounding=ROUND_HALF_DOWN))
    if nd == 0:
        return int(r)
    f = float(r)
    return 0.0 if f == 0 else f


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def sg(v) -> str:
    return "±0" if v == 0 else ("+" if v > 0 else MINUS) + str(abs(v))


def hm(minutes: int) -> str:                    # "6h 20m"
    return f"{minutes // 60}h {minutes % 60:02d}m"


def hm_compact(minutes: int) -> str:            # "6h20"
    return f"{minutes // 60}h{minutes % 60:02d}"


def short_dur(minutes: int) -> str:             # "55m" | "1h 01m"
    return f"{minutes}m" if minutes < 60 else hm(minutes)


def signed_dur(d: int) -> str:                  # "−37m" | "+1h 05m"
    sign = "+" if d >= 0 else MINUS
    a = abs(d)
    return f"{sign}{a}m" if a < 60 else f"{sign}{a // 60}h {a % 60:02d}m"


def thou(n, lang: str = "en") -> str:
    s = f"{int(n):,}"
    return s.replace(",", ".") if lang == "hr" else s


def num(x, lang: str = "en") -> str:            # 180 -> "180", 92.5 -> "92.5" / "92,5"
    s = str(int(x)) if float(x).is_integer() else repr(float(x))
    return s.replace(".", ",") if lang == "hr" else s


def lbl(d: date) -> str:                        # "Nov 14"
    return f"{MON[d.month - 1]} {d.day}"


def hr_dm(d: date) -> str:                      # "14.11."
    return f"{d.day}.{d.month}."


def hr_date(d: date) -> str:                    # "14.11.2026."
    return f"{d.day}.{d.month}.{d.year}."


def wd(d: date, lang: str) -> str:
    return (EN_WD if lang == "en" else HR_WD)[d.weekday()]


def wdl(d: date, lang: str) -> str:             # footer/today form: EN "Fri", HR "pet"
    return wd(d, lang) if lang == "en" else wd(d, lang).lower()


def day_full(d: date, lang: str) -> str:
    return f"{wd(d, lang)} {d.day}"


def day_short(d: date, lang: str) -> str:
    return f"{wd(d, lang)[0]}{d.day}"


def hr_plural(n: int, one: str, few: str, many: str) -> str:
    """Croatian noun form after a number: 1 -> one, 2-4 -> few, 0 / 5+ / 11-14 -> many
    (21, 31 ... -> one and 22-24 ... -> few, as Croatian grammar has it)."""
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def hr_count(n: int, one: str, few: str, many: str) -> str:   # "1 trening", "2 treninga", "5 treninga"
    return f"{n} {hr_plural(n, one, few, many)}"


def D(s: str) -> date:
    return date.fromisoformat(s[:10])


def clock_dec(hhmm: str, bed: bool) -> float:
    h, m = (int(x) for x in hhmm.split(":"))
    return rhu(((h - 24) if (bed and h >= 12) else h) + m / 60, 2)


def bump_version(v: str) -> str:
    m = re.fullmatch(r"v(\d+)\.(\d{2})(-auto)?", v or "")
    if not m:
        return v
    n = int(m.group(1)) * 100 + int(m.group(2)) + 1
    return f"v{n // 100}.{n % 100:02d}{m.group(3) or ''}"


def update_in_place(target: dict, new: dict) -> None:
    """Assign keys without disturbing the existing key order (new keys go last)."""
    for k, v in new.items():
        target[k] = v


# --------------------------------------------------------------------------- #
# network: Garmin (via garmin_sync.Client), Open-Meteo; record / replay
# --------------------------------------------------------------------------- #

def slug(path: str, params: dict | None) -> str:
    s = path.strip("/").replace("/", "_")
    if params:
        s += "__" + "_".join(f"{k}={params[k]}" for k in sorted(params))
    return re.sub(r"[^A-Za-z0-9_=.\-]", "-", s) + ".json"


class Fetcher:
    """Duck-types garmin_sync.Client.get so garmin_sync.fetch_window can use it."""

    def __init__(self, record: str | None = None, replay: str | None = None) -> None:
        self.record = Path(record) if record else None
        self.replay = Path(replay) if replay else None
        self._client = None
        self.calls = 0

    def _save(self, sub: str, name: str, data) -> None:
        if self.record:
            p = self.record / sub / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def get(self, path: str, params: dict | None = None):
        name = slug(path, params)
        if self.replay:
            p = self.replay / "garmin" / name
            if not p.exists():
                raise GS.FetchError(f"replay: no recording {p.name}")
            return json.loads(p.read_text(encoding="utf-8"))
        if self._client is None:
            self._client = GS.Client()
        data = self._client.get(path, params)
        self.calls += 1
        self._save("garmin", name, data)
        return data

    def weather(self, start: date, end: date):
        """-> ({iso: (tmax, tmin)}, warning or None). Never raises."""
        params = {"latitude": METEO_LAT, "longitude": METEO_LON, "start_date": start.isoformat(),
                  "end_date": end.isoformat(), "daily": "temperature_2m_max,temperature_2m_min",
                  "timezone": "Europe/Zagreb"}
        name = slug("archive", {"start_date": params["start_date"], "end_date": params["end_date"]})
        data, err = None, None
        if self.replay:
            p = self.replay / "openmeteo" / name
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
            else:
                err = "replay: no Open-Meteo recording"
        else:
            url = METEO_URL + "?" + urllib.parse.urlencode(params)
            for attempt in range(3):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                    with urllib.request.urlopen(req, timeout=30) as r:
                        data = json.loads(r.read().decode("utf-8"))
                    err = None
                    break
                except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ValueError,
                        OSError) as e:
                    err = f"Open-Meteo: {type(e).__name__} {getattr(e, 'code', '')}".strip()
                    time.sleep(2 * (attempt + 1))
            self._save("openmeteo", name, data if data is not None else {"__error__": err})
        if isinstance(data, dict) and "__error__" in data:
            err, data = data["__error__"], None
        out = {}
        try:
            dl = (data or {}).get("daily") or {}
            for d, hi, lo in zip(dl.get("time") or [], dl.get("temperature_2m_max") or [],
                                 dl.get("temperature_2m_min") or []):
                out[d] = (rhu(hi, 1) if hi is not None else None, rhu(lo, 1) if lo is not None else None)
        except (TypeError, ValueError):
            err = err or "Open-Meteo: unexpected response shape"
        if data is None and err is None:
            err = "Open-Meteo: empty response"
        return out, (f"{err} for {start}..{end}: tmax/tmin null" if err else None)


def fetch_activities(f: Fetcher, start: date, end: date) -> list:
    """Every activity whose local start date is in [start, end], ascending by start time."""
    out, i = [], 0
    while True:
        page = f.get(ACT_PATH, {"start": i, "limit": ACT_PAGE}) or []
        out += page
        if len(page) < ACT_PAGE or not page or D(page[-1].get("startTimeLocal") or "1970-01-01") < start:
            break
        i += ACT_PAGE
    keep = [a for a in out if a.get("startTimeLocal") and start <= D(a["startTimeLocal"]) <= end]
    seen, uniq = set(), []
    for a in keep:                               # paging can repeat a row if a new one arrives mid-run
        k = a.get("activityId") or (a.get("startTimeGMT"), a.get("activityName"))
        if k not in seen:
            seen.add(k)
            uniq.append(a)
    return sorted(uniq, key=lambda a: a.get("startTimeGMT") or a["startTimeLocal"])


def fetch_daily_hr(f: Fetcher, d: date):
    """Rest-day daily HR (LEAD D1): (usersummary maxHeartRate, rhu(mean(dailyHeartRate samples)))."""
    us = f.get(USERSUMMARY_PATH, {"calendarDate": d.isoformat()}) or {}
    hr = f.get(DAILY_HR_PATH, {"date": d.isoformat()}) or {}
    vals = [v[1] for v in (hr.get("heartRateValues") or []) if isinstance(v, (list, tuple))
            and len(v) > 1 and v[1] is not None]
    return us.get("maxHeartRate"), (rhu(sum(vals) / len(vals)) if vals else None)


# --------------------------------------------------------------------------- #
# local inputs
# --------------------------------------------------------------------------- #

def load_json(path: Path, what: str):
    if not path.exists():
        raise LocalInputError(f"missing {what}: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise LocalInputError(f"invalid {what} {path}: {type(e).__name__}") from None


def dump_json(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def write_text(path: Path, text: str) -> None:
    write_all([(path, text)])


def write_all(items: list) -> None:
    """Stage every file as .tmp first, then swap them in order. A failure while staging leaves
    the targets untouched; put sleep-data.json LAST so a half-finished swap still fails the
    snapshot gate and the next run rebuilds both files."""
    tmps = []
    try:
        for path, text in items:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmps.append((tmp, path))           # before open, so a failed write is cleaned up too
            with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
        for tmp, path in tmps:
            os.replace(tmp, path)
    finally:
        for tmp, _ in tmps:
            if tmp.exists():
                tmp.unlink()


def hevy_local_date(w: dict) -> str | None:
    st = w.get("start_time")
    if not st:
        return None
    dt = datetime.fromisoformat(str(st).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return GS.to_local(dt).date().isoformat()     # LEAD D12 (A13): local Zagreb date


def load_hevy(hevy_dir: Path) -> dict:
    """{local date: [workout, ...]} sorted by start_time; workouts carry '_file'."""
    if not hevy_dir.is_dir():
        raise LocalInputError(f"missing Hevy cache {hevy_dir} (run tools/hevy_fetch.py)")
    out = {}
    for fn in sorted(glob.glob(str(hevy_dir / "*.json"))):
        if SUPERSEDED in os.path.basename(fn):
            continue
        try:
            w = json.loads(Path(fn).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise LocalInputError(f"invalid Hevy file {fn}: {type(e).__name__}") from None
        if not isinstance(w, dict) or not w.get("start_time"):
            raise LocalInputError(f"invalid Hevy file {fn}: no start_time")
        w["_file"] = fn
        out.setdefault(hevy_local_date(w), []).append(w)
    for v in out.values():
        v.sort(key=lambda w: w["start_time"])
    return out


# --------------------------------------------------------------------------- #
# activities -> session values
# --------------------------------------------------------------------------- #

def clean_name(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").replace(" ", " ")).strip()


def kind_of(a: dict) -> str:
    tk = ((a.get("activityType") or {}).get("typeKey") or "").lower()
    if tk in KIND:
        return KIND[tk]
    if "swim" in tk or "paddl" in tk or "kayak" in tk or "row" == tk:
        return "water"
    return "other"


def lift_of(title: str) -> str:
    t = (title or "").lower()
    if "hack" in t:
        return "hack"
    if "front" in t:
        return "front"
    if ("dead lift" in t or "deadlift" in t) and "trap" not in t:
        return "bbdl"
    if "trap" in t:
        return "trap"
    if "goblet" in t:
        return "goblet"
    if "squat" in t:
        return "squat"
    return "other"


def hevy_stats(w: dict | None, lift: str):
    """(vol, sets, reps, top) over ALL sets incl. warm-ups; top of the main compound."""
    if not w:
        return None, None, None, None
    allsets = [s for e in w.get("exercises") or [] for s in e.get("sets") or []]
    vol = rhu(sum((s.get("weight_kg") or 0) * (s.get("reps") or 0) for s in allsets))
    top = None
    if lift in MAIN_EX:
        main = [s for e in w.get("exercises") or [] if MAIN_EX[lift] in (e.get("title") or "").lower()
                for s in e.get("sets") or []]
        if main:
            b = max(main, key=lambda s: ((s.get("weight_kg") or 0), (s.get("reps") or 0)))
            wkg = b.get("weight_kg") or 0
            top = {"w": int(wkg) if float(wkg).is_integer() else wkg, "reps": b.get("reps")}
    return vol, len(allsets), sum(s.get("reps") or 0 for s in allsets), top


def match_hevy(acts: list, hevy: dict) -> dict:
    """activity index -> Hevy workout, per local date, nearest start time, each used once."""
    out = {}
    by_day = {}
    for i, a in enumerate(acts):
        if kind_of(a) == "str":
            by_day.setdefault(a["startTimeLocal"][:10], []).append(i)
    for d, idxs in by_day.items():
        pool = list(hevy.get(d) or [])
        for i in idxs:
            if not pool:
                break
            a0 = acts[i].get("startTimeGMT")
            if a0:
                t0 = datetime.fromisoformat(a0.replace(" ", "T")).replace(tzinfo=timezone.utc)

                def gap(w, t0=t0):
                    t = datetime.fromisoformat(str(w["start_time"]).replace("Z", "+00:00"))
                    return abs((t - t0).total_seconds())
                best = min(pool, key=gap)
            else:
                best = pool[0]
            pool.remove(best)
            out[i] = best
    return out


def swim_set(name: str) -> str:
    """Pool activity name -> set label: '2200m 10x100 10x50' -> '10×100 + 10×50'."""
    toks = [t for t in clean_name(name).split() if not re.fullmatch(r"\d+(\.\d+)?k?m", t, re.I)
            and not re.fullmatch(r"v\d+", t, re.I) and t != "+"]
    return " + ".join(re.sub(r"(?<=\w)[xX](?=\d)", "×", t) for t in toks)


def place_of(name: str, words) -> str:
    n = clean_name(name)
    for w in words:
        if n.lower().endswith(w.lower()):
            return n[: -len(w)].strip()
    return n


def gym_row(a: dict, w: dict | None) -> dict:
    d = D(a["startTimeLocal"])
    title = clean_name(w.get("title")) if w else clean_name(a.get("activityName"))
    lift = lift_of(title)
    vol, sets, reps, top = hevy_stats(w, lift)
    return {"d": d.isoformat(), "l": lbl(d), "t": title, "vol": vol, "sets": sets, "reps": reps,
            "mx": rhu(a.get("maxHR")), "av": rhu(a.get("averageHR")), "tmax": None, "tmin": None,
            "dur": rhu((a.get("duration") or 0) / 60), "kcal": rhu(a.get("calories")), "lift": lift,
            "top": top if lift != "other" else None}


def swim_row(a: dict) -> dict:
    d = D(a["startTimeLocal"])
    spd = a.get("averageSpeed")
    sec = rhu(100 / spd) if spd else None
    if sec is not None and not 60 <= sec <= 300:
        sec = None
    return {"d": d.isoformat(), "l": lbl(d), "t": clean_name(a.get("activityName")),
            "dist": rhu(a.get("distance")), "sec100": sec,
            "pace": f"{sec // 60}:{sec % 60:02d}" if sec is not None else None,
            "mx": rhu(a.get("maxHR")), "av": rhu(a.get("averageHR")),
            "lengths": a.get("activeLengths"), "spm": rhu(a.get("averageSwimCadenceInStrokesPerMinute")),
            "tmax": None, "tmin": None, "dur": rhu((a.get("duration") or 0) / 60), "kcal": rhu(a.get("calories"))}


def new_sessions(train: dict, acts: list, hevy_match: dict, date_to: date):
    """Gym + swim rows not yet in the file, dated >= the last stored row (backfill)."""
    num_ = train["num"]
    gym, swim = num_.get("gym") or [], num_.get("swim") or []
    g_last = gym[-1]["d"] if gym else "0000-00-00"
    s_last = swim[-1]["d"] if swim else "0000-00-00"
    new_g, new_s = [], []
    for i, a in enumerate(acts):
        d = a["startTimeLocal"][:10]
        if d > date_to.isoformat():
            continue
        tk = (a.get("activityType") or {}).get("typeKey")
        if tk == "strength_training" and d >= g_last:
            r = gym_row(a, hevy_match.get(i))
            names = {r["t"], clean_name(a.get("activityName"))}
            if any(x["d"] == d and x.get("dur") == r["dur"] and x.get("t") in names for x in gym + new_g):
                continue
            new_g.append(r)
        elif tk in SWIM_TYPES and d >= s_last:
            r = swim_row(a)
            key = (r["d"], r["t"], r["dist"], r["dur"])
            if any((x["d"], x.get("t"), x.get("dist"), x.get("dur")) == key for x in swim + new_s):
                continue
            new_s.append(r)
    return new_g, new_s


def fill_hevy_lag(gym: list, acts: list, hevy_match: dict, today: date) -> list:
    """LEAD D14: a gym row dated within the last 7 days whose vol is null was appended before Hevy
    synced. Once the Hevy cache has that workout, set t (Hevy title), lift (rule ladder on it), vol,
    sets, reps and top, in place (key order kept). Rows whose vol is non-null are never touched."""
    filled = []
    lo = today - timedelta(days=6)
    used = set()
    for r in gym:
        if r.get("vol") is not None or not lo <= D(r["d"]) <= today:
            continue
        w = None
        for i, a in enumerate(acts):
            if (i not in used and a["startTimeLocal"][:10] == r["d"] and kind_of(a) == "str" and i in hevy_match
                    and rhu((a.get("duration") or 0) / 60) == r.get("dur")):
                w = hevy_match[i]
                used.add(i)
                break
        if not w:
            continue
        title = clean_name(w.get("title"))
        lift = lift_of(title)
        vol, sets, reps, top = hevy_stats(w, lift)
        old = {k: r.get(k) for k in ("t", "lift", "vol", "sets", "reps", "top")}
        r.update({"t": title, "lift": lift, "vol": vol, "sets": sets, "reps": reps,
                  "top": top if lift != "other" else None})
        filled.append({"d": r["d"], "t": title, "lift": lift,
                       "fields": [k for k in old if old[k] != r[k]], "was": old})
    return filled


def apply_temps(rows: list, temps: dict) -> None:
    for r in rows:
        r["tmax"], r["tmin"] = temps.get(r["d"], (None, None))


def strength_workouts(strength: dict) -> dict:
    out = {}
    for w in strength.get("workouts") or []:
        if isinstance(w, dict) and w.get("date"):
            out.setdefault(w["date"], []).append(w)
    return out


def mld_rows(train: dict, all_gym: list, strength: dict, today: date, warnings: list,
             refilled=()) -> list:
    """New mld rows for lifts already in num.mld, from build_strength setRows (cf = 0, LEAD D9).

    Candidates: gym rows inside the last 28 days that are newer than the lift's last mld row, plus
    rows whose Hevy data was filled in this run (`refilled` dates, LEAD D14) when their date is absent.
    A retired lift's old sessions are never back-filled; a deferred row is picked up later."""
    mld = train["num"].get("mld") or {}
    sw = strength_workouts(strength)
    new = []
    for lift, arr in mld.items():
        if lift not in MAIN_EX:
            continue
        last = arr[-1]["d"] if arr else "0000-00-00"
        have = {x["d"] for x in arr}
        for g in all_gym:
            if g.get("lift") != lift or g["d"] in have or (g["d"] <= last and g["d"] not in refilled) \
                    or D(g["d"]) < today - timedelta(days=27) or D(g["d"]) > today:
                continue
            if not g.get("top"):
                warnings.append(f"mld.{lift} {g['d']}: no Hevy top set yet, row deferred")
                continue
            pk = None
            for wo in sw.get(g["d"]) or []:
                ix = [e.get("idx") for e in wo.get("exercises") or []
                      if MAIN_EX[lift] in (e.get("title") or "").lower()]
                if not ix:
                    continue
                pk = [rhu(r["peakHR"]) for r in wo.get("setRows") or []
                      if r.get("ex") == ix[0] and r.get("peakHR")]
                break
            if not pk:
                warnings.append(f"mld.{lift} {g['d']}: no per-set peaks in strength-data.json yet, row deferred")
                continue
            row = {"d": g["d"], "l": g["l"], "w": g["top"]["w"], "mx": g["mx"], "av": rhu(mean(pk)),
                   "dl": pk[-1] - pk[0], "pk": pk, "cf": 0}
            new.append((lift, row))
            have.add(g["d"])
    return new


# --------------------------------------------------------------------------- #
# sleep-data.json
# --------------------------------------------------------------------------- #

def tracked(r: dict | None) -> bool:
    return bool(r and r.get("sleep_durationInSeconds"))


def trend_row(d: str, r: dict) -> dict:
    t = tracked(r)
    h = lambda k: rhu(r[k] / 3600, 2) if t and r.get(k) is not None else None  # noqa: E731
    return {"d": d, "rhr": r.get("daily_restingHeartRateInBeatsPerMinute"),
            "hrv": r.get("hrv_lastNightAvg") if t else None,
            "score": r.get("sleep_overallSleepScore") if t else None,
            "durH": h("sleep_durationInSeconds"), "deepH": h("sleep_deepSleepDurationInSeconds"),
            "awakeMin": rhu(r["sleep_awakeDurationInSeconds"] / 60)
            if t and r.get("sleep_awakeDurationInSeconds") is not None else None}


def readiness(trend: list, score, hrv, rhr):
    """Stored readiness, fitted formula (LEAD D4; memory readiness-two-conventions).
    No HRV reading (or no HRV baseline) -> hN = 0.5 (neutral); same for RHR."""
    w = trend[-28:]
    hb, rb = mean([x.get("hrv") for x in w]), mean([x.get("rhr") for x in w])
    clamp = lambda v, a, b: max(a, min(b, v))  # noqa: E731
    sN = score / 100
    hN = (clamp(hrv / hb, 0.7, 1.3) - 0.7) / 0.6 if hrv is not None and hb else 0.5
    rN = (clamp(rb / rhr, 0.9, 1.1) - 0.9) / 0.2 if rhr and rb else 0.5
    return rhu(100 * (1.0981 * sN + 0.0269 * hN - 0.0181 * rN - 0.0794))


def band(score: int, lang: str) -> str:          # Garmin sleep-score band (c1d)
    i = 0 if score >= 90 else 1 if score >= 80 else 2 if score >= 60 else 3
    return (["excellent", "good", "fair", "poor"] if lang == "en" else ["izvrsna", "dobra", "osrednja", "loša"])[i]


def c5l(ready: int, lang: str) -> str:           # LEAD D5
    i = 0 if ready >= 88 else 1 if ready >= 80 else 2 if ready >= 60 else 3
    return (["Excellent", "Good", "Fair", "Poor"] if lang == "en" else ["Izvrsna", "Dobra", "Osrednja", "Loša"])[i]


def delta_clause(cur, prev, lang: str, what: str) -> str:
    """'+8 vs the last recorded night (38)'; zero -> '±0 vs ...' (history since 10-25, LEAD D12)."""
    ref = {("en", "night"): "the last recorded night", ("hr", "night"): "zadnja zabilježena noć",
           ("en", "avg"): "the 7-night avg", ("hr", "avg"): "prosjek 7 noći"}[(lang, what)]
    return f"{sg(cur - prev)} vs {ref} ({prev})"


def na(v, lang: str) -> str:
    return str(v) if v is not None else ("n/a" if lang == "en" else "n/d")


def hrv_clause(hv: list, avg, prev_ok: bool, lang: str) -> str:
    """c4d. A tracked night without an HRV summary -> 'no HRV reading' / 'nema HRV očitanja'."""
    if hv[-1] is None:
        return "no HRV reading" if lang == "en" else "nema HRV očitanja"
    parts = []
    prev = hv[-2] if prev_ok else hv[-1]
    if prev is not None:
        parts.append(delta_clause(hv[-1], prev, lang, "night"))
    if avg is not None:
        parts.append(delta_clause(hv[-1], avg, lang, "avg"))
    return " · ".join(parts)


def build_sleep(doc: dict, rows: dict, today: date, now_iso: str, warnings: list):
    s = copy.deepcopy(doc)
    n = s["num"]
    trend = n.setdefault("trend", [])
    have = {x["d"] for x in trend}
    last_d = D(trend[-1]["d"]) if trend else today - timedelta(days=1)
    appended = []
    d = last_d + timedelta(days=1)
    while d <= today:
        k = d.isoformat()
        if k not in have:
            if k in rows:
                trend.append(trend_row(k, rows[k]))
                appended.append(k)
            else:
                warnings.append(f"trend {k}: no Garmin row, not appended")
        d += timedelta(days=1)

    nights = sorted((D(k), r) for k, r in rows.items() if D(k) <= today and tracked(r))[-7:]
    if len(nights) < 7:
        warnings.append(f"only {len(nights)} recorded nights in the Garmin window")
    H = lambda x: rhu((x or 0) / 3600, 2)  # noqa: E731
    wk = n["week"]
    update_in_place(wk, {
        "deep": [H(r["sleep_deepSleepDurationInSeconds"]) for _, r in nights],
        "light": [H(r["sleep_lightSleepDurationInSeconds"]) for _, r in nights],
        "rem": [H(r["sleep_remSleepInSeconds"]) for _, r in nights],
        "awake": [H(r["sleep_awakeDurationInSeconds"]) for _, r in nights],
        "scores": [r["sleep_overallSleepScore"] for _, r in nights],
        "hrv": [r["hrv_lastNightAvg"] for _, r in nights],
        "rhr": [r["daily_restingHeartRateInBeatsPerMinute"] for _, r in nights],
    })
    wk["hrvAvg"] = rhu(mean(wk["hrv"]))             # mean of the non-null values; None if none
    dm = [rhu(r["sleep_durationInSeconds"] / 60) for _, r in nights]
    bedL = [r["sleep_bedLocal"] for _, r in nights]
    wakeL = [r["sleep_wakeLocal"] for _, r in nights]
    update_in_place(n["sleepWake"], {"bed": [clock_dec(x, True) for x in bedL],
                                     "wake": [clock_dec(x, False) for x in wakeL],
                                     "bedL": bedL, "wakeL": wakeL, "dur": [hm_compact(m) for m in dm]})

    last_date, last = nights[-1]
    score, hrv, rhr = last["sleep_overallSleepScore"], last["hrv_lastNightAvg"], \
        last["daily_restingHeartRateInBeatsPerMinute"]
    for nd, r in nights:
        if r.get("hrv_lastNightAvg") is None:
            warnings.append(f"sleep {nd}: tracked night without an HRV reading (hrv null, readiness hN = 0.5)")
    ready = readiness(trend, score, hrv, rhr)
    mins = lambda k: rhu((last.get(k) or 0) / 60)  # noqa: E731
    update_in_place(n["lastNight"], {
        "score": score, "durationLabel": hm(dm[-1]), "bedWake": f"{bedL[-1]} → {wakeL[-1]}",
        "rhr": rhr, "hrv": hrv, "readiness": ready, "deepMin": mins("sleep_deepSleepDurationInSeconds"),
        "lightMin": mins("sleep_lightSleepDurationInSeconds"), "remMin": mins("sleep_remSleepInSeconds"),
        "awakeMin": mins("sleep_awakeDurationInSeconds")})

    evenings = [nd - timedelta(days=1) for nd, _ in nights]
    span = {nd for nd, _ in nights}
    gaps = []
    if nights:
        x = nights[0][0] + timedelta(days=1)
        while x < nights[-1][0]:
            if x not in span:
                gaps.append(x - timedelta(days=1))
            x += timedelta(days=1)
    sc, hv, rh = wk["scores"], wk["hrv"], wk["rhr"]
    avg_m = rhu(mean(dm))
    rb7 = rhu(mean(rh))
    prev_ok = len(nights) >= 2
    for lang in ("en", "hr"):
        t = s["text"][lang]
        c1 = delta_clause(sc[-1], sc[-2] if prev_ok else sc[-1], lang, "night")
        c2 = f"{signed_dur(dm[-1] - avg_m)} vs " + ("7-night avg" if lang == "en" else "prosjek 7 noći") + f" ({hm(avg_m)})"
        night_l = f"{wdl(today - timedelta(days=1), lang)}→{wdl(today, lang)}"
        upd = {
            "daysFull": [day_full(e, lang) for e in evenings],
            "daysShort": [day_short(e, lang) for e in evenings],
            "scoreWord": f"score {score}" if lang == "en" else f"ocjena {score}",
            "c1d": f"{c1} · {band(score, lang)}",
            "c2d": c2,
            "c3d": f"{delta_clause(rh[-1], rh[-2] if prev_ok else rh[-1], lang, 'night')} · "
                   f"{delta_clause(rh[-1], rb7, lang, 'avg')}",
            "c4d": hrv_clause(hv, wk["hrvAvg"], prev_ok, lang),
            "c5l": c5l(ready, lang),
            "havg": (f"HRV 7d avg {na(wk['hrvAvg'], lang)}" if lang == "en"
                     else f"HRV 7d prosjek {na(wk['hrvAvg'], lang)}"),
            "today": (f"{night_l} night: {hm(dm[-1])}, {mins('sleep_awakeDurationInSeconds')} min awake"
                      if lang == "en" else
                      f"Noć {night_l}: {hm(dm[-1])}, {mins('sleep_awakeDurationInSeconds')} min budan"),
            "badge": (f"Score {score} on {hm(dm[-1])} · HRV {na(hrv, lang)} · RHR {rhr}" if lang == "en"
                      else f"Ocjena {score} uz {hm(dm[-1])} · HRV {na(hrv, lang)} · RHR {rhr}"),
        }
        update_in_place(t, upd)

    iso = today.isoformat()
    first, lastv = evenings[0], evenings[-1]
    if gaps:
        gap_en = " (" + ", ".join(day_full(g, "en") for g in gaps) + " untracked)"
        gap_hr = " (" + ", ".join(f"{wdl(g, 'hr')} {g.day}." for g in gaps) + " " + \
            hr_plural(len(gaps), "nije zabilježena", "nisu zabilježene", "nisu zabilježene") + ")."
    else:
        gap_en = gap_hr = ""
    foot_en = (f"Data snapshot: {iso} · {SRC_SLEEP['en']} · the last-night panel shows the "
               f"{wdl(today - timedelta(days=1), 'en')}→{wdl(today, 'en')} night (wake date {iso}); the 7-day charts "
               f"show the seven most recent recorded nights, labelled by the evening they began, "
               f"{day_full(first, 'en')} through {day_full(lastv, 'en')}{gap_en}.")
    foot_hr = (f"Podaci: {hr_date(today)} · {SRC_SLEEP['hr']} · panel sinoćnje noći prikazuje noć "
               f"{wdl(today - timedelta(days=1), 'hr')}→{wdl(today, 'hr')} (datum buđenja {hr_date(today)}); "
               f"grafovi od 7 dana prikazuju sedam najnovijih zabilježenih noći, označenih večeri u kojoj su počele, "
               f"{wdl(first, 'hr')} {first.day}. do {wdl(lastv, 'hr')} {lastv.day}.{gap_hr}")
    update_in_place(s["meta"], {"version": bump_version(s["meta"].get("version")), "snapshot": iso,
                                "refreshedAt": now_iso, "footEn": foot_en, "footHr": foot_hr})
    info = {"appended": appended, "nights": [nd.isoformat() for nd, _ in nights],
            "gaps": [g.isoformat() for g in gaps], "readiness": ready, "durMin": dm, "avgMin": avg_m}
    return s, info


# --------------------------------------------------------------------------- #
# training-data.json
# --------------------------------------------------------------------------- #

def day_summary(day_acts: list, hevy_match: dict, idx_of: dict, warnings: list) -> dict:
    """Merge one day's activities into one daily entry (spec 3.2/3.3)."""
    kinds = [kind_of(a) for a in day_acts]
    secs = [a.get("duration") or 0 for a in day_acts]
    dur = rhu(sum(secs) / 60)
    kcal = rhu(sum(a.get("calories") or 0 for a in day_acts))
    mxs = [a.get("maxHR") for a in day_acts if a.get("maxHR") is not None]
    hr_pairs = [(a.get("averageHR"), s) for a, s in zip(day_acts, secs) if a.get("averageHR") is not None]
    if len(day_acts) == 1:
        avghr = rhu(day_acts[0].get("averageHR"))
    else:
        tw = sum(s for _, s in hr_pairs)
        avghr = rhu(sum(h * s for h, s in hr_pairs) / tw) if tw else None
    vols, parts = [], []
    water = [a for a, k in zip(day_acts, kinds) if k in ("pool", "ows", "water")]
    ows = [a for a, k in zip(day_acts, kinds) if k == "ows"]
    for a, k in zip(day_acts, kinds):
        if k == "str":
            w = hevy_match.get(idx_of[id(a)])
            title = clean_name(w.get("title")) if w else clean_name(a.get("activityName"))
            lift = lift_of(title)
            vol, _, _, _ = hevy_stats(w, lift)
            if vol is not None:
                vols.append(vol)
            base = LIFT_DAY.get(lift, title)
            parts.append(f"{base}, {thou(vol)} kg" if vol is not None else base)
    if len(ows) > 1:                               # summer convention: several dips, typed pool
        km = sum(a.get("distance") or 0 for a in ows) / 1000
        parts.append(f"{place_of(ows[0].get('activityName'), ['Open Water Swimming', 'Open Water Swim'])} "
                     f"open-water swim {km:.1f} km ({len(ows)}×)")
    for a, k in zip(day_acts, kinds):
        nm = a.get("activityName")
        m = rhu((a.get("duration") or 0) / 60)
        dist = rhu(a.get("distance"))
        if k == "pool":
            st = swim_set(nm)
            parts.append(f"Pool swim {thou(dist)} m ({st})" if st else f"Pool swim {thou(dist)} m")
        elif k == "ows" and len(ows) == 1:
            parts.append(f"{place_of(nm, ['Open Water Swimming', 'Open Water Swim'])} open-water swim {thou(dist)} m")
        elif k in ("walk", "hike"):
            pl = place_of(nm, ["Walking", "Hiking", "Walk", "Hike"])
            txt = f"{'walk' if k == 'walk' else 'hike'} {(a.get('distance') or 0) / 1000:.1f} km, {short_dur(m)}"
            parts.append(f"{pl} {txt}" if pl else txt[0].upper() + txt[1:])
        elif k == "squash":
            parts.append(f"Squash, {m} min")
        elif k in ("water", "other"):
            parts.append(f"{clean_name(nm)}, {short_dur(m)}")
            if k == "other":
                warnings.append(f"{day_acts[0]['startTimeLocal'][:10]}: unknown activity type "
                                f"{(a.get('activityType') or {}).get('typeKey')} counted as a session")
    if "str" in kinds:
        typ = "str"
    elif water:
        typ = "ows" if len(water) == 1 and kinds.count("ows") == 1 else "pool"
    elif "squash" in kinds:
        typ = "squash"
    else:
        typ = "hike"
    if typ == "str":
        dist = None
    else:
        dsum = sum(a.get("distance") or 0 for a, k in zip(day_acts, kinds) if k != "str")
        dist = rhu(dsum) if dsum else None
    if typ == "hike":
        cat = "hike" if "hike" in kinds else "walk" if "walk" in kinds else "other"
    else:
        cat = typ
    effort = rhu(dur * (avghr - EFFORT_RHR) / (EFFORT_MAX - EFFORT_RHR)) if avghr is not None else None
    return {"type": typ, "names": " + ".join(parts), "effort": effort, "dur": dur, "kcal": kcal,
            "vol": sum(vols) if vols else None, "dist": dist,
            "maxhr": rhu(max(mxs)) if mxs else None, "avghr": avghr, "_cat": cat}


def k3d(cats: list, lang: str) -> str:
    c = {k: cats.count(k) for k in ("str", "pool", "ows", "walk", "hike", "squash", "other")}
    if lang == "en":
        parts = [f"{c['str']} gym session" + ("" if c["str"] == 1 else "s")]
        if c["pool"]:
            parts.append("1 swim" if c["pool"] == 1 else f"{c['pool']} pool swims")   # LEAD D12
        if c["ows"]:
            parts.append(f"{c['ows']} open-water swim" + ("" if c["ows"] == 1 else "s"))
        if c["walk"]:
            parts.append(f"{c['walk']} walk" + ("" if c["walk"] == 1 else "s"))
        if c["hike"]:
            parts.append(f"{c['hike']} hike" + ("" if c["hike"] == 1 else "s"))
        if c["squash"]:
            parts.append(f"{c['squash']} squash")
        if c["other"]:
            parts.append(f"{c['other']} other")
        if len(parts) == 1:
            parts.append("no swim")
    else:
        parts = [hr_count(c["str"], "teretana", "teretane", "teretana")]
        if c["pool"]:                                                          # LEAD D12: "1 plivanje"
            parts.append(hr_count(c["pool"], "plivanje", "plivanja u bazenu", "plivanja u bazenu"))
        if c["ows"]:
            parts.append(hr_count(c["ows"], "plivanje", "plivanja", "plivanja") + " na otvorenom")
        if c["walk"]:
            parts.append(hr_count(c["walk"], "šetnja", "šetnje", "šetnji"))
        if c["hike"]:
            parts.append(hr_count(c["hike"], "planinarenje", "planinarenja", "planinarenja"))
        if c["squash"]:
            parts.append(f"{c['squash']} squash")
        if c["other"]:
            parts.append(f"{c['other']} ostalo")
        if len(parts) == 1:
            parts.append("bez plivanja")
    return " · ".join(parts)


def strength_tonnage(strength: dict) -> dict:
    """{date: work tonnage} exactly as build_strength.py will write it into gym[].volWork
    (int(round(sum of that date's workouts' tonnageWork)))."""
    by, has = {}, set()
    for wo in (strength or {}).get("workouts") or []:
        if isinstance(wo, dict) and wo.get("date") and wo.get("tonnageWork") is not None:
            by[wo["date"]] = by.get(wo["date"], 0.0) + wo["tonnageWork"]
            has.add(wo["date"])
    return {d: int(round(by[d])) for d in has}


def work_tonnage(r: dict, tw: dict | None = None):
    """LEAD: volWork if present, else strength-data tonnageWork of that date, else vol."""
    if r.get("volWork") is not None:
        return r["volWork"]
    if tw and tw.get(r.get("d")) is not None:
        return tw[r["d"]]
    return r.get("vol")


def tonnage_at(gym: list, end: date, tw: dict | None = None):
    acute = sum(work_tonnage(r, tw) or 0 for r in gym if end - timedelta(days=6) <= D(r["d"]) <= end)
    chronic = sum(work_tonnage(r, tw) or 0 for r in gym if end - timedelta(days=27) <= D(r["d"]) <= end) / 4
    return {"end": end.isoformat(), "acute": rhu(acute), "chronic": rhu(chronic),
            "acwr": rhu(acute / chronic, 2) if chronic else None, "_acwr_raw": acute / chronic if chronic else None}


def top_sets(gym: list, today: date) -> dict:
    """lift -> {latest, previous, pct, cmp} for lifts with a top set in the last 28 days."""
    out = {}
    lo = today - timedelta(days=27)
    lifts = []
    for r in gym:
        if r.get("top") and r.get("lift") not in (None, "other") and lo <= D(r["d"]) <= today \
                and r["lift"] not in lifts:
            lifts.append(r["lift"])
    for lift in lifts:
        rows = [r for r in gym if r.get("lift") == lift and r.get("top") and D(r["d"]) <= today]
        cur = rows[-1]
        prev = rows[-2] if len(rows) > 1 else None
        raw = None
        if prev and prev["top"].get("w"):
            raw = (cur["top"]["w"] / prev["top"]["w"] - 1) * 100
        out[lift] = {"latest": {"d": cur["d"], "w": cur["top"]["w"], "reps": cur["top"]["reps"]},
                     "previous": {"d": prev["d"], "w": prev["top"]["w"], "reps": prev["top"]["reps"]} if prev else None,
                     "pctChange": rhu(raw, 1) if raw is not None else None, "_pct_raw": raw}
    return dict(sorted(out.items(), key=lambda kv: kv[1]["latest"]["d"], reverse=True))


def lift_clause(lift: str, t: dict, lang: str) -> str:
    cur, prev = t["latest"], t["previous"]
    cd = D(cur["d"])
    on = (lambda d: f"on {lbl(d)}") if lang == "en" else (lambda d: f"dana {hr_dm(d)}")
    s = f"{LIFT_NAME[lang][lift]} {num(cur['w'], lang)} kg × {cur['reps']} {on(cd)}"
    if not prev:
        return s
    pd = D(prev["d"])
    if cur["w"] == prev["w"]:
        if cur["reps"] == prev["reps"]:
            c = f"level with {lbl(pd)}" if lang == "en" else f"jednako kao {hr_dm(pd)}"
        else:
            up = (cur["reps"] or 0) > (prev["reps"] or 0)
            w = ("up from" if up else "down from") if lang == "en" else ("više od" if up else "niže od")
            c = f"{w} {num(prev['w'], lang)} kg × {prev['reps']} {on(pd)}"
    else:
        p = t["pctChange"]
        ps = ("+" if p > 0 else MINUS) + num(abs(p), lang) + "%"
        c = f"{ps} on {lbl(pd)}" if lang == "en" else f"{ps} na {hr_dm(pd)}"
    return f"{s}, {c}"


def swim_label(r: dict) -> str:
    st = swim_set(r.get("t") or "")
    if "open water" in (r.get("t") or "").lower() or r.get("lengths") is None and not st:
        return "open-water"
    return st or clean_name(r.get("t"))


def foot2(acwr: dict, tops: dict, swims: list, lang: str) -> str:
    if acwr["acwr"] is None:
        parts = ["ACWR n/a" if lang == "en" else "ACWR n/d"]
    elif lang == "en":
        parts = [f"ACWR {acwr['acwr']:.2f} on {thou(acwr['acute'])} kg acute vs {thou(acwr['chronic'])} kg chronic "
                 f"work tonnage"]
    else:
        parts = [f"ACWR {acwr['acwr']:.2f}".replace(".", ",") + f" uz akutnih {thou(acwr['acute'], 'hr')} kg naspram "
                 f"kroničnih {thou(acwr['chronic'], 'hr')} kg radne tonaže"]
    parts += [lift_clause(l, t, lang) for l, t in tops.items()]
    if swims:
        r = swims[-1]
        d = D(r["d"])
        if lang == "en":
            parts.append(f"last swim {swim_label(r)}" + (f" at {r['pace']} per 100 m" if r.get("pace") else "")
                         + f" on {lbl(d)}")
        else:
            parts.append(f"zadnje plivanje {swim_label(r)}" + (f" uz {r['pace']} po 100 m" if r.get("pace") else "")
                         + f" dana {hr_dm(d)}")
    return " · ".join(parts)


def food_days(data_doc: dict) -> dict:
    """{iso date: total kcal} for data.json days with a non-empty log."""
    out = {}
    for dd in (data_doc or {}).get("days") or []:
        m = re.search(r"\d{4}-\d{2}-\d{2}", str(dd.get("date") or ""))
        log = dd.get("log") or []
        if m and log:
            out[m.group(0)] = rhu(sum(x.get("kcal") or 0 for x in log))
    return out


def build_training(doc: dict, strength: dict, data_doc: dict, rows: dict, acts: list, hevy_match: dict,
                   new_g: list, new_s: list, daily_hr: dict, today: date, now_iso: str, warnings: list):
    t = copy.deepcopy(doc)
    n = t["num"]
    filled = fill_hevy_lag(n.setdefault("gym", []), acts, hevy_match, today)
    n["gym"].extend(copy.deepcopy(new_g))
    n.setdefault("swim", []).extend(copy.deepcopy(new_s))
    new_m = mld_rows(t, n["gym"], strength, today, warnings, {f["d"] for f in filled})
    for lift, row in new_m:                        # keep mld ascending (a refilled row may be older)
        arr = n["mld"][lift]
        k = len(arr)
        while k > 0 and arr[k - 1]["d"] > row["d"]:
            k -= 1
        arr.insert(k, row)

    win = [today - timedelta(days=i) for i in range(6, -1, -1)]
    idx_of = {id(a): i for i, a in enumerate(acts)}
    by_day = {}
    for a in acts:
        by_day.setdefault(a["startTimeLocal"][:10], []).append(a)
    keys = ("type", "names", "effort", "dur", "kcal", "vol", "dist", "maxhr", "avghr", "rhr")
    daily = n.get("daily") or {}
    cols = {k: [] for k in keys}
    cats = []
    for d in win:
        k = d.isoformat()
        rhr = (rows.get(k) or {}).get("daily_restingHeartRateInBeatsPerMinute")
        if by_day.get(k):
            e = day_summary(by_day[k], hevy_match, idx_of, warnings)
            cats.append(e.pop("_cat"))
        else:
            mx, av = daily_hr.get(k, (None, None))
            if mx is None or av is None:
                warnings.append(f"daily {k}: rest-day HR unavailable (usersummary/dailyHeartRate)")
            e = {"type": "rest", "names": "Rest day", "effort": None, "dur": None, "kcal": None, "vol": None,
                 "dist": None, "maxhr": mx, "avghr": av}
        e["rhr"] = rhr
        for c in keys:
            cols[c].append(e[c])
    for c in list(daily.keys()) + [c for c in keys if c not in daily]:
        if c in cols:
            daily[c] = cols[c]
    n["daily"] = daily

    edaily = [(rows.get(d.isoformat()) or {}).get("daily_activeKilocalories") for d in win]
    if any(v is None for v in edaily):
        warnings.append("energy: daily_activeKilocalories missing for " +
                        ", ".join(d.isoformat() for d, v in zip(win, edaily) if v is None))
    ev = [v for v in edaily if v is not None]
    eavg = rhu(sum(ev) / len(ev)) if ev else None
    food = food_days(data_doc)
    eint = [food.get(d.isoformat()) for d in win]
    update_in_place(n["energy"], {"edaily": edaily, "eavg": [eavg] * 7, "eint": eint})
    bmr = n.get("burn", {}).get("bmr", BMR_DEFAULT)
    update_in_place(n["burn"], {"exnet": list(edaily),
                                "intake": [v if v is not None else INTAKE_PLACEHOLDER for v in eint],
                                "logged": [v is not None for v in eint]})
    logged_in_win = [(d, food[d.isoformat()]) for d in win if d.isoformat() in food]
    if logged_in_win:                              # LEAD D12 (A16); else carry forward
        n["bridge"] = [{"label": day_full(d, "en"), "int": v,
                        "ex": (rows.get(d.isoformat()) or {}).get("daily_activeKilocalories"),
                        "bal": v - (bmr + ((rows.get(d.isoformat()) or {}).get("daily_activeKilocalories") or 0))}
                       for d, v in logged_in_win]

    sessions = sum(1 for x in cols["type"] if x != "rest")
    T = sum(x or 0 for x in cols["dur"])
    update_in_place(n["kpis"], {"sessions": str(sessions), "totalTime": hm(T),
                                "volume": f"{thou(sum(x or 0 for x in cols['vol']))} kg",
                                "activeCals": thou(sum(x or 0 for x in cols["kcal"]))})
    tw = strength_tonnage(strength)
    acwr_now = tonnage_at(n["gym"], today, tw)
    tops = top_sets(n["gym"], today)
    L = sum(1 for v in eint if v is not None)
    avg_s = rhu(T / sessions) if sessions else 0
    for lang in ("en", "hr"):
        tx = t["text"][lang]
        if lang == "en":
            upd = {"k1d": f"{sessions} session{'' if sessions == 1 else 's'} · {sessions}/7 days active",
                   "k2d": f"avg {avg_s}m per session",
                   "k3d": k3d(cats, "en"),
                   "k4d": f"~{eavg} kcal/day active · intake logged {L}/7 days",
                   "foot": f"Data: {win[0].isoformat()} → {win[-1].isoformat()} · {SRC_TRAIN['en']}"}
        else:
            d0 = hr_dm(win[0]) if win[0].year == today.year else hr_date(win[0])
            upd = {"k1d": f"{hr_count(sessions, 'trening', 'treninga', 'treninga')} · {sessions}/7 aktivnih dana",
                   "k2d": f"prosj. {avg_s}m po treningu",
                   "k3d": k3d(cats, "hr"),
                   "k4d": f"~{eavg} kcal/dan aktivno · unos zabilježen {L}/7 dana",
                   "foot": f"Podaci: {d0} → {hr_date(win[-1])} · {SRC_TRAIN['hr']}"}
        upd["days"] = [day_full(d, lang) for d in win]
        upd["daysM"] = [day_short(d, lang) for d in win]
        upd["foot2"] = foot2(acwr_now, tops, n["swim"], lang)
        update_in_place(tx, upd)
    update_in_place(t["meta"], {"version": bump_version(t["meta"].get("version")),
                                "snapshot": today.isoformat(), "refreshedAt": now_iso})
    info = {"win": [d.isoformat() for d in win], "cats": cats, "newMld": [(l, r["d"]) for l, r in new_m],
            "acwr": acwr_now, "tops": tops, "food": {d.isoformat(): v for d, v in logged_in_win},
            "filled": filled, "tw": tw}
    return t, info


# --------------------------------------------------------------------------- #
# facts (grounding for the agent's narrative)
# --------------------------------------------------------------------------- #

def r1(x):
    return rhu(x, 1) if x is not None else None


def flag_ladder(now_t: dict, tops: dict, debt: dict, last: dict, raw28: dict, base28: dict) -> dict:
    """REFRESH.md §3a, first tripped flag. Thresholds compare RAW values (ACWR > 1.3, jump > 10 %);
    the numbers reported are the rounded display values."""
    acwr_raw = now_t.get("_acwr_raw")
    if acwr_raw is not None and acwr_raw > 1.3:
        return {"id": "acwr", "acwr": now_t["acwr"], "acute": now_t["acute"], "chronic": now_t["chronic"]}
    jumps = [(l, v) for l, v in tops.items() if v.get("_pct_raw") is not None and v["_pct_raw"] > 10]
    if jumps:
        l, v = max(jumps, key=lambda kv: kv[1]["_pct_raw"])
        return {"id": "topSetJump", "lift": l, "latest": v["latest"], "previous": v["previous"],
                "pctChange": v["pctChange"]}
    if debt["count"] > 0:
        return {"id": "sleepDebt", "count": debt["count"], "shortfallH": debt["shortfallH"], "nights": debt["nights"]}
    # divergence compares against the displayed (1-decimal) baselines, so the narrative never
    # reads "RHR 56 above its 56.0 baseline"
    if (last.get("rhr") is not None and last.get("hrv") is not None and base28.get("rhr") is not None
            and base28.get("hrv") is not None and last["rhr"] > base28["rhr"] and last["hrv"] < base28["hrv"]):
        return {"id": "rhrHrvDivergence", "rhr": last["rhr"], "rhrBase28": base28["rhr"],
                "hrv": last["hrv"], "hrvBase28": base28["hrv"]}
    return {"id": "none"}


def build_facts(sleep: dict, train: dict, s_info: dict, t_info: dict, rows: dict, today: date,
                now_iso: str, warnings: list, new_g: list, new_s: list) -> dict:
    trend = sleep["num"]["trend"]
    w28 = trend[-28:]
    base28 = {"rows": len(w28), "from": w28[0]["d"] if w28 else None,
              "durH": rhu(mean([x.get("durH") for x in w28]), 2) if w28 else None,
              "score": r1(mean([x.get("score") for x in w28])), "rhr": r1(mean([x.get("rhr") for x in w28])),
              "hrv": r1(mean([x.get("hrv") for x in w28]))}
    wk = sleep["num"]["week"]
    dm = s_info["durMin"]
    base7 = {"durH": rhu(mean(dm) / 60, 2) if dm else None, "durMin": s_info["avgMin"],
             "score": r1(mean(wk["scores"])), "rhr": r1(mean(wk["rhr"])), "hrv": r1(mean(wk["hrv"]))}
    ln = sleep["num"]["lastNight"]
    lr = rows[today.isoformat()]
    last = {"wakeDate": today.isoformat(), "evening": (today - timedelta(days=1)).isoformat(),
            "score": ln["score"], "durH": rhu(lr["sleep_durationInSeconds"] / 3600, 2),
            "durationLabel": ln["durationLabel"], "bed": sleep["num"]["sleepWake"]["bedL"][-1],
            "wake": sleep["num"]["sleepWake"]["wakeL"][-1], "awakeMin": ln["awakeMin"], "deepMin": ln["deepMin"],
            "lightMin": ln["lightMin"], "remMin": ln["remMin"], "hrv": ln["hrv"], "rhr": ln["rhr"],
            "readiness": ln["readiness"], "c5l": sleep["text"]["en"]["c5l"]}

    def dl(cur, b, nd=1):
        return rhu(cur - b, nd) if cur is not None and b is not None else None
    last["vs28"] = {"durH": dl(last["durH"], base28["durH"], 2), "score": dl(last["score"], base28["score"]),
                    "rhr": dl(last["rhr"], base28["rhr"]), "hrv": dl(last["hrv"], base28["hrv"])}
    last["vs7"] = {"durMin": dm[-1] - s_info["avgMin"], "score": dl(last["score"], base7["score"]),
                   "rhr": dl(last["rhr"], base7["rhr"]), "hrv": dl(last["hrv"], base7["hrv"])}
    def prev_d(xs):
        return xs[-1] - xs[-2] if len(xs) > 1 and None not in (xs[-1], xs[-2]) else None
    last["vsPrevNight"] = {"score": prev_d(wk["scores"]), "rhr": prev_d(wk["rhr"]), "hrv": prev_d(wk["hrv"]),
                           "durMin": prev_d(dm)}
    rec7 = [x for x in trend if x.get("durH") is not None][-7:]
    short = [x for x in rec7 if x["durH"] < 7.0]
    debt = {"rows": [x["d"] for x in rec7], "nights": [{"d": x["d"], "durH": x["durH"]} for x in short],
            "count": len(short), "shortfallH": rhu(sum(7 - x["durH"] for x in short), 2)}
    untracked28 = [x["d"] for x in w28 if x.get("durH") is None]

    num_ = train["num"]
    gym = num_["gym"]
    now_t = t_info["acwr"]
    prev_t = tonnage_at(gym, today - timedelta(days=7), t_info["tw"])
    tops = t_info["tops"]
    seen28 = sorted({r["lift"] for r in gym if r.get("lift") and today - timedelta(days=27) <= D(r["d"]) <= today})
    last_by_lift = {}
    for r in gym:
        if r.get("lift"):
            last_by_lift[r["lift"]] = {k: r.get(k) for k in ("d", "t", "vol", "volWork", "sets", "reps", "mx", "av",
                                                             "dur", "kcal", "top", "tmax", "tmin")}
    swims_by_set = {}
    for r in num_["swim"]:
        swims_by_set[swim_label(r)] = {k: r.get(k) for k in ("d", "t", "dist", "sec100", "pace", "mx", "av",
                                                           "lengths", "spm", "dur", "kcal", "tmax", "tmin")}

    flag = flag_ladder(now_t, tops, debt, last, {"rhr": mean([x.get("rhr") for x in w28]),
                                                  "hrv": mean([x.get("hrv") for x in w28])}, base28)
    for x in (now_t, prev_t):
        x.pop("_acwr_raw", None)
    tops = {k: {kk: vv for kk, vv in v.items() if kk != "_pct_raw"} for k, v in tops.items()}

    daily = num_["daily"]
    return {
        "date": today.isoformat(), "generatedAt": now_iso, "tool": "tools/build_dashboard.py",
        "source": {"sleep": SRC_SLEEP["en"], "training": SRC_TRAIN["en"]},
        "appended": {"trend": s_info["appended"], "gym": [(r["d"], r["t"]) for r in new_g],
                     "swim": [(r["d"], r["t"]) for r in new_s], "mld": t_info["newMld"]},
        "filled": t_info["filled"],
        "sleep": {"nights": s_info["nights"], "untrackedInSpan": s_info["gaps"], "untrackedLast28": untracked28,
                  "baseline28": base28, "baseline7": base7, "lastNight": last, "sleepDebt": debt},
        "training": {
            "window": t_info["win"],
            "daily": [{"d": d, "type": daily["type"][i], "names": daily["names"][i], "dur": daily["dur"][i],
                       "kcal": daily["kcal"][i], "vol": daily["vol"][i], "dist": daily["dist"][i],
                       "avghr": daily["avghr"][i], "maxhr": daily["maxhr"][i], "rhr": daily["rhr"][i],
                       "activeKcal": num_["energy"]["edaily"][i]} for i, d in enumerate(t_info["win"])],
            "kpis": num_["kpis"], "eavg": num_["energy"]["eavg"][0],
            "tonnage": {"basis": "volWork, else strength-data tonnageWork of the date, else vol", "now": now_t, "sevenDaysEarlier": prev_t},
            "topSets": tops, "liftsSeen28d": seen28, "lastSessionByLift": last_by_lift,
            "lastSwimBySet": swims_by_set,
            "foodLogDaysInWindow": t_info["food"], "foodLogCount": len(t_info["food"]),
        },
        "flag": flag,
        "warnings": list(warnings),
    }


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def run(today: date, repo: Path, facts_path: Path, dry_run: bool, fetcher: Fetcher,
        now: datetime | None = None, hevy_dir: Path | None = None) -> int:
    warnings = []
    sp, tp = repo / "sleep-data.json", repo / "training-data.json"
    sleep_doc = load_json(sp, "sleep-data.json")
    train_doc = load_json(tp, "training-data.json")
    strength = load_json(repo / "strength-data.json", "strength-data.json")
    data_doc = load_json(repo / "data.json", "data.json")
    for doc, what, keys in ((sleep_doc, "sleep-data.json", ("meta", "num", "text")),
                            (train_doc, "training-data.json", ("meta", "num", "text"))):
        if not isinstance(doc, dict) or any(k not in doc for k in keys):
            raise LocalInputError(f"{what}: missing top-level keys")
    if not isinstance(strength, dict) or not isinstance(strength.get("workouts"), list):
        raise LocalInputError("strength-data.json: no workouts[]")
    snap = (sleep_doc.get("meta") or {}).get("snapshot")
    if snap == today.isoformat():
        print(f"build_dashboard: sleep-data.json already at snapshot {today}; nothing to do")
        return EXIT_DONE
    if snap and str(snap) > today.isoformat():
        raise LocalInputError(f"--date {today} is earlier than sleep-data.json meta.snapshot {snap}; "
                              f"refusing to move the dashboard back in time")
    if fetcher.replay and (fetcher.replay / "hevy").is_dir():
        hevy_dir = fetcher.replay / "hevy"
    hevy = load_hevy(hevy_dir or HEVY_DIR)

    trend = sleep_doc["num"].get("trend") or []
    last_t = D(trend[-1]["d"]) if trend else today - timedelta(days=1)
    ws = min(last_t + timedelta(days=1), today - timedelta(days=27))
    rows = GS.fetch_window(fetcher, ws, today)
    if not tracked(rows.get(today.isoformat())):
        print(f"build_dashboard: no Garmin sleep record for {today} yet (watch not synced)")
        return EXIT_NOSLEEP

    gym, swim = train_doc["num"].get("gym") or [], train_doc["num"].get("swim") or []
    starts = [today - timedelta(days=6)] + [D(x[-1]["d"]) for x in (gym, swim) if x]
    acts = fetch_activities(fetcher, min(starts), today)
    hevy_match = match_hevy(acts, hevy)
    new_g, new_s = new_sessions(train_doc, acts, hevy_match, today)
    tdates = sorted({r["d"] for r in new_g + new_s})
    if tdates:
        temps, warn = fetcher.weather(D(tdates[0]), D(tdates[-1]))
        if warn:
            warnings.append(warn)
        apply_temps(new_g + new_s, temps)
    for g in new_g:
        if g["vol"] is None:
            warnings.append(f"gym {g['d']}: no Hevy workout yet; vol/sets/reps/top null")
    act_days = {a["startTimeLocal"][:10] for a in acts}
    daily_hr = {}
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        if d.isoformat() not in act_days:
            daily_hr[d.isoformat()] = fetch_daily_hr(fetcher, d)

    now = now or GS.local_now()
    now_iso = GS.to_local(now).isoformat(timespec="seconds")
    sleep_new, s_info = build_sleep(sleep_doc, rows, today, now_iso, warnings)
    train_new, t_info = build_training(train_doc, strength, data_doc, rows, acts, hevy_match, new_g, new_s,
                                       daily_hr, today, now_iso, warnings)
    facts = build_facts(sleep_new, train_new, s_info, t_info, rows, today, now_iso, warnings, new_g, new_s)
    facts["dryRun"] = bool(dry_run)

    if fetcher.record:
        hd = fetcher.record / "hevy"
        hd.mkdir(parents=True, exist_ok=True)
        lo = min(starts).isoformat()
        for d, ws_ in hevy.items():
            if d and lo <= d <= today.isoformat():
                for w in ws_:
                    shutil.copy2(w["_file"], hd / os.path.basename(w["_file"]))
    # facts first (cache, not the repo): if it fails, the repo is still untouched
    write_text(facts_path, json.dumps(facts, ensure_ascii=False, indent=1) + "\n")
    if not dry_run:
        write_all([(tp, dump_json(train_new)), (sp, dump_json(sleep_new))])
    print(f"build_dashboard: date={today} trend+{len(s_info['appended'])} gym+{len(new_g)} swim+{len(new_s)} "
          f"mld+{len(t_info['newMld'])} nights={s_info['nights'][0]}..{s_info['nights'][-1]} "
          f"readiness={s_info['readiness']} flag={facts['flag']['id']} calls={fetcher.calls} "
          f"warnings={len(warnings)} {'DRY-RUN (repo untouched)' if dry_run else 'wrote ' + str(repo)} "
          f"facts={facts_path}")
    for w in warnings:
        print(f"  warning: {w}")
    return EXIT_OK


def main(argv=None, now: datetime | None = None, hevy_dir: Path | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--date", help="data date YYYY-MM-DD (default: today, Europe/Zagreb)")
    ap.add_argument("--repo", default=str(REPO), help="directory holding the dashboard JSON files")
    ap.add_argument("--facts", help="facts JSON path (default <CACHE>/garmin/facts-<date>.json)")
    ap.add_argument("--dry-run", action="store_true", help="build and write the facts file only")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--record", help="save every network response under DIR")
    g.add_argument("--replay", help="use only the responses saved under DIR (no network)")
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):   # pragma: no cover
        pass
    try:
        today = date.fromisoformat(a.date) if a.date else GS.local_now().date()
    except ValueError:
        print(f"build_dashboard: bad --date {a.date!r}", file=sys.stderr)
        return EXIT_LOCAL
    facts = Path(a.facts) if a.facts else FACTS_DIR / f"facts-{today.isoformat()}.json"
    if a.replay and not Path(a.replay).is_dir():
        print(f"build_dashboard: replay dir {a.replay} not found", file=sys.stderr)
        return EXIT_NET
    try:
        return run(today, Path(a.repo), facts, a.dry_run, Fetcher(a.record, a.replay), now=now, hevy_dir=hevy_dir)
    except GS.AuthError as e:
        print(f"build_dashboard: auth: {e}", file=sys.stderr)
        return EXIT_AUTH
    except GS.FetchError as e:
        print(f"build_dashboard: {e}", file=sys.stderr)
        return EXIT_NET
    except LocalInputError as e:
        print(f"build_dashboard: local input: {e}", file=sys.stderr)
        return EXIT_LOCAL
    except Exception:                      # a bug here must not look like a network failure (exit 1)
        print("build_dashboard: internal error (exit 6), nothing written:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return EXIT_BUG


if __name__ == "__main__":
    sys.exit(main())
