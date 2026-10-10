#!/usr/bin/env python3
"""build_strength.py -- strength-analytics engine for the daily dashboard.

Joins Hevy workouts (exercises / sets / kg / reps / RPE / notes) with the
HR stream (Strava/Garmin, HRM600 chest strap) by matching HR peaks to sets, then
computes load / muscle / progression analytics and writes strength-data.json.

Deterministic, Python stdlib only.

    python tools/build_strength.py [--refresh-templates] [--raw-dir DIR]
                                   [--out strength-data.json] [--report]
                                   [--method anchor|dp_legacy|topn] [--no-training-data]

Session structure encoded here (the user's own description, authoritative):
  * ~18-20 min warm-up on the watch (walk ~10 min, DNS drills 7-10 min), no
    Hevy sets in it.  The Hevy workout ~= Garmin duration - 20 min, always
    (mainBlockOffsetMin / mainBlockTolMin); the main block ends at the end of
    the HR stream.  Hevy start/end times are NOT trusted (older sessions start
    the Hevy timer before the warm-up).
  * Main block opens with the biggest compound lift: 1-3 warm-up sets (6-4-2
    reps, lower HR peaks) then usually 3 main work sets, which are clearly
    visible in the HR trace -> they are the reference ("anchor").
  * Every Hevy set (warm-up sets included) -> exactly one HR peak, in Hevy
    order (exercise order x set order; exercises sharing a superset_id are
    interleaved).  Recent sessions type warm-ups "warmup"; older ones log them
    as "normal" (lighter, 6-4-2 / 6-3 reps) -> inferred (warmupInferred).

Candidate peaks: 1 Hz HR (linear interpolation over gaps <= 12 s), 5 s median
+ 5 s mean smoothing for detection only, local maxima with a windowed
prominence and 35 s min separation.

Default matcher (--method anchor), anchor-first:
  1. expected main-block length L = Garmin duration - 20 min;
  2. anchor = exercise 1's main work sets (k = 1..5, usually 3): the best
     k-tuple of big, similar, well separated peaks (peak-to-peak ~ rest 90-300 s
     + set) with its first peak in [15 min, Garmin end - L + 15 min];
  3. exercise 1's pre-anchor sets (warm-ups) are matched to smaller peaks in
     the ~10 min before the anchor; the warm-up ends right before the first;
  4. the remaining sets are aligned forward from the anchor to the end of the
     stream by the order-preserving DP (one peak per set, skips only as a last
     resort, peaks never invented; surplus sets stay unmatched, conf 0).
  Any matched rest < 30 s is flagged (shortRest) and capped at conf 0.25; so is
  a set whose rise holds a > 15 bpm/s strap step (steepRise + nearArtifact).
Gym per workout: explicit token in title / description / notes, else inferred
from machine / cable exercises seen only in one gym's explicit workouts
(infer_gyms; gymSource explicit | inferred | conflict | none).
The previous matcher (warm-up end = first strong peak, Hevy-time window cut,
whole-session DP) is kept as --method dp_legacy ("dp" is an alias); "top-N by
prominence, chronological" as --method topn.  Per-set confidence comes from
max-marginals (margin to the best alternative peak).
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import itertools
import json
import math
import os
import re
import statistics
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

# Python 3.12+ sums floats with compensated (Neumaier) summation; 3.9-3.11 do not. That changes the last
# bit of means/thresholds and shifts a peak by 1 s. Shadow sum() with math.fsum for floats so a 3.9 build
# (Mac mini cron) equals a 3.12+ build (PC). Ints and other types use the builtin unchanged.
_builtin_sum = sum


def sum(iterable, start=0):  # noqa: A001
    xs = list(iterable)
    if isinstance(start, float) or any(isinstance(x, float) for x in xs):
        return math.fsum([start] + xs)
    return _builtin_sum(xs, start)


VERSION = "st-1.1"
REPO = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).resolve().parent / "strength-config.json"
PROJECT_CACHE = Path(os.environ.get("ZG_CACHE") or Path.home() / ".claude" / "cache" / "daily-dashboard")
STRENGTH_CACHE = PROJECT_CACHE / "strength"
DEFAULT_RAW = STRENGTH_CACHE / "raw"
TEMPLATES_PATH = STRENGTH_CACHE / "templates.json"
SECRETS_PATH = PROJECT_CACHE / "secrets" / "hevy.env"

HR_MAX = 173
GAP_MAX_S = 12          # interpolate HR gaps up to this many seconds
MIN_SEP_S = 35          # min separation between candidate peaks
PROM_MIN = 4.0          # bpm, smoothed, windowed prominence floor
PROM_WIN_S = 150        # prominence / set-start look-back window
HR_SERIES_STEP = 5
HR_SERIES_LATEST = 40
MAX_SET_SKIP = 8        # max consecutive sets the DP may leave unmatched

# DP weights
W_BASE = 1.0            # reward for matching a set
W_PROM = 0.8            # reward per normalised prominence
W_SIZE = 1.3            # penalty per |observed size - expected size|
EXP_WARM = 0.5          # expected relative peak size: warm-up / ramp-up set
EXP_MAIN = 1.15         # first (heavy compound) exercise work set (+0.2*effort)
EXP_ACC = 0.65          # accessory work set (+0.35*effort)
W_WEAK_WORK = 0.5       # extra penalty: work set on a very weak peak
SKIP_SET = 1.6          # penalty per unmatched set
SKIP_PEAK = 0.9         # penalty per skipped candidate x its promN
PRE_SKIP_W = 0.3        # skip weight for candidates well before the warm-up prior
START_EARLY = 0.8       # penalty / min for a first set starting before the detected main-block start
START_LATE = 0.5        # penalty / min for starting later than START_SLACK_S after it
START_SLACK_S = 120
STRONG_PROM = 10        # bpm, min prominence of the first strong set peak
PRE_WIN_S = 150         # candidates allowed this long before the detected main-block start
STRONG_MIN = 20         # bpm over the DNS baseline for the "first strong set peak"
STRONG_FRAC = 0.6       # ... or this fraction of (typical set-peak height - baseline), if larger

# anchor matcher (the user's session model; minutes / seconds overridable in strength-config.json)
MAIN_OFFSET_MIN = 20    # Hevy workout ~= Garmin duration - 20 min
MAIN_TOL_MIN = 5
ANCHOR_SEARCH_MIN = 15  # anchor's first peak within this many min after the expected main-block start
END_SLACK_MIN = 5       # last set expected within the final ~5 min of the stream
ANCHOR_REST_S = (90, 300)
SHORT_REST_S = 30       # a matched rest below this is flagged low-confidence
SHORT_REST_CONF = 0.25
ANCHOR_KG_FRAC = 0.85   # anchor sets: exercise-1 work sets at >= 85 % of their median weight
ANCHOR_MAX_K = 5
ANCHOR_RISE_S = (30, 75)  # set start -> peak, added to the rest to get peak-to-peak spacing
ANCHOR_GAP_S = (60, 480)  # hard limits on anchor peak-to-peak spacing
PRE_ANCHOR_S = 600      # exercise-1 warm-up sets are looked for this far before the anchor
PRE_ANCHOR_MIN_S = 45
A_BASE = 1.0            # anchor score: per peak
A_SIZE = 1.5            # per normalised size
ANCHOR_SIZE_W = (0.67, 0.33)  # anchor size = w0 * height over DNS baseline + w1 * rise from the trough
A_PROM = 0.8            # per normalised prominence
A_SIM = 1.0             # per 10 bpm (max - min) peak height inside the tuple
A_GAP = 0.6             # per minute of spacing outside the rest window
A_INT = 0.3             # per skipped (promN) candidate between anchor peaks (small noise bumps happen)
A_BIG = 1.0             # per 5 bpm an unused peak inside the anchor span reaches the weakest
A_BIG_AFTER = 0.3       # same, for the one rest interval after the anchor (HR drifts up later)
BIG_MARGIN = 3          # anchor peak (- 3 bpm): the anchor must be the biggest peaks there
A_WU = 0.8              # per exercise-1 warm-up set without a candidate before the anchor
A_DOM = 1.0             # per 5 bpm a pre-anchor peak reaches the weakest anchor peak (- 3 bpm)
A_POS = 0.1             # per minute the first anchor peak is > 5 min from its expected time
END_W = 0.4             # forward DP: penalty / min the last set ends before (stream end - END_SLACK)
FIRST_SET_WIN_S = 75    # anchor mode: first set's start searched <= 75 s before its peak
ALT_SEP_S = 60          # anchor-mode conf: alternatives count only if > 60 s from the chosen peak
                        # (conf = "this set is on this HR bump", not "on this exact shoulder")

# HR artifact filter (applied to the raw samples before interpolation)
SPIKE_RATE = 15.0       # bpm/s: a step steeper than this is not physiological
SPIKE_MAX_S = 8         # spike = excursion entered and left by opposite steep steps within this many s
                        # (one sample: "steep relative to both neighbours"; a few samples: 113->165->140)
DROPOUT_MIN_S = 30      # flat run at least this long = strap dropout (frozen value) -> gap
DROPOUT_TOL = 1         # bpm: run samples all within this of each other ...
DROPOUT_MODE_FRAC = 0.9  # ... and >= 90 % of them exactly the modal value (real plateaus: <= 0.83)
ARTIFACT_NEAR_S = 10    # a set peak this close to a removed spike / dropout gets its conf capped
ARTIFACT_CONF = 0.25
DROPOUT_MERGE_S = 90    # frozen runs separated by < this many s = one dropout span (live-looking blips between are removed too)
DROPOUT_NEAR_S = 30     # a set peak this close to a dropout span gets its conf capped (spikes: ARTIFACT_NEAR_S)
LOWCONF_STEEP_SETS = 2  # a session with >= 2 steepRise sets is listed as low-confidence
LOWCONF_DROPOUT_S = 60  # a session with >= 60 s of dropouts or >= 3 spikes is listed as low-confidence
LOWCONF_SPIKES = 3


# ----------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------

def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def r1(x):
    return None if x is None else round(float(x), 1)


def r2(x):
    return None if x is None else round(float(x), 2)


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_config(path=CONFIG_PATH):
    cfg = {"gyms": {}, "defaultGym": "unknown", "warmupMin": 18,
           "warmupWindowMin": [15, 22], "hrMax": HR_MAX,
           "mainBlockOffsetMin": MAIN_OFFSET_MIN, "mainBlockTolMin": MAIN_TOL_MIN,
           "anchorSearchMin": ANCHOR_SEARCH_MIN, "endSlackMin": END_SLACK_MIN,
           "anchorRestS": list(ANCHOR_REST_S), "shortRestS": SHORT_REST_S}
    if Path(path).exists():
        cfg.update(load_json(path))
    return cfg


# ----------------------------------------------------------------------------
# set math
# ----------------------------------------------------------------------------

def e1rm(kg, reps, rpe=None, set_type="normal"):
    """RPE-adjusted Epley: RIR = 10 - rpe (0 if no rpe); kg*(1+(reps+RIR)/30).
    None for warm-ups, bodyweight / unloaded or rep-less sets."""
    if set_type == "warmup" or not kg or kg <= 0 or not reps or reps <= 0:
        return None
    rir = (10 - rpe) if rpe is not None else 0
    rir = max(rir, 0)
    return kg * (1 + (reps + rir) / 30.0)


def tonnage(kg, reps):
    if not kg or not reps:
        return 0.0
    return float(kg) * float(reps)


def is_hard(set_type, rpe):
    if set_type == "warmup":
        return False
    if rpe is None:
        return True if set_type == "failure" else None
    return rpe >= 7


def is_failure(set_type, rpe):
    return set_type == "failure" or (rpe is not None and rpe >= 9.5)


# ----------------------------------------------------------------------------
# HR series
# ----------------------------------------------------------------------------

def find_spikes(pts, rate=SPIKE_RATE, max_s=SPIKE_MAX_S):
    """pts: sorted [(t, v)].  Spikes = excursions entered by a step steeper than
    `rate` bpm/s and left, within `max_s` s, by a steep step the other way (a
    single sample steep relative to both neighbours is the 1-sample case).
    Returns [(i0, i1)] index ranges (inclusive) of the samples to drop."""
    out = []
    n = len(pts)
    i = 1
    while i < n - 1:
        (ta, va), (tb, vb) = pts[i - 1], pts[i]
        s_in = (vb - va) / max(tb - ta, 1)
        hit = None
        if abs(s_in) > rate:
            for k in range(i + 1, n):
                (tp, vp), (tk, vk) = pts[k - 1], pts[k]
                if tk - tb > max_s:
                    break
                s_out = (vk - vp) / max(tk - tp, 1)
                if abs(s_out) > rate and s_out * s_in < 0:
                    hit = k
                    break
        if hit is not None:
            out.append((i, hit - 1))
            i = hit
        else:
            i += 1
    return out


def find_dropouts(pts, t_from=0, min_s=DROPOUT_MIN_S, tol=DROPOUT_TOL, mode_frac=DROPOUT_MODE_FRAC):
    """pts: sorted [(t, v)].  Strap dropouts = maximal runs of samples within
    `tol` bpm of each other, >= `min_s` s long (counted from t_from on: the
    main block), with >= mode_frac of the samples exactly at the modal value.
    Returns [(i0, i1)] inclusive index ranges (only the part at t >= t_from)."""
    out = []
    n = len(pts)
    i = 0
    while i < n:
        j, lo, hi = i, pts[i][1], pts[i][1]
        while j + 1 < n and max(hi, pts[j + 1][1]) - min(lo, pts[j + 1][1]) <= tol:
            j += 1
            lo, hi = min(lo, pts[j][1]), max(hi, pts[j][1])
        a = i
        while a <= j and pts[a][0] < t_from:
            a += 1
        if a <= j and pts[j][0] - pts[a][0] >= min_s:
            vals = [v for _, v in pts[a:j + 1]]
            if Counter(vals).most_common(1)[0][1] >= mode_frac * len(vals):
                out.append((a, j))
        i = j + 1
    return out


def filter_artifacts(timestamps, values, dropout_from=0):
    """Drop spike and dropout samples.  Returns (ts, vals, info) with
    info = {spikes, dropoutS, spikeT: [t], dropouts: [[t0, t1]]}.  Dropouts less
    than DROPOUT_MERGE_S apart are merged into one span and every sample between
    them is dropped too (a strap that freezes at several levels leaves short
    live-looking stretches that are not real signal)."""
    pts = {}
    for t, v in zip(timestamps, values):
        if v is not None:
            pts[int(round(t))] = float(v)
    pts = sorted(pts.items())
    drop = set()
    sp = find_spikes(pts)
    spike_t = []
    for a, b in sp:
        drop.update(range(a, b + 1))
        spike_t.extend(pts[k][0] for k in range(a, b + 1))
    do = find_dropouts(pts, dropout_from)
    merged = []                     # frozen runs < DROPOUT_MERGE_S apart -> one span (index range)
    for a, b in do:
        if merged and pts[a][0] - pts[merged[-1][1]][0] < DROPOUT_MERGE_S:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    dropouts = []
    for a, b in merged:
        drop.update(range(a, b + 1))    # includes the live-looking samples between the frozen runs
        dropouts.append([pts[a][0], pts[b][0]])
    kept = [p for k, p in enumerate(pts) if k not in drop]
    info = {"spikes": len(sp), "dropoutS": sum(b - a for a, b in dropouts),
            "spikeT": spike_t, "dropouts": dropouts}
    return [t for t, _ in kept], [v for _, v in kept], info


def near_artifact(t, info, w=ARTIFACT_NEAR_S, w_dropout=DROPOUT_NEAR_S):
    """True if second t is within w s of a removed spike sample or within w_dropout s
    of / inside a (merged) dropout span."""
    if not info or t is None:
        return False
    if any(abs(t - s) <= w for s in info.get("spikeT", [])):
        return True
    return any(a - w_dropout <= t <= b + w_dropout for a, b in info.get("dropouts", []))


def steep_step(raw, a, b, rate=SPIKE_RATE):
    """True if the 1 Hz series steps by more than `rate` bpm between two adjacent
    seconds anywhere in (a, b] (a set's rise tStart -> tPeak).  Interpolated gaps
    carry the sample-to-sample slope, so this is the steepest raw step there.  A
    steep strap step that does not come back within SPIKE_MAX_S survives the spike
    filter; its samples are kept, the set's conf is capped instead."""
    if a is None or b is None:
        return False
    for u in range(max(1, int(a) + 1), min(len(raw), int(b) + 1)):
        p, v = raw[u - 1], raw[u]
        if p is not None and v is not None and abs(v - p) > rate:
            return True
    return False


def build_hr_series(timestamps, values, gap_max=GAP_MAX_S, dropout_from=None, artifacts=None):
    """Return (raw1hz, smooth) lists indexed by second since stream start.
    Linear interpolation over gaps <= gap_max; longer gaps stay None.
    dropout_from (s) given: spikes and (from that second on) strap dropouts are
    removed first (see filter_artifacts); a dict passed as `artifacts` receives
    the filter's info."""
    if dropout_from is not None:
        timestamps, values, info = filter_artifacts(timestamps, values, dropout_from)
        if artifacts is not None:
            artifacts.update(info)
    pts = {}
    for t, v in zip(timestamps, values):
        if v is None:
            continue
        pts[int(round(t))] = float(v)
    if not pts:
        return [], []
    keys = sorted(pts)
    T = keys[-1]
    raw = [None] * (T + 1)
    for a, b in zip(keys, keys[1:]):
        va, vb = pts[a], pts[b]
        raw[a] = va
        if b - a <= gap_max:
            for t in range(a + 1, b):
                raw[t] = va + (vb - va) * (t - a) / (b - a)
    raw[keys[-1]] = pts[keys[-1]]
    return raw, smooth_series(raw)


def smooth_series(raw, med_w=5, mean_w=5):
    n = len(raw)
    hm, hn = med_w // 2, mean_w // 2
    med = [None] * n
    for t in range(n):
        if raw[t] is None:
            continue
        w = [x for x in raw[max(0, t - hm):t + hm + 1] if x is not None]
        med[t] = statistics.median(w)
    out = [None] * n
    for t in range(n):
        if med[t] is None:
            continue
        w = [x for x in med[max(0, t - hn):t + hn + 1] if x is not None]
        out[t] = sum(w) / len(w)
    return out


def detect_candidates(smooth, lo, hi, prom_min=PROM_MIN, min_sep=MIN_SEP_S, win=PROM_WIN_S):
    """Local maxima of the smoothed series within [lo, hi] (tPeak) with a
    windowed prominence >= prom_min, non-max-suppressed to min_sep."""
    n = len(smooth)
    hi = min(hi, n - 1)
    cands = []
    for t in range(max(lo, 1), hi + 1):
        v = smooth[t]
        if v is None:
            continue
        seg = [x for x in smooth[max(0, t - 5):min(n, t + 6)] if x is not None]
        if v < max(seg):
            continue
        p = smooth[t - 1]
        if p is not None and p >= v:   # take the first sample of a plateau
            continue
        lb = v
        for u in range(t - 1, max(-1, t - win - 1), -1):
            x = smooth[u]
            if x is None:
                continue
            if x > v:
                break
            lb = min(lb, x)
        rb = v
        for u in range(t + 1, min(n, t + win + 1)):
            x = smooth[u]
            if x is None:
                continue
            if x > v:
                break
            rb = min(rb, x)
        prom = v - max(lb, rb)
        if prom >= prom_min:
            cands.append({"t": t, "s": v, "prom": prom})
    # non-max suppression by prominence
    kept = []
    for c in sorted(cands, key=lambda c: (-c["prom"], c["t"])):
        if all(abs(c["t"] - k["t"]) >= min_sep for k in kept):
            kept.append(c)
    kept.sort(key=lambda c: c["t"])
    return kept


def set_start(smooth, t_peak, bound, win=PROM_WIN_S):
    """Local minimum preceding the rise: min of smooth in [max(bound, tPeak-win), tPeak];
    returns the latest second within 1 bpm of that minimum."""
    a = max(int(bound), t_peak - win, 0)
    seg = [(u, smooth[u]) for u in range(a, t_peak + 1) if smooth[u] is not None]
    if not seg:
        return t_peak
    m = min(v for _, v in seg)
    last = t_peak
    for u, v in seg:
        if v <= m + 1.0:
            last = u
    return last


def raw_peak(raw, t, w=8):
    best = None
    for u in range(max(0, t - w), min(len(raw), t + w + 1)):
        if raw[u] is not None and (best is None or raw[u] > best):
            best = raw[u]
    return best


# ----------------------------------------------------------------------------
# Hevy: set ordering / effort prior
# ----------------------------------------------------------------------------

def is_inferred_warmup(st, ex_sets):
    """A 'normal' set that is really a ramp-up set: it precedes the first set at
    the exercise's top weight, is lighter, and is either low-rep (<=6 and fewer
    reps than the top-weight sets) or <= 60 % of the top weight; RPE <= 6.5 if given."""
    if st.get("type") != "normal":
        return False
    kg = st.get("weight_kg") or 0
    ws = [x.get("weight_kg") or 0 for x in ex_sets]
    mx = max(ws) if ws else 0
    if mx <= 0 or kg >= mx:
        return False
    idx = st.get("index", 0)
    tops = [x for x in ex_sets if (x.get("weight_kg") or 0) >= mx]
    if not tops or min(x.get("index", 0) for x in tops) < idx:
        return False
    rpe = st.get("rpe")
    if rpe is not None and rpe > 6.5:
        return False
    top_reps = statistics.median([x.get("reps") or 0 for x in tops])
    reps = st.get("reps") or 0
    return (reps <= 6 and reps < top_reps) or kg <= 0.6 * mx


def ordered_sets(workout):
    """Chronological set list (Hevy exercise order x set order; exercises that
    share a superset_id are interleaved round-robin in listed order)."""
    exs = sorted(workout.get("exercises", []), key=lambda e: e.get("index", 0))
    groups = []
    for ex in exs:
        sid = ex.get("superset_id")
        if sid is not None and groups and groups[-1][0] == sid:
            groups[-1][1].append(ex)
        else:
            groups.append((sid, [ex]))
    out = []
    for gi, (sid, members) in enumerate(groups):
        seqs = [sorted(m.get("sets", []), key=lambda s: s.get("index", 0)) for m in members]
        k = 0
        while any(k < len(s) for s in seqs):
            for m, s in zip(members, seqs):
                if k < len(s):
                    out.append({"ex": m, "exIdx": m.get("index", 0), "set": s[k],
                                "setIdx": s[k].get("index", k), "group": gi,
                                "superset": sid is not None and len(members) > 1})
            k += 1
    # effort prior -> expected relative peak size (used only by the matcher)
    first_ex = out[0]["exIdx"] if out else None
    for o in out:
        st = o["set"]
        o["inferredWarmup"] = is_inferred_warmup(st, o["ex"].get("sets", []))
        # a set typed "warmup" but at >= 90 % of the exercise's top weight for >= 8 reps
        # behaves like a work set on the HR trace (e.g. 2026-09-15 w180x12 before 180x12)
        ex_top = max([x.get("weight_kg") or 0 for x in o["ex"].get("sets", [])] or [0])
        heavy_warm = (st.get("type") == "warmup" and ex_top > 0
                      and (st.get("weight_kg") or 0) >= 0.9 * ex_top and (st.get("reps") or 0) >= 8)
        o["heavyWarmup"] = heavy_warm
        warm = (st.get("type") == "warmup" and not heavy_warm) or o["inferredWarmup"]
        rpe = st.get("rpe")
        e = 0.6 if rpe is None else min(1.0, max(0.3, (rpe - 4) / 6.0))
        o["warm"] = warm
        o["effort"] = 0.15 if warm else e
        if warm:
            o["expSize"] = EXP_WARM
        elif o["exIdx"] == first_ex:
            o["expSize"] = EXP_MAIN + 0.2 * e
        else:
            o["expSize"] = EXP_ACC + 0.35 * e
    return out


# ----------------------------------------------------------------------------
# matching
# ----------------------------------------------------------------------------

def _prep_candidates(cands, raw, smooth, n_sets, base):
    if not cands:
        return
    k = max(1, min(n_sets, len(cands)))
    top_p = sorted((c["prom"] for c in cands), reverse=True)[:k]
    P0 = max(statistics.median(top_p), 1.0)
    prev = prev_sig = -10 ** 9
    for c in cands:
        # set start bounded by the previous candidate; the rise (delta) is measured from
        # the trough after the previous *significant* candidate so that small shoulders
        # right before a big peak do not shrink its size
        c["tStart"] = set_start(smooth, c["t"], prev + 5)
        t_low = set_start(smooth, c["t"], prev_sig + 5)
        c["delta"] = c["s"] - (smooth[t_low] if smooth[t_low] is not None else c["s"])
        prev = c["t"]
        if c["prom"] >= 0.5 * P0:
            prev_sig = c["t"]
    top_d = sorted((c["delta"] for c in cands), reverse=True)[:k]
    top_h = sorted((c["s"] for c in cands), reverse=True)[:k]
    P = max(statistics.median(top_p), 1.0)
    D = max(statistics.median(top_d), 1.0)
    H = max(statistics.median(top_h) - base, 5.0)
    for c in cands:
        c["promN"] = min(c["prom"] / P, 1.5)
        c["sizeN"] = min(0.5 * max(c["delta"], 0) / D + 0.5 * max(c["s"] - base, 0) / H, 1.5)
        # height over the DNS baseline only: robust to strap drop-outs that inflate delta (anchor)
        c["hN"] = min(max(c["s"] - base, 0) / H, 1.5)
        c["dN"] = min(max(c["delta"], 0) / D, 1.5)


def _match_score(s, c):
    sc = W_BASE + W_PROM * c["promN"] - W_SIZE * abs(c["sizeN"] - s["expSize"])
    if not s["warm"] and c["promN"] < 0.25:
        sc -= W_WEAK_WORK
    return sc


def _rest_pen(sets, i0, c0, i1, c1, strict=False):
    """Penalty for the rest (next set start - previous peak).  strict (anchor
    matcher): a rest < 30 s is almost never real for this user."""
    gap = c1["tStart"] - c0["t"]
    nskip = i1 - i0 - 1
    if gap < 15:
        return 3.0
    if strict and gap < SHORT_REST_S:
        return 1.5
    same_ex = nskip == 0 and sets[i0]["exIdx"] == sets[i1]["exIdx"]
    same_ss = sets[i0]["superset"] and sets[i0]["group"] == sets[i1]["group"]
    lower = 15 if same_ss else 45
    upper = (240 if same_ex or same_ss else 420) * (nskip + 1)
    if gap < lower:
        return 0.03 * (lower - gap)
    if gap > upper:
        return 0.6 * (gap - upper) / 120.0
    return 0.0


def match_dp(sets, cands, prior_start, end_t=None, strict=False, alt_sep=0):
    """Order-preserving alignment of sets to candidate peaks.
    end_t: if given, penalise a last matched peak earlier than end_t (the main
    block ends at the stream end); strict: stricter short-rest penalty;
    alt_sep: confidence ignores alternative peaks within alt_sep s of the chosen one.
    Returns (assign: list[cand index or None], conf: list[float])."""
    N, M = len(sets), len(cands)
    if N == 0:
        return [], []
    if M == 0:
        return [None] * N, [0.0] * N
    NEG = -1e18
    skip = [SKIP_PEAK * c["promN"] for c in cands]
    pre_skip = [SKIP_PEAK * c["promN"] * (PRE_SKIP_W if c["t"] < prior_start - 60 else 1.0) for c in cands]
    cs = [0.0]
    for x in skip:
        cs.append(cs[-1] + x)
    cpre = [0.0]
    for x in pre_skip:
        cpre.append(cpre[-1] + x)
    ms = [[_match_score(sets[i], cands[j]) for j in range(M)] for i in range(N)]

    def start_cost(i, j):
        dev = cands[j]["tStart"] - (prior_start + 150 * i)
        pen = START_EARLY * (-dev) / 60.0 if dev < 0 else START_LATE * max(0.0, dev - START_SLACK_S) / 60.0
        return SKIP_SET * i + cpre[j] + pen

    def end_cost(i, j):
        c = SKIP_SET * (N - 1 - i) + (cs[M] - cs[j + 1])
        if end_t is not None:
            c += END_W * max(0.0, end_t - cands[j]["t"]) / 60.0
        return c

    def trans(i0, j0, i1, j1):
        return (-SKIP_SET * (i1 - i0 - 1) - (cs[j1] - cs[j0 + 1])
                - _rest_pen(sets, i0, cands[j0], i1, cands[j1], strict))

    F = [[NEG] * M for _ in range(N)]
    BP = [[None] * M for _ in range(N)]
    for i in range(N):
        for j in range(M):
            best, arg = -start_cost(i, j), None
            for i0 in range(max(0, i - MAX_SET_SKIP - 1), i):
                row = F[i0]
                for j0 in range(j):
                    if row[j0] > NEG:
                        v = row[j0] + trans(i0, j0, i, j)
                        if v > best:
                            best, arg = v, (i0, j0)
            F[i][j] = best + ms[i][j]
            BP[i][j] = arg
    B = [[NEG] * M for _ in range(N)]
    for i in range(N - 1, -1, -1):
        for j in range(M - 1, -1, -1):
            best = -end_cost(i, j)
            for i1 in range(i + 1, min(N, i + MAX_SET_SKIP + 2)):
                for j1 in range(j + 1, M):
                    if B[i1][j1] > NEG:
                        v = trans(i, j, i1, j1) + ms[i1][j1] + B[i1][j1]
                        if v > best:
                            best = v
            B[i][j] = best
    empty = -(SKIP_SET * N + cpre[M])
    best_total, bi, bj = empty, None, None
    for i in range(N):
        for j in range(M):
            v = F[i][j] - end_cost(i, j)
            if v > best_total + 1e-12:
                best_total, bi, bj = v, i, j
    assign = [None] * N
    if bi is not None:
        # backtrack
        cur = (bi, bj)
        while cur is not None:
            assign[cur[0]] = cur[1]
            cur = BP[cur[0]][cur[1]]
    conf = []
    for i in range(N):
        j = assign[i]
        if j is None:
            conf.append(0.0)
            continue
        mm = F[i][j] + B[i][j]
        alt = max([F[i][k] + B[i][k] for k in range(M)
                   if k != j and abs(cands[k]["t"] - cands[j]["t"]) > alt_sep] or [NEG])
        margin = mm - alt if alt > NEG else 10.0
        q = min(1.0, 0.4 + 0.6 * cands[j]["promN"])
        conf.append(max(0.0, (1 - math.exp(-max(margin, 0.0) / 0.8)) * q))
    return assign, conf


def match_topn(sets, cands):
    N = len(sets)
    top = sorted(range(len(cands)), key=lambda j: (-cands[j]["prom"], cands[j]["t"]))[:N]
    top.sort()
    assign = [None] * N
    conf = [0.0] * N
    for i, j in enumerate(top):
        assign[i] = j
        conf[i] = 0.5 * min(1.0, cands[j]["promN"])
    return assign, conf


def _emit(sets, assign, conf, cands, raw, smooth, cfg, first_win=None):
    """Per-set match dicts from an assignment (indices into cands).  first_win:
    limit (s) of the first matched set's start search (no previous peak bounds it)."""
    T = len(raw) - 1
    short = cfg.get("shortRestS", SHORT_REST_S)
    out = []
    prev_peak = None
    matched_ts = [cands[j]["t"] if j is not None else None for j in assign]
    for i, j in enumerate(assign):
        if j is None:
            out.append({k: None for k in ("tPeak", "peakHR", "tStart", "hrStart", "riseS",
                                          "hrDelta", "restBeforeS", "hrr30", "hrr60")} | {"conf": 0.0})
            continue
        c = cands[j]
        tp = c["t"]
        if prev_peak is not None:
            bound = prev_peak + 5
        else:
            bound = tp - first_win if first_win else -10 ** 9
        ts_ = set_start(smooth, tp, bound)
        pk = raw_peak(raw, tp)
        hs = raw[ts_]
        nxt = next((matched_ts[k] for k in range(i + 1, len(assign)) if matched_ts[k] is not None), None)
        nxt_start = None
        if nxt is not None:
            nxt_start = set_start(smooth, nxt, tp + 5)

        def hrr(dt_):
            u = tp + dt_
            if u > T or raw[u] is None or pk is None:
                return None
            if nxt_start is not None and nxt_start < u:
                return None
            return pk - raw[u]

        rest = (ts_ - prev_peak) if prev_peak is not None else None
        cf = conf[i]
        row = {"tPeak": tp, "peakHR": r1(pk), "tStart": ts_, "hrStart": r1(hs),
               "riseS": tp - ts_,
               "hrDelta": r1(pk - hs) if (pk is not None and hs is not None) else None,
               "restBeforeS": rest, "hrr30": r1(hrr(30)), "hrr60": r1(hrr(60))}
        if rest is not None and rest < short:       # almost never real for this user
            cf = min(cf, SHORT_REST_CONF)
            row["shortRest"] = True
        row["conf"] = r2(cf)
        out.append(row)
        prev_peak = tp
    return out


def _dns_base(smooth, lo):
    return median(smooth[max(0, lo - 300):lo]) or median(smooth[:lo]) or 0.0


def anchor_split(sets):
    """(pre, anchor): ordered-list indices of exercise 1's sets before its main
    work sets, and of the main work sets themselves (the anchor: the first
    contiguous run of non-warm-up sets at >= 85 % of the median work weight,
    at most ANCHOR_MAX_K).  anchor == [] when there is no usable anchor
    (no work set, or exercise 1 interleaved in a superset)."""
    if not sets:
        return [], []
    e0 = sets[0]["exIdx"]
    ex1 = [i for i, o in enumerate(sets) if o["exIdx"] == e0]
    if any(sets[i]["superset"] for i in ex1):
        return [], []
    work = [i for i in ex1 if not sets[i]["warm"]]
    if not work:
        return [], []
    ref = statistics.median([sets[i]["set"].get("weight_kg") or 0 for i in work])
    qual = {i for i in work if ref <= 0 or (sets[i]["set"].get("weight_kg") or 0) >= ANCHOR_KG_FRAC * ref}
    first = min(qual)
    run = []
    for i in ex1[ex1.index(first):]:
        if i not in qual:
            break
        run.append(i)
    run = run[:ANCHOR_MAX_K]
    pre = [i for i in ex1 if i < run[0]]
    if run != list(range(run[0], run[0] + len(run))) or pre != list(range(run[0])):
        return [], []
    return pre, run


def find_anchor(cands, k, n_pre, t1_lo, t1_hi, t_floor, exp_t1, cfg, trace=None):
    """Best k-tuple of candidate indices for exercise 1's main work sets: big,
    similar, well separated peaks with nothing big in between, room for the
    exercise-1 warm-up sets before it and nothing bigger there.
    Returns (tuple, score, per-position conf) or (None, None, None)."""
    rlo, rhi = cfg.get("anchorRestS", list(ANCHOR_REST_S))
    g_lo, g_hi = rlo + ANCHOR_RISE_S[0], rhi + ANCHOR_RISE_S[1]
    M = len(cands)
    ts = [c["t"] for c in cands]

    def size(c):
        return ANCHOR_SIZE_W[0] * c["hN"] + ANCHOR_SIZE_W[1] * c["dN"]

    def score(tup, parts=None):
        hs = [cands[j]["s"] for j in tup]
        floor_ = min(hs) - BIG_MARGIN
        p = {"peaks": sum(A_BASE + A_SIZE * size(cands[j]) + A_PROM * cands[j]["promN"] for j in tup),
             "sim": -A_SIM * (max(hs) - min(hs)) / 10.0, "gap": 0.0, "int": 0.0, "big": 0.0}
        for a, b in zip(tup, tup[1:]):
            g = ts[b] - ts[a]
            if g < g_lo:
                p["gap"] -= A_GAP * (g_lo - g) / 60.0
            elif g > g_hi:
                p["gap"] -= A_GAP * (g - g_hi) / 60.0
        inside = set(tup)
        t_end = ts[tup[-1]] + g_hi
        for j in range(tup[0] + 1, M):
            if ts[j] > t_end:
                break
            if j in inside:
                continue
            over = max(0.0, cands[j]["s"] - floor_) / 5.0
            if j < tup[-1]:
                p["int"] -= A_INT * cands[j]["promN"]
                p["big"] -= A_BIG * over
            else:
                p["big"] -= A_BIG_AFTER * over
        t1 = ts[tup[0]]
        pre = [c for c in cands if max(t_floor, t1 - PRE_ANCHOR_S) <= c["t"] <= t1 - PRE_ANCHOR_MIN_S]
        p["wu"] = -A_WU * max(0, n_pre - len(pre))
        p["dom"] = -A_DOM * max(0.0, max(c["s"] for c in pre) - floor_) / 5.0 if pre else 0.0
        p["pos"] = -A_POS * max(0.0, abs(t1 - exp_t1) - 300) / 60.0
        if parts is not None:
            parts.update(p)
        return sum(p.values())

    best, best_tup = -1e18, None
    by_pos = [defaultdict(lambda: -1e18) for _ in range(k)]

    def rec(tup):
        nonlocal best, best_tup
        if len(tup) == k:
            if trace is not None:
                parts = {}
                sc = score(tup, parts)
                trace.append((sc, tuple(tup), parts))
            else:
                sc = score(tup)
            if sc > best:
                best, best_tup = sc, tuple(tup)
            for m, j in enumerate(tup):
                if sc > by_pos[m][j]:
                    by_pos[m][j] = sc
            return
        for j in range(tup[-1] + 1, M):
            g = ts[j] - ts[tup[-1]]
            if g < ANCHOR_GAP_S[0]:
                continue
            if g > ANCHOR_GAP_S[1]:
                break
            tup.append(j)
            rec(tup)
            tup.pop()

    for j1 in range(M):
        if t1_lo <= ts[j1] <= t1_hi:
            rec([j1])
    if best_tup is None:
        return None, None, None
    conf = []
    for m, j in enumerate(best_tup):
        alt = max([v for jj, v in by_pos[m].items() if abs(ts[jj] - ts[j]) > ALT_SEP_S] or [-1e18])
        margin = best - alt if alt > -1e17 else 10.0
        q = min(1.0, 0.4 + 0.6 * cands[j]["promN"])
        conf.append(max(0.0, (1 - math.exp(-max(margin, 0.0) / 0.8)) * q))
    return best_tup, best, conf


def match_pre_anchor(sets, pre, cands, win, anchor_i, anchor_j, strict=True):
    """Exercise 1's warm-up sets -> ordered subset of the candidates `win`
    (indices into cands, all before the anchor).  Exhaustive (few sets, few
    candidates).  Candidates before the first matched one are free (DNS /
    walking bumps); skipped ones between it and the anchor cost as in the DP."""
    n = len(pre)
    if n == 0:
        return [], []
    NEG = -1e18
    best = {}
    top = (NEG, None)
    for r in range(0, min(n, len(win)) + 1):
        for S in itertools.combinations(range(n), r):
            for C in itertools.combinations(win, r):
                sc = -SKIP_SET * (n - r)
                for m in range(r):
                    sc += _match_score(sets[pre[S[m]]], cands[C[m]])
                    if m:
                        sc -= _rest_pen(sets, pre[S[m - 1]], cands[C[m - 1]], pre[S[m]], cands[C[m]], strict)
                if r:
                    sc -= _rest_pen(sets, pre[S[-1]], cands[C[-1]], anchor_i, cands[anchor_j], strict)
                    used = set(C)
                    sc -= sum(SKIP_PEAK * cands[j]["promN"] for j in win if j > C[0] and j not in used)
                for m in range(r):
                    key = (S[m], C[m])
                    if sc > best.get(key, NEG):
                        best[key] = sc
                if sc > top[0]:
                    top = (sc, (S, C))
    assign = [None] * n
    conf = [0.0] * n
    if top[1] is None:
        return assign, conf
    S, C = top[1]
    for m in range(len(S)):
        i, j = S[m], C[m]
        assign[i] = j
        alt = max([v for (ii, jj), v in best.items()
                   if ii == i and abs(cands[jj]["t"] - cands[j]["t"]) > ALT_SEP_S] + [NEG])
        margin = top[0] - alt if alt > NEG else 10.0
        q = min(1.0, 0.4 + 0.6 * cands[j]["promN"])
        conf[i] = max(0.0, (1 - math.exp(-max(margin, 0.0) / 0.8)) * q)
    return assign, conf


def _match_anchor(sets, raw, smooth, cfg):
    """Anchor-first matcher (default).  Returns (assign, conf, cands, info)."""
    T = len(raw) - 1
    N = len(sets)
    t_floor = int(cfg.get("warmupWindowMin", [15, 22])[0] * 60)
    off = cfg.get("mainBlockOffsetMin", MAIN_OFFSET_MIN) * 60
    L = max(0, T - off)                               # expected main-block length
    ms_exp = T - L                                    # expected main-block start (s)
    tol = cfg.get("mainBlockTolMin", MAIN_TOL_MIN) * 60
    # anchor's first peak: [15 min, Garmin end - (L - tol) + 15 min]
    t1_hi = ms_exp + tol + cfg.get("anchorSearchMin", ANCHOR_SEARCH_MIN) * 60
    end_t = T - cfg.get("endSlackMin", END_SLACK_MIN) * 60
    base = _dns_base(smooth, t_floor)
    cands = detect_candidates(smooth, max(0, t_floor - 150), T)
    _prep_candidates(cands, raw, smooth, N, base)
    for gi, c in enumerate(cands):
        c["gi"] = gi
    top_h = sorted((c["s"] for c in cands if c["t"] >= t_floor), reverse=True)[:max(1, N)]
    h_set = statistics.median(top_h) if top_h else base
    info = {"expectedMainMin": r1(L / 60), "expectedMainStartS": int(ms_exp), "dnsBaseHR": r1(base),
            "strongThrHR": r1(base + max(STRONG_MIN, STRONG_FRAC * (h_set - base)))}   # informational
    pre, run = anchor_split(sets)
    assign = [None] * N
    conf = [0.0] * N
    anchor = None
    fwd_sets, fwd_c, prior = list(range(N)), [c for c in cands if c["t"] >= t_floor], ms_exp
    if run:
        exp_t1 = ms_exp + 150 * len(pre)
        tup, sc, aconf = find_anchor(cands, len(run), len(pre), t_floor, t1_hi, t_floor, exp_t1, cfg)
        if tup is not None:
            for m, i in enumerate(run):
                assign[i], conf[i] = tup[m], aconf[m]
            anchor = {"exercise": sets[run[0]]["ex"].get("title"), "tPeaks": [cands[j]["t"] for j in tup],
                      "score": r2(sc), "sets": len(run)}
            t1 = cands[tup[0]]["t"]
            win = [j for j, c in enumerate(cands)
                   if max(t_floor, t1 - PRE_ANCHOR_S) <= c["t"] <= t1 - PRE_ANCHOR_MIN_S]
            pa, pc = match_pre_anchor(sets, pre, cands, win, run[0], tup[0])
            for m, i in enumerate(pre):
                assign[i], conf[i] = pa[m], pc[m]
            t_last = cands[tup[-1]]["t"]
            fwd_sets = list(range(run[-1] + 1, N))
            fwd_c = [c for c in cands if c["t"] > t_last]       # never reach back before the anchor
            prior = t_last + 90
    if fwd_sets:
        fa, fc = match_dp([sets[i] for i in fwd_sets], fwd_c, prior, end_t=end_t, strict=True,
                          alt_sep=ALT_SEP_S)
        for m, i in enumerate(fwd_sets):
            assign[i] = fwd_c[fa[m]]["gi"] if fa[m] is not None else None
            conf[i] = fc[m]
    info["anchor"] = anchor
    info["method"] = "anchor" if anchor else "anchor-fallback"
    return assign, conf, cands, info


def _match_legacy(sets, raw, smooth, cfg, hevy_window, method):
    """The previous matcher (kept for comparison): warm-up end = first strong
    set peak in the 15-22 min window, optional Hevy-time window cut, DP over the
    whole main block.  Returns (assign, conf, cands, info)."""
    T = len(raw) - 1
    wlo, whi = cfg.get("warmupWindowMin", [15, 22])
    lo = int(wlo * 60)
    hi = T
    if hevy_window:            # Hevy end is reliable when the times are consistent
        hi = max(lo + 60, min(T, int(hevy_window[1]) + 120))
    base = _dns_base(smooth, lo)
    all_c = detect_candidates(smooth, lo, hi)
    top_h = sorted((c["s"] for c in all_c), reverse=True)[:max(1, len(sets))]
    h_set = statistics.median(top_h) if top_h else base
    thr = base + max(STRONG_MIN, STRONG_FRAC * (h_set - base))
    strong, prev_t = None, -10 ** 9
    for c in all_c:
        if c["t"] > whi * 60 + 180:
            break
        if c["s"] >= thr and c["prom"] >= STRONG_PROM:
            strong = c
            break
        prev_t = c["t"]
    if strong is not None:
        main_start = set_start(smooth, strong["t"], prev_t + 5)
        detect = "strong-peak"
    else:
        main_start = int(cfg.get("warmupMin", 18) * 60)
        detect = "default"
    cands = [c for c in all_c if c["t"] >= main_start - PRE_WIN_S]
    _prep_candidates(cands, raw, smooth, len(sets), base)
    used = "dp_legacy" if method in ("dp", "dp_legacy") else method
    try:
        if method == "topn":
            assign, conf = match_topn(sets, cands)
        else:
            assign, conf = match_dp(sets, cands, main_start)
    except Exception as e:  # pragma: no cover - defensive fallback
        print(f"  DP failed ({e!r}); falling back to top-N", file=sys.stderr)
        assign, conf = match_topn(sets, cands)
        used = "topn-fallback"
    info = {"method": used, "warmupDetect": detect, "mainStartS": int(main_start), "dnsBaseHR": r1(base),
            "strongThrHR": r1(thr), "hevyTimesUsed": bool(hevy_window), "mainEndS": int(hi)}
    return assign, conf, cands, info


def match_session(sets, raw, smooth, cfg, hevy_window=None, method="anchor", artifacts=None):
    """Match ordered sets to HR peaks.  method: anchor (default), dp_legacy
    (alias dp) or topn.  hevy_window = (startS, endS) relative to HR start is
    used by dp_legacy / topn only.  artifacts: filter_artifacts info; a set whose
    peak lies within ARTIFACT_NEAR_S of a removed spike or DROPOUT_NEAR_S of a
    (merged) dropout span gets its conf capped at ARTIFACT_CONF (nearArtifact); so does a set whose rise tStart -> tPeak
    holds a step > SPIKE_RATE bpm/s (steep_step: nearArtifact + steepRise).
    Returns (per-set match dicts, quality dict)."""
    T = len(raw) - 1
    if method == "anchor":
        assign, conf, cands, info = _match_anchor(sets, raw, smooth, cfg)
    else:
        assign, conf, cands, info = _match_legacy(sets, raw, smooth, cfg, hevy_window, method)
    out = _emit(sets, assign, conf, cands, raw, smooth, cfg,
                first_win=FIRST_SET_WIN_S if method == "anchor" else None)
    for o in out:
        if o["tPeak"] is None:
            continue
        steep = steep_step(raw, o["tStart"], o["tPeak"])
        if steep or near_artifact(o["tPeak"], artifacts):
            o["conf"] = r2(min(o["conf"], ARTIFACT_CONF))
            o["nearArtifact"] = True
        if steep:
            o["steepRise"] = True
    matched = sum(1 for o in out if o["tPeak"] is not None)
    first = next((o for o in out if o["tPeak"] is not None), None)
    first_idx = next((i for i, o in enumerate(out) if o["tPeak"] is not None), None)
    lo = int(cfg.get("warmupWindowMin", [15, 22])[0] * 60)
    if first is not None and first_idx == 0:
        wu_end = first["tStart"]
    elif first is not None:
        wu_end = max(lo, first["tStart"] - 150 * first_idx)
    else:
        wu_end = int(info.get("mainStartS", info.get("expectedMainStartS", lo)))
    confs = [o["conf"] for o in out]
    rests = [o["restBeforeS"] for o in out if o["restBeforeS"] is not None]
    peaks = [o["tPeak"] for o in out if o["tPeak"] is not None]
    quality = {"method": info["method"], "expected": len(sets), "candidates": len(cands),
               "matched": matched, "conf": r2(median(confs) or 0.0),
               "warmupEndS": int(wu_end), "warmupDetect": info.get("warmupDetect", "anchor"),
               "mainStartS": int(info.get("mainStartS", wu_end)),
               "dnsBaseHR": info.get("dnsBaseHR"), "strongThrHR": info.get("strongThrHR"),
               "hevyTimesUsed": info.get("hevyTimesUsed", False), "mainEndS": int(info.get("mainEndS", T)),
               "anchor": info.get("anchor"),
               "confSetsPct": r1(100.0 * sum(1 for c in confs if c >= 0.5) / len(confs)) if confs else None,
               "shortRests": sum(1 for o in out if o.get("shortRest")),
               "nearArtifact": sum(1 for o in out if o.get("nearArtifact")),
               "minRestS": min(rests) if rests else None,
               "lastPeakS": max(peaks) if peaks else None, "streamEndS": T}
    if quality["anchor"]:
        quality["anchor"]["peakHR"] = [r1(raw_peak(raw, t)) for t in quality["anchor"]["tPeaks"]]
    if "expectedMainMin" in info:
        quality["expectedMainMin"] = info["expectedMainMin"]
    return out, quality


# ----------------------------------------------------------------------------
# templates
# ----------------------------------------------------------------------------

def read_api_key():
    if not SECRETS_PATH.exists():
        return None
    for line in SECRETS_PATH.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("HEVY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def fetch_templates():
    key = read_api_key()
    if not key:
        raise SystemExit("HEVY_API_KEY not found in secrets/hevy.env")
    out, page = [], 1
    while True:
        req = urllib.request.Request(
            f"https://api.hevyapp.com/v1/exercise_templates?page={page}&pageSize=100",
            headers={"api-key": key, "accept": "application/json",
                     "User-Agent": "daily-dashboard-build-strength/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                d = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            raise SystemExit(f"template fetch failed on page {page}: {type(e).__name__} {getattr(e, 'code', '')}")
        for t in d.get("exercise_templates", []):
            out.append({k: t.get(k) for k in ("id", "title", "type", "primary_muscle_group",
                                               "secondary_muscle_groups", "equipment", "is_custom")})
        pc = d.get("page_count", page)
        if page >= pc:
            break
        page += 1
    TEMPLATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(TEMPLATES_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    return out


def load_templates(refresh=False):
    if refresh or not TEMPLATES_PATH.exists():
        return fetch_templates()
    return load_json(TEMPLATES_PATH)


def workout_template_ids(raw_dir):
    ids = set()
    for f in glob.glob(str(Path(raw_dir) / "hevy" / "*.json")):
        for ex in load_json(f).get("exercises", []):
            if ex.get("exercise_template_id"):
                ids.add(ex["exercise_template_id"])
    return ids


def ensure_templates(templates, raw_dir, refreshed=False, fetch=None):
    """Refresh the template cache once (same path as --refresh-templates) when a
    cached workout uses an exercise_template_id it does not know.  On API
    failure the cached list is kept (unknown exercises -> muscle 'other')."""
    missing = workout_template_ids(raw_dir) - {t["id"] for t in templates}
    if not missing or refreshed:
        if missing:
            print(f"templates: {len(missing)} template id(s) still unknown after refresh -> 'other'")
        return templates
    print(f"templates: {len(missing)} unknown template id(s) in workouts -> refreshing template cache")
    try:
        templates = (fetch or fetch_templates)()
    except (SystemExit, Exception) as e:     # fetch_templates reports failures via SystemExit
        print(f"templates: refresh failed ({e}); unknown exercises stay 'other'")
        return templates
    left = missing - {t["id"] for t in templates}
    if left:
        print(f"templates: {len(left)} template id(s) still unknown after refresh -> 'other'")
    return templates


# ----------------------------------------------------------------------------
# loading raw data
# ----------------------------------------------------------------------------

HR_SAME_ACTIVITY_S = 120     # strava_hr and garmin_hr starts this close = the same activity


def _load_hr_dir(raw_dir, sub, source):
    out = []
    for f in sorted(glob.glob(str(Path(raw_dir) / sub / "*.json"))):
        d = load_json(f)
        name = Path(f).stem
        date, _, act = name.partition("_")
        st = parse_ts(d["startTime"])
        ts = d.get("timestamps") or []
        vals = (d.get("streams", {}).get("heart_rate") or {}).get("values") or []
        out.append({"date": date, "activityId": act, "start": st,
                    "end": st + dt.timedelta(seconds=ts[-1] if ts else 0),
                    "ts": ts, "vals": vals, "file": name, "source": source})
    return out


def load_hr_sessions(raw_dir):
    """HR inputs: raw/strava_hr (1 s, machine-fetched) is preferred over raw/garmin_hr
    when both hold the same activity (start times within HR_SAME_ACTIVITY_S); a Strava
    file with no Garmin twin is used as is. Each session carries source = strava|garmin."""
    strava = _load_hr_dir(raw_dir, "strava_hr", "strava")
    garmin = [g for g in _load_hr_dir(raw_dir, "garmin_hr", "garmin")
              if not any(abs((g["start"] - s["start"]).total_seconds()) <= HR_SAME_ACTIVITY_S
                         for s in strava)]
    return sorted(strava + garmin, key=lambda h: (h["date"], h["start"]))


def _overlap_frac(w, sessions):
    s, e = parse_ts(w["start_time"]), parse_ts(w["end_time"])
    dur = max((e - s).total_seconds(), 1)
    best = 0.0
    for h in sessions:
        ov = (min(e, h["end"]) - max(s, h["start"])).total_seconds()
        best = max(best, ov / dur)
    return best


def load_hevy(raw_dir, hr_sessions):
    by_id = defaultdict(list)
    for f in sorted(glob.glob(str(Path(raw_dir) / "hevy" / "*.json"))):
        d = load_json(f)
        d["_file"] = Path(f).name
        by_id[d["id"]].append(d)
    chosen, dups = [], []
    for wid, copies in by_id.items():
        if len(copies) == 1:
            chosen.append(copies[0])
            continue
        # exercises / sets always from the newest copy (latest edit); its times are
        # used unless they overlap no HR session while another copy's times do
        copies.sort(key=lambda c: c.get("updated_at") or "", reverse=True)
        win = copies[0]
        rule = "newest-updated_at"
        times_from = win["_file"]
        if _overlap_frac(win, hr_sessions) <= 0:
            alt = max(copies[1:], key=lambda c: _overlap_frac(c, hr_sessions))
            if _overlap_frac(alt, hr_sessions) > 0:
                win = dict(win, start_time=alt["start_time"], end_time=alt["end_time"])
                times_from = alt["_file"]
                rule = "newest-updated_at; times from hr-overlapping copy"
        chosen.append(win)
        same = all(json.dumps(c["exercises"], sort_keys=True) == json.dumps(win["exercises"], sort_keys=True)
                   for c in copies)
        dups.append({"id": wid, "chosen": win["_file"], "rule": rule,
                     "copies": [c["_file"] for c in copies], "exercisesIdentical": same,
                     "timesFrom": times_from})
    chosen.sort(key=lambda w: w["start_time"])
    return chosen, dups


# ----------------------------------------------------------------------------
# gyms
# ----------------------------------------------------------------------------

def workout_texts(w):
    return [w.get("title") or "", w.get("description") or ""] + \
           [e.get("notes") or "" for e in w.get("exercises", [])]


def derive_gym(w, cfg):
    hits = Counter()
    txt = workout_texts(w)
    for pat, name in cfg.get("gyms", {}).items():
        rx = re.compile(pat, re.I)
        for t in txt:
            if rx.search(t):
                hits[name] += 1
    if not hits:
        return cfg.get("defaultGym", "unknown")
    top = max(hits.values())
    for pat, name in cfg.get("gyms", {}).items():   # config order breaks ties
        if hits.get(name) == top:
            return name


# equipment whose kit differs between gyms (machine-like; a missing template counts
# too).  Barbell / dumbbell / kettlebell / bodyweight / plate kit is the same
# everywhere and never tells the gyms apart.
GYM_EQUIPMENT = {"machine", "cable", "other", None, ""}


def machine_tokens(note, cfg):
    """Machine-descriptor tokens (cfg machineTokens, whole words, case-insensitive)
    present in an exercise note, in config order."""
    if not note:
        return []
    out = []
    for tok in cfg.get("machineTokens", []):
        pat = r"(?<!\w)" + r"\s+".join(re.escape(p) for p in tok.split()) + r"(?!\w)"
        if re.search(pat, note, re.I):
            out.append(tok.lower())
    return out


def gym_features(w, cfg, tmpl):
    """[(feature, label)] of a workout's gym-specific exercises: (templateId, None)
    per machine-like exercise, plus (templateId, token) per machine token in its notes."""
    out = []
    for ex in w.get("exercises", []):
        tid = ex.get("exercise_template_id")
        if not tid:
            continue
        if (tmpl.get(tid) or {}).get("equipment") not in GYM_EQUIPMENT:
            continue
        title = ex.get("title") or tid
        out.append(((tid, None), title))
        for tok in machine_tokens(ex.get("notes"), cfg):
            out.append(((tid, tok), f"{title} [{tok}]"))
    return out


def infer_gyms(workouts, cfg, tmpl):
    """{workout id: (gym, gymSource, evidence)}.  explicit = a gym token in the
    title / description / notes (derive_gym).  Only explicit workouts define which
    gym-specific features (gym_features) are exclusive to one gym (seen in that
    gym's explicit workouts only; no propagation from inferred workouts).  A
    workout without a token -> gym G ("inferred", evidence = feature labels) when it
    has >= 1 feature exclusive to G and none exclusive to another gym; features of
    several gyms -> "conflict" (gym stays unknown); no exclusive feature -> "none"."""
    unknown = cfg.get("defaultGym", "unknown")
    res = {}
    seen = defaultdict(set)
    for w in workouts:
        g = derive_gym(w, cfg)
        if g != unknown:
            res[w["id"]] = (g, "explicit", [])
            for f, _ in gym_features(w, cfg, tmpl):
                seen[f].add(g)
    for w in workouts:
        if w["id"] in res:
            continue
        ev = defaultdict(list)
        for f, lab in gym_features(w, cfg, tmpl):
            gs = seen.get(f)
            if gs and len(gs) == 1:
                g = next(iter(gs))
                if lab not in ev[g]:
                    ev[g].append(lab)
        if len(ev) == 1:
            g, labs = next(iter(ev.items()))
            res[w["id"]] = (g, "inferred", labs)
        elif ev:
            res[w["id"]] = (unknown, "conflict", [f"{lab} ({g})" for g in sorted(ev) for lab in ev[g]])
        else:
            res[w["id"]] = (unknown, "none", [])
    return res


def gym_summary(workouts):
    """Counts: explicit / inferred per gym, conflict, unknown (no evidence)."""
    s = {"explicit": {}, "inferred": {}, "conflict": 0, "unknown": 0}
    for wo in workouts:
        src = wo.get("gymSource")
        if src in ("explicit", "inferred"):
            s[src][wo["gym"]] = s[src].get(wo["gym"], 0) + 1
        elif src == "conflict":
            s["conflict"] += 1
        else:
            s["unknown"] += 1
    return s


def note_tokens(workouts):
    """Distinct lower-cased note/description tokens with counts (for gym seeding)."""
    c = Counter()
    for w in workouts:
        for t in workout_texts(w)[1:]:
            for tok in re.findall(r"[a-zA-ZÀ-ſ0-9]+", t.lower()):
                c[tok] += 1
    return c


# ----------------------------------------------------------------------------
# analytics
# ----------------------------------------------------------------------------

def trimp(raw, a, b, hr_max=HR_MAX):
    tot = 0.0
    for t in range(max(0, a), min(len(raw), b)):
        v = raw[t]
        if v is None:
            continue
        p = v / hr_max
        if p < 0.5:
            continue
        z = 5 if p >= 0.9 else 4 if p >= 0.8 else 3 if p >= 0.7 else 2 if p >= 0.6 else 1
        tot += z / 60.0
    return tot


def week_monday(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def slope_per_week(pts):
    """pts: [(date, y)] -> OLS slope in y units per 7 days."""
    pts = [(p[0], p[1]) for p in pts if p[1] is not None]
    if len(pts) < 3:
        return None
    x0 = pts[0][0]
    xs = [(d - x0).days for d, _ in pts]
    ys = [y for _, y in pts]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    return 7 * sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx


def build(raw_dir, cfg, templates, method="anchor"):
    method = "dp_legacy" if method == "dp" else method
    hr_sessions = load_hr_sessions(raw_dir)
    workouts_raw, dups = load_hevy(raw_dir, hr_sessions)
    tmpl = {t["id"]: t for t in templates}
    hr_max = cfg.get("hrMax", HR_MAX)

    # join HR <-> Hevy by date (best overlap when several)
    by_date = defaultdict(list)
    for w in workouts_raw:
        by_date[w["start_time"][:10]].append(w)
    hr_for = {}
    orphans = []
    for h in hr_sessions:
        cands = [w for w in by_date.get(h["date"], []) if w["id"] not in hr_for]
        if not cands:
            orphans.append(h)
            continue
        cands.sort(key=lambda w: _overlap_frac(w, [h]), reverse=True)
        hr_for[cands[0]["id"]] = h

    muscles_seen = set()
    workouts = []
    match_rows = []
    art_from = int(cfg.get("warmupWindowMin", [15, 22])[0] * 60)   # dropouts: main block only
    gyms = infer_gyms(workouts_raw, cfg, tmpl)
    for w in workouts_raw:
        date = w["start_time"][:10]
        st, en = parse_ts(w["start_time"]), parse_ts(w["end_time"])
        gym, gym_src, gym_ev = gyms[w["id"]]
        sets = ordered_sets(w)
        h = hr_for.get(w["id"])
        match, quality, raw = None, None, None
        arts = {}
        if h is not None:
            raw, smooth = build_hr_series(h["ts"], h["vals"], dropout_from=art_from, artifacts=arts)
            ov = (min(en, h["end"]) - max(st, h["start"])).total_seconds()
            hevy_dur = max((en - st).total_seconds(), 1)
            win = None
            if ov / hevy_dur > 0.5:
                win = ((st - h["start"]).total_seconds(), (en - h["start"]).total_seconds())
            match, quality = match_session(sets, raw, smooth, cfg, win, method, artifacts=arts)
            quality["hevyOverlap"] = r2(max(0.0, ov / hevy_dur))
            match_rows.append((date, w["title"], quality))

        set_rows = []
        for k, o in enumerate(sets):
            s = o["set"]
            kg, reps, rpe, typ = s.get("weight_kg"), s.get("reps"), s.get("rpe"), s.get("type") or "normal"
            row = {"ex": o["exIdx"], "set": o["setIdx"], "type": typ, "kg": kg, "reps": reps, "rpe": rpe,
                   "e1rm": r1(e1rm(kg, reps, rpe, typ)), "tonnage": r1(tonnage(kg, reps)),
                   "hard": is_hard(typ, rpe), "failure": is_failure(typ, rpe)}
            if s.get("duration_seconds"):
                row["durS"] = s["duration_seconds"]
            if s.get("distance_meters"):
                row["distM"] = s["distance_meters"]
            if o["inferredWarmup"]:
                row["warmupInferred"] = True
            if match is not None:
                row.update(match[k])
            set_rows.append(row)

        work = [r for r in set_rows if r["type"] != "warmup"]
        rpes = [r["rpe"] for r in work if r["rpe"] is not None]
        avg_rpe = mean(rpes)
        exercises = []
        musc = defaultdict(lambda: {"hardSets": 0.0, "tonnageWork": 0.0})
        for ex in sorted(w.get("exercises", []), key=lambda e: e.get("index", 0)):
            t = tmpl.get(ex.get("exercise_template_id")) or {}
            prim = t.get("primary_muscle_group") or "other"
            sec = t.get("secondary_muscle_groups") or []
            exr = [r for r in set_rows if r["ex"] == ex.get("index")]
            exw = [r for r in exr if r["type"] != "warmup"]
            hs = sum(1 for r in exw if r["hard"])
            ton = sum(r["tonnage"] for r in exw)
            for m, wt in [(prim, 1.0)] + [(m, 0.5) for m in sec]:
                musc[m]["hardSets"] += wt * hs
                musc[m]["tonnageWork"] += wt * ton
                muscles_seen.add(m)
            exercises.append({"idx": ex.get("index"), "title": ex.get("title"),
                              "templateId": ex.get("exercise_template_id"),
                              "key": f"{ex.get('exercise_template_id')}@{gym}",
                              "notes": ex.get("notes") or "", "supersetId": ex.get("superset_id"),
                              "primary": prim, "secondary": sec, "equipment": t.get("equipment"),
                              "sets": len(exr), "workSets": len(exw), "hardSets": hs,
                              "tonnageWork": r1(ton),
                              "bestE1rm": r1(max([r["e1rm"] for r in exw if r["e1rm"]] or [0]) or None)})

        hevy_min = (en - st).total_seconds() / 60.0
        warm = None
        hr_load = None
        main_min = hevy_min
        hr_series = None
        markers = None
        if quality is not None:
            a, b = quality["warmupEndS"], min(len(raw), quality["mainEndS"] + 1)
            wv = [v for v in raw[:a] if v is not None]
            warm = {"minutes": r1(a / 60), "avgHR": r1(mean(wv)), "maxHR": r1(max(wv) if wv else None)}
            main_min = max(0.0, (b - a) / 60.0)
            hr_load = trimp(raw, a, b, hr_max) if b > a else None
            hr_series = [[t, round(raw[t])] for t in range(0, len(raw), HR_SERIES_STEP) if raw[t] is not None]
            markers = [[r["tStart"], r["tPeak"], r["peakHR"], r["ex"], r["set"]]
                       for r in set_rows if r.get("tPeak") is not None]
        notes = [{"ex": e["title"], "note": e["notes"]} for e in exercises if e["notes"]]
        wo = {"id": w["id"], "date": date, "title": w["title"], "gym": gym, "gymSource": gym_src}
        if gym_src in ("inferred", "conflict"):
            wo["gymEvidence"] = gym_ev
        wo.update({
              "start": w["start_time"], "end": w["end_time"], "hevyMin": r1(hevy_min),
              "description": w.get("description") or "", "notes": notes,
              "sets": len(set_rows), "workSets": len(work),
              "hardSets": sum(1 for r in work if r["hard"]),
              "failureSets": sum(1 for r in work if r["failure"]),
              "tonnageAll": r1(sum(r["tonnage"] for r in set_rows)),
              "tonnageWork": r1(sum(r["tonnage"] for r in work)),
              "avgRPE": r2(avg_rpe), "mainMin": r1(main_min),
              "sRPE": r1(avg_rpe * main_min) if avg_rpe is not None else None,
              "hrLoad": r1(hr_load), "warmup": warm,
              "hr": ({"activityId": h["activityId"], "start": h["start"].isoformat().replace("+00:00", "Z"),
                      "source": h["source"],
                      "artifacts": {"spikes": arts.get("spikes", 0), "dropoutS": arts.get("dropoutS", 0)}}
                     if h else None),
              "match": quality,
              "muscles": {m: {"hardSets": r1(v["hardSets"]), "tonnageWork": r1(v["tonnageWork"])}
                          for m, v in sorted(musc.items())},
              "exercises": exercises, "setRows": set_rows,
              "hrSeries": hr_series, "setMarkers": markers})
        workouts.append(wo)

    # HR-only (no Hevy) sessions
    hr_only = []
    for h in orphans:
        lo = int(cfg.get("warmupWindowMin", [15, 22])[0] * 60)
        raw, smooth = build_hr_series(h["ts"], h["vals"], dropout_from=lo)
        c = detect_candidates(smooth, lo, len(raw) - 1)
        hr_only.append({"date": h["date"], "activityId": h["activityId"], "source": h["source"],
                        "candidates": len(c),
                        "minutes": r1(len(raw) / 60)})
        match_rows.append((h["date"], "(no Hevy workout)", {"method": "-", "expected": None,
                                                            "candidates": len(c), "matched": None,
                                                            "conf": None, "warmupEndS": None}))
    match_rows.sort(key=lambda r: r[0])

    workouts.sort(key=lambda w: (w["date"], w["start"]))

    # ---- per (exercise, gym) progression ----
    series = defaultdict(list)
    ex_meta = {}
    for wo in workouts:
        for e in wo["exercises"]:
            key = e["key"]
            ex_meta.setdefault(key, {"title": e["title"], "templateId": e["templateId"], "gym": wo["gym"],
                                     "primary": e["primary"], "secondary": e["secondary"],
                                     "equipment": e["equipment"]})
            ws = [r for r in wo["setRows"] if r["ex"] == e["idx"] and r["type"] != "warmup"]
            if not ws:
                continue
            top = max(ws, key=lambda r: ((r["kg"] or 0), (r["reps"] or 0)))
            kgs = Counter(r["kg"] for r in ws)
            mc = max(kgs.values())
            modal = max(k for k, v in kgs.items() if v == mc and k is not None) if any(
                k is not None for k in kgs) else None
            at = [r for r in ws if r["kg"] == modal]
            series[key].append({
                "d": wo["date"], "wid": wo["id"], "workSets": len(ws),
                "top": {"kg": top["kg"], "reps": top["reps"], "rpe": top["rpe"]},
                "bestE1rm": r1(max([r["e1rm"] for r in ws if r["e1rm"]] or [0]) or None),
                "tonnageWork": r1(sum(r["tonnage"] for r in ws)),
                "modalKg": modal, "nAtModal": len(at),
                "rpeAtModal": r2(mean([r["rpe"] for r in at])),
                "peakHRAtModal": r1(mean([r.get("peakHR") for r in at])),
                "hrDeltaAtModal": r1(mean([r.get("hrDelta") for r in at])),
                "_reps": [(r["kg"], r["reps"]) for r in ws if r["kg"] is not None and r["reps"]]})
    exercises_out = {}
    for key, ser in series.items():
        best = None
        reps_at = {}
        for p in ser:
            p["prE1rm"] = bool(best is not None and p["bestE1rm"] and p["bestE1rm"] > best + 1e-9)
            if p["bestE1rm"]:
                best = p["bestE1rm"] if best is None else max(best, p["bestE1rm"])
            rep_pr = False
            cur = {}
            for kg, rp in p.pop("_reps"):
                cur[kg] = max(cur.get(kg, 0), rp)
            for kg, rp in cur.items():
                if kg in reps_at and rp > reps_at[kg]:
                    rep_pr = True
            for kg, rp in cur.items():
                reps_at[kg] = max(reps_at.get(kg, 0), rp)
            p["repPR"] = rep_pr
        drift = []
        byw = defaultdict(list)
        for p in ser:
            if p["modalKg"] is not None:
                byw[p["modalKg"]].append(p)
        for kg, ps in sorted(byw.items()):
            if len(ps) < 3:
                continue
            pts_r = [(dt.date.fromisoformat(p["d"]), p["rpeAtModal"]) for p in ps]
            pts_h = [(dt.date.fromisoformat(p["d"]), p["peakHRAtModal"]) for p in ps]
            drift.append({"kg": kg, "n": len(ps), "from": ps[0]["d"], "to": ps[-1]["d"],
                          "rpeSlopeWk": r2(slope_per_week(pts_r)),
                          "peakHRSlopeWk": r2(slope_per_week(pts_h)),
                          "nHR": sum(1 for p in ps if p["peakHRAtModal"] is not None)})
        exercises_out[key] = dict(ex_meta[key], series=ser, drift=drift)

    # ---- weekly + ACWR ----
    daily_ton, daily_srpe = defaultdict(float), defaultdict(float)
    for wo in workouts:
        d = dt.date.fromisoformat(wo["date"])
        daily_ton[d] += wo["tonnageWork"] or 0
        daily_srpe[d] += wo["sRPE"] or 0
    weekly, muscle_weekly = [], []
    if workouts:
        first = week_monday(dt.date.fromisoformat(workouts[0]["date"]))
        last_day = dt.date.fromisoformat(workouts[-1]["date"])
        wk = first
        while wk <= last_day:
            we = wk + dt.timedelta(days=6)
            ws = [wo for wo in workouts if wk <= dt.date.fromisoformat(wo["date"]) <= we]
            ref = min(we, last_day)

            def acwr(series_):
                acute = sum(series_.get(ref - dt.timedelta(days=k), 0) for k in range(7))
                chronic = sum(series_.get(ref - dt.timedelta(days=k), 0) for k in range(28)) / 4.0
                return r2(acute / chronic) if chronic > 0 else None
            hr_loads = [wo["hrLoad"] for wo in ws if wo["hrLoad"] is not None]
            weekly.append({"week": wk.isoformat(), "sessions": len(ws),
                           "tonnageWork": r1(sum(wo["tonnageWork"] or 0 for wo in ws)),
                           "hardSets": sum(wo["hardSets"] for wo in ws),
                           "failureSets": sum(wo["failureSets"] for wo in ws),
                           "sRPE": r1(sum(wo["sRPE"] or 0 for wo in ws)),
                           "hrLoad": r1(sum(hr_loads)) if hr_loads else None,
                           "hrSessions": len(hr_loads),
                           "acwrTonnage": acwr(daily_ton), "acwrSRPE": acwr(daily_srpe)})
            mw = defaultdict(lambda: {"hardSets": 0.0, "tonnageWork": 0.0})
            for wo in ws:
                for m, v in wo["muscles"].items():
                    mw[m]["hardSets"] += v["hardSets"] or 0
                    mw[m]["tonnageWork"] += v["tonnageWork"] or 0
            muscle_weekly.append({"week": wk.isoformat(),
                                  "m": {m: {"hardSets": r1(v["hardSets"]), "tonnageWork": r1(v["tonnageWork"])}
                                        for m, v in sorted(mw.items())}})
            wk += dt.timedelta(days=7)

    # newest first; hrSeries only for the latest N HR sessions
    workouts.sort(key=lambda w: (w["date"], w["start"]), reverse=True)
    n_hr = 0
    for wo in workouts:
        if wo["hrSeries"] is not None:
            n_hr += 1
            if n_hr > HR_SERIES_LATEST:
                wo["hrSeries"] = None

    with_hr = [wo for wo in workouts if wo["match"]]
    exp = sum(wo["match"]["expected"] for wo in with_hr)
    got = sum(wo["match"]["matched"] for wo in with_hr)
    all_conf = [r["conf"] for wo in with_hr for r in wo["setRows"] if r.get("conf") is not None]
    conf_ok = sum(1 for c in all_conf if c >= 0.5)
    low_sessions = sorted({wo["date"] for wo in with_hr
                           if (wo["match"]["conf"] or 0) < 0.3
                           or wo["hr"]["artifacts"]["dropoutS"] >= LOWCONF_DROPOUT_S
                           or wo["hr"]["artifacts"]["spikes"] >= LOWCONF_SPIKES
                           or sum(1 for r in wo["setRows"] if r.get("steepRise")) >= LOWCONF_STEEP_SETS})
    meta = {"version": VERSION,
            "refreshedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "Hevy API workouts (exercises, sets, kg, reps, RPE, notes) + HR stream (Strava/Garmin, "
                      "HRM600 chest strap; per workout hr.source), both from the local strength cache; "
                      "HR spikes / strap dropouts removed before matching (hr.artifacts); muscles from Hevy "
                      "exercise_templates; HR peaks matched to sets by tools/build_strength.py "
                      "(no set markers exist in any source).",
            "warmupMin": cfg.get("warmupMin", 18), "warmupWindowMin": cfg.get("warmupWindowMin"),
            "hrMax": hr_max, "method": method,
            "matchSummary": {"sessions": len(hr_sessions), "withHR": len(with_hr),
                             "hevyWorkouts": len(workouts), "setsExpected": exp, "setsMatched": got,
                             "matchedSetsPct": r1(100.0 * got / exp) if exp else None,
                             "confSetsPct": r1(100.0 * conf_ok / len(all_conf)) if all_conf else None,
                             "lowConfSessions": low_sessions},
            "gymSummary": gym_summary(workouts),
            "hrOnlySessions": hr_only, "duplicates": dups,
            "fields": {"setRows": "ex,set,type,kg,reps,rpe,e1rm,tonnage,hard,failure,[tPeak,peakHR,tStart,"
                                  "hrStart,riseS,hrDelta,restBeforeS,hrr30,hrr60,conf,shortRest?,nearArtifact?,"
                                  "steepRise?]; times in s from HR start; shortRest = matched rest < 30 s (conf capped "
                                  "at 0.25); steepRise = the rise tStart->tPeak holds a sample-to-sample step > 15 bpm/s "
                                  "(strap step, samples kept; also nearArtifact, conf capped at 0.25)",
                       "gym": "per workout: gym, gymSource explicit (gym token in title / description / notes) | "
                              "inferred (machine / cable exercise, or exercise + machine token, used only in that "
                              "gym's explicit workouts; gymEvidence = those exercises) | conflict (evidence for several "
                              "gyms; gym unknown, gymEvidence 'exercise (gym)') | none (unknown, no evidence)",
                       "gymSummary": "explicit / inferred workouts per gym, conflict, unknown",
                       "match": "per workout: method, anchor {exercise, tPeaks[], score, sets} (exercise 1's "
                                "main work sets = reference), conf (median), confSetsPct (% sets conf >= 0.5), "
                                "warmupEndS, lastPeakS vs streamEndS, expectedMainMin (Garmin min - 20)",
                       "matchSummary.confSetsPct": "% of matched-session sets with conf >= 0.5",
                       "matchSummary.lowConfSessions": "dates whose median set conf < 0.3, or with HR "
                                                       "dropouts >= 60 s, >= 3 spikes, or >= 2 steepRise sets",
                       "hr.artifacts": "spikes (excursions entered and left at > 15 bpm/s within 8 s, "
                                       "removed) and dropoutS (seconds of flat strap-dropout runs >= 30 s in "
                                       "the main block, treated as gaps; runs < 90 s apart merge into one span "
                                       "and the samples between them are removed too); set peaks within 10 s of "
                                       "a spike or 30 s of a dropout span: nearArtifact, conf capped at 0.25",
                       "setMarkers": "[tStart,tPeak,peakHR,exIdx,setIdx]", "hrSeries": "[t,hr] every 5 s",
                       "exercises key": "<templateId>@<gym> (gym explicit or inferred)"}}
    data = {"meta": meta, "config": {"gyms": cfg.get("gyms", {}), "defaultGym": cfg.get("defaultGym"),
                                     "machineTokens": cfg.get("machineTokens", [])},
            "muscles": sorted(muscles_seen), "workouts": workouts, "exercises": exercises_out,
            "weekly": weekly, "muscleWeekly": muscle_weekly}
    return data, match_rows, workouts_raw


# ----------------------------------------------------------------------------
# training-data.json volWork
# ----------------------------------------------------------------------------

def update_training_data(path, workouts):
    raw_text = Path(path).read_text(encoding="utf-8")
    td = json.loads(raw_text)
    by_date = defaultdict(float)
    has = set()
    for wo in workouts:
        by_date[wo["date"]] += wo["tonnageWork"] or 0
        has.add(wo["date"])
    rows = td["num"]["gym"]
    new_rows = []
    for row in rows:
        vw = int(round(by_date[row["d"]])) if row["d"] in has else None
        nr = {}
        for k, v in row.items():
            if k == "volWork":
                continue
            nr[k] = v
            if k == "top":
                nr["volWork"] = vw
        if "volWork" not in nr:
            nr["volWork"] = vw
        new_rows.append(nr)
    td["num"]["gym"] = new_rows
    out = json.dumps(td, indent=2, ensure_ascii=False) + "\n"
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(out)
    return sum(1 for r in new_rows if r["volWork"] is not None), len(new_rows)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def print_report(rows, data):
    def mm(x):
        return f"{x / 60:.1f}" if x is not None else "-"
    print(f"{'date':10} {'title':26} {'N':>3} {'cand':>4} {'mat':>3} {'method':9} {'conf':>5} {'c>=.5':>5} "
          f"{'wuEnd':>5} {'minR':>4} {'last/end':>11}  anchor (peak HR @ min)")
    for date, title, q in rows:
        if q.get("expected") is None:
            print(f"{date:10} {title[:26]:26}   -  {q['candidates']:>4}   -  (HR only)")
            continue
        an = q.get("anchor")
        an_s = "-"
        if an:
            an_s = f"{an['exercise'][:18]}: " + " ".join(
                f"{hr:.0f}@{t / 60:.1f}" for hr, t in zip(an.get("peakHR") or [], an["tPeaks"]))
        print(f"{date:10} {title[:26]:26} {q['expected']:>3} {q['candidates']:>4} {q['matched']:>3} "
              f"{q['method']:9} {q['conf']:>5} {q.get('confSetsPct', '-')!s:>5} {mm(q.get('warmupEndS')):>5} "
              f"{q.get('minRestS') if q.get('minRestS') is not None else '-'!s:>4} "
              f"{mm(q.get('lastPeakS')) + '/' + mm(q.get('streamEndS')):>11}  {an_s}")
    ms = data["meta"]["matchSummary"]
    print(f"sessions={ms['sessions']} withHR={ms['withHR']} matched {ms['setsMatched']}/{ms['setsExpected']}"
          f" ({ms['matchedSetsPct']}%) confSetsPct={ms.get('confSetsPct')}% lowConfSessions={ms.get('lowConfSessions')}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh-templates", action="store_true")
    ap.add_argument("--raw-dir", default=str(DEFAULT_RAW))
    ap.add_argument("--out", default=str(REPO / "strength-data.json"))
    ap.add_argument("--training-data", default=str(REPO / "training-data.json"))
    ap.add_argument("--no-training-data", action="store_true", help="do not write volWork")
    ap.add_argument("--method", choices=["anchor", "dp_legacy", "dp", "topn"], default="anchor",
                    help="anchor (default); dp_legacy (alias dp) = previous matcher, for comparison")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args(argv)
    try:                                   # workout titles contain emoji; Windows consoles are cp1252
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):   # pragma: no cover
        pass
    cfg = load_config()
    fresh = a.refresh_templates or not TEMPLATES_PATH.exists()   # load_templates fetches in both cases
    templates = load_templates(a.refresh_templates)
    templates = ensure_templates(templates, a.raw_dir, refreshed=fresh)
    data, rows, workouts_raw = build(a.raw_dir, cfg, templates, a.method)
    txt = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(a.out, "w", encoding="utf-8", newline="") as f:
        f.write(txt + "\n")
    print(f"wrote {a.out} ({len(txt.encode('utf-8')) / 1024:.0f} KB, {len(data['workouts'])} workouts)")
    if not a.no_training_data and Path(a.training_data).exists():
        n, tot = update_training_data(a.training_data, data["workouts"])
        print(f"training-data.json: volWork set on {n}/{tot} gym rows")
    if a.report:
        print_report(rows, data)
        toks = note_tokens(workouts_raw)
        print("note/description tokens (count):", ", ".join(f"{k}({v})" for k, v in sorted(toks.items())))
        gyms = Counter(w["gym"] for w in data["workouts"])
        print("workouts per gym:", dict(gyms))
        gs = data["meta"]["gymSummary"]
        print(f"gym source: explicit {gs['explicit']} inferred {gs['inferred']} "
              f"conflict {gs['conflict']} unknown {gs['unknown']}")
        for w in data["workouts"]:
            if w.get("gymSource") in ("inferred", "conflict"):
                print(f"  {w['date']} {w['title'][:26]:26} {w['gymSource']:8} {w['gym']:12} "
                      f"<- {'; '.join(w.get('gymEvidence') or [])}")


if __name__ == "__main__":
    main()
