"""Unit tests for tools/build_strength.py (stdlib unittest).

    python -m unittest tools/test_build_strength.py
"""
import json
import math
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_strength as B  # noqa: E402

CFG = {"warmupMin": 18, "warmupWindowMin": [15, 22], "hrMax": 173, "gyms": {}, "defaultGym": "unknown"}


def make_workout(spec):
    """spec: list of exercises, each a list of (type, kg, reps, rpe)."""
    exs = []
    for i, sets in enumerate(spec):
        exs.append({"index": i, "title": f"Ex{i}", "notes": "", "exercise_template_id": f"T{i}",
                    "superset_id": None,
                    "sets": [{"index": k, "type": t, "weight_kg": kg, "reps": r, "rpe": rpe,
                              "distance_meters": None, "duration_seconds": None, "custom_metric": None}
                             for k, (t, kg, r, rpe) in enumerate(sets)]})
    return {"id": "w", "title": "t", "exercises": exs}


def synth_hr(set_plan, main_start=1140, seed=1, total_pad=240, noise=1.5):
    """Synthetic session: 10 min walking (~100 bpm), 8 min DNS (~88 bpm with small
    +11 bpm bumps every 90 s), then sets.  set_plan: list of (amp_bpm, dur_s, rest_s).
    Returns (timestamps, values, true_peak_times)."""
    rng = random.Random(seed)
    peaks, starts = [], []
    t = main_start
    for amp, dur, rest in set_plan:
        starts.append((t, amp, dur))
        peaks.append(t + dur)
        t += dur + rest
    T = t + total_pad

    def hr(u):
        if u < 600:
            v = 100 + 3 * math.sin(u / 23.0)
        elif u < main_start:
            v = 88 + 11 * max(0.0, math.sin((u - 600) / 45.0 * math.pi)) ** 4   # DNS bumps
        else:
            v = 95.0
        for s0, amp, dur in starts:
            tau = u - s0
            if 0 <= tau <= dur:
                v += amp * tau / dur
            elif tau > dur:
                v += amp * math.exp(-(tau - dur) / 35.0)
        return v + rng.uniform(-noise, noise)

    ts, vals, u = [], [], 0
    while u <= T:
        ts.append(u)
        vals.append(None if rng.random() < 0.01 else round(hr(u)))
        u += rng.choice([1, 2, 2, 3]) if rng.random() > 0.01 else 9   # irregular, rare 9 s gap
    return ts, vals, peaks


class TestMath(unittest.TestCase):
    def test_e1rm(self):
        self.assertAlmostEqual(B.e1rm(100, 5, 8), 100 * (1 + 7 / 30), places=6)
        self.assertAlmostEqual(B.e1rm(100, 5, None), 100 * (1 + 5 / 30), places=6)
        self.assertAlmostEqual(B.e1rm(80, 10, 10), 80 * (1 + 10 / 30), places=6)
        self.assertIsNone(B.e1rm(60, 6, 6, "warmup"))
        self.assertIsNone(B.e1rm(None, 24, 7))          # bodyweight
        self.assertIsNone(B.e1rm(0, 12, 7))

    def test_tonnage_hard_failure(self):
        self.assertEqual(B.tonnage(80, 10), 800.0)
        self.assertEqual(B.tonnage(None, 24), 0.0)
        self.assertTrue(B.is_hard("normal", 7))
        self.assertFalse(B.is_hard("normal", 6.5))
        self.assertIsNone(B.is_hard("normal", None))
        self.assertFalse(B.is_hard("warmup", 9))
        self.assertTrue(B.is_failure("normal", 9.5))
        self.assertTrue(B.is_failure("failure", None))
        self.assertFalse(B.is_failure("normal", 9))

    def test_superset_interleave(self):
        w = make_workout([[("normal", 50, 10, 7)] * 2, [("normal", 20, 12, 7)] * 2, [("normal", 10, 12, 7)]])
        w["exercises"][0]["superset_id"] = 0
        w["exercises"][1]["superset_id"] = 0
        order = [(o["exIdx"], o["setIdx"]) for o in B.ordered_sets(w)]
        self.assertEqual(order, [(0, 0), (1, 0), (0, 1), (1, 1), (2, 0)])

    def test_inferred_warmup(self):
        w = make_workout([[("normal", 70, 6, None), ("normal", 110, 3, None), ("normal", 120, 8, None),
                           ("normal", 120, 8, None)]])
        flags = [o["inferredWarmup"] for o in B.ordered_sets(w)]
        self.assertEqual(flags, [True, True, False, False])


class TestMatching(unittest.TestCase):
    # 3 small warm-up peaks, 4 heavy compound sets, 3 accessories x 3 sets = 16 sets
    PLAN = ([(14, 25, 110), (16, 25, 120), (18, 20, 130)] +
            [(48, 45, 170), (50, 45, 180), (52, 45, 175), (53, 45, 185)] +
            [(28, 40, 100), (26, 40, 95), (30, 40, 110)] * 3)
    SPEC = [[("warmup", 60, 6, 6), ("warmup", 80, 4, 6), ("warmup", 100, 2, 6),
             ("normal", 120, 8, 8), ("normal", 120, 8, 8.5), ("normal", 120, 8, 9), ("normal", 120, 8, 9.5)],
            [("normal", 60, 12, 7), ("normal", 60, 12, 8), ("normal", 60, 12, 9)],
            [("normal", 40, 12, 7), ("normal", 40, 12, 8), ("normal", 40, 12, 9)],
            [("normal", 20, 12, 7), ("normal", 20, 12, 8), ("normal", 20, 12, 9)]]

    def run_match(self, plan, spec, seed=1):
        ts, vals, peaks = synth_hr(plan, seed=seed)
        raw, smooth = B.build_hr_series(ts, vals)
        sets = B.ordered_sets(make_workout(spec))
        out, q = B.match_session(sets, raw, smooth, CFG)
        return out, q, peaks

    def test_all_sets_recovered_in_order(self):
        # the DNS block really contains candidate-sized bumps inside the 15-22 min window
        ts, vals, _ = synth_hr(self.PLAN)
        _, smooth = B.build_hr_series(ts, vals)
        self.assertGreaterEqual(len(B.detect_candidates(smooth, 900, 1130)), 2)
        for seed in (1, 2, 3):
            out, q, peaks = self.run_match(self.PLAN, self.SPEC, seed)
            self.assertEqual(q["expected"], 16)
            self.assertEqual(q["matched"], 16, f"seed {seed}: {q}")
            got = [o["tPeak"] for o in out]
            self.assertEqual(got, sorted(got))
            for g, p in zip(got, peaks):
                self.assertLessEqual(abs(g - p), 20, f"seed {seed}: peak {g} vs true {p}")
            # warm-up end found near the true main-block start (1140 s)
            self.assertLessEqual(abs(q["warmupEndS"] - 1140), 90, q)
            for o in out:
                self.assertGreater(o["conf"], 0.0)
                self.assertIsNotNone(o["peakHR"])

    def test_interp_gap_and_nan(self):
        raw, _ = B.build_hr_series([0, 5, 30, 31], [100, 110, 120, None])
        self.assertAlmostEqual(raw[2], 104.0)
        self.assertIsNone(raw[10])      # 25 s gap > 12 s stays empty
        self.assertEqual(raw[30], 120.0)

    def test_fewer_peaks_than_sets_no_invention(self):
        plan = self.PLAN[:10]              # HR has only 10 set peaks; Hevy says 16 sets
        for seed in range(1, 23):          # >= 20 seeds
            out, q, peaks = self.run_match(plan, self.SPEC, seed)
            self.assertLessEqual(q["matched"], 10, f"seed {seed}: {q}")
            self.assertGreaterEqual(q["matched"], 9, f"seed {seed}: {q}")
            matched = [o["tPeak"] for o in out if o["tPeak"] is not None]
            self.assertEqual(len(matched), len(set(matched)))
            self.assertEqual(matched, sorted(matched))
            for g in matched:              # every matched peak is a real peak
                self.assertLessEqual(min(abs(g - p) for p in peaks), 20, f"seed {seed}: {g}")
            # never reach back into the warm-up: nothing matched before the true first set
            self.assertGreaterEqual(min(matched), peaks[0] - 20, f"seed {seed}")
            for o in out:
                if o["tPeak"] is None:
                    self.assertEqual(o["conf"], 0.0)
                    self.assertIsNone(o["peakHR"])
            self.assertLess(q["conf"], 0.9)

    def test_topn_baseline(self):
        ts, vals, peaks = synth_hr(self.PLAN)
        raw, smooth = B.build_hr_series(ts, vals)
        sets = B.ordered_sets(make_workout(self.SPEC))
        out, q = B.match_session(sets, raw, smooth, CFG, method="topn")
        self.assertEqual(q["method"], "topn")
        got = [o["tPeak"] for o in out if o["tPeak"] is not None]
        self.assertEqual(got, sorted(got))


def anchor_session(seed):
    """18 min walk + DNS noise, exercise 1 = 2 small warm-up sets + 3 big main
    sets, then 4 exercises x 3 sets; random rests 60-180 s, noise."""
    rng = random.Random(1000 + seed)
    plan = [(rng.uniform(12, 17), rng.randint(20, 30), rng.randint(60, 180)) for _ in range(2)]
    plan += [(rng.uniform(46, 54), rng.randint(40, 50), rng.randint(90, 180)) for _ in range(3)]
    plan += [(rng.uniform(22, 32), rng.randint(30, 45), rng.randint(60, 180)) for _ in range(12)]
    spec = [[("warmup", 60, 6, 6), ("warmup", 80, 4, 6),
             ("normal", 120, 8, 8), ("normal", 120, 8, 8.5), ("normal", 120, 8, 9)]]
    spec += [[("normal", 50, 12, 7), ("normal", 50, 12, 8), ("normal", 50, 12, 9)] for _ in range(4)]
    main_start = 1080 + rng.randint(0, 120)            # 18-20 min warm-up on the watch
    ts, vals, peaks = synth_hr(plan, main_start=main_start, seed=seed, noise=2.5)
    return ts, vals, peaks, spec, main_start


class TestAnchor(unittest.TestCase):
    def test_anchor_triple_and_sets_across_seeds(self):
        for seed in range(20):
            ts, vals, peaks, spec, main_start = anchor_session(seed)
            raw, smooth = B.build_hr_series(ts, vals)
            sets = B.ordered_sets(make_workout(spec))
            self.assertEqual(B.anchor_split(sets), ([0, 1], [2, 3, 4]))
            out, q = B.match_session(sets, raw, smooth, CFG)
            self.assertEqual(q["method"], "anchor")
            an = q["anchor"]["tPeaks"]
            self.assertEqual(len(an), 3)
            for g, p in zip(an, peaks[2:5]):
                self.assertLessEqual(abs(g - p), 20, f"seed {seed}: anchor {an} vs true {peaks[2:5]}")
            got = [o["tPeak"] for o in out]
            ok = sum(1 for g, p in zip(got, peaks) if g is not None and abs(g - p) <= 20)
            self.assertGreaterEqual(ok / len(peaks), 0.9, f"seed {seed}: {got} vs {peaks}")
            # warm-up ends just before exercise 1's first warm-up set (true main-block start)
            self.assertLessEqual(abs(q["warmupEndS"] - main_start), 90, f"seed {seed}: {q}")
            for o in out:                  # short rests are always flagged low-confidence
                if o["restBeforeS"] is not None and o["restBeforeS"] < 30:
                    self.assertTrue(o.get("shortRest"))
                    self.assertLessEqual(o["conf"], 0.25)

    def test_truncated_hevy_window_uses_whole_stream(self):
        """07-19 regression: Hevy times covering only half of the HR stream must
        not cut the main block (legacy squeezed 22 sets into 16-46 min)."""
        ts, vals, peaks, spec, main_start = anchor_session(3)
        raw, smooth = B.build_hr_series(ts, vals)
        sets = B.ordered_sets(make_workout(spec))
        half = (main_start, main_start + (peaks[-1] - main_start) / 2)
        out, q = B.match_session(sets, raw, smooth, CFG, hevy_window=half)
        self.assertFalse(q["hevyTimesUsed"])
        self.assertEqual(q["mainEndS"], len(raw) - 1)
        self.assertEqual(q["matched"], len(sets))
        self.assertLessEqual(abs(q["lastPeakS"] - peaks[-1]), 20, q)
        self.assertGreater(q["lastPeakS"], half[1] + 600)
        got = [o["tPeak"] for o in out]
        ok = sum(1 for g, p in zip(got, peaks) if g is not None and abs(g - p) <= 20)
        self.assertGreaterEqual(ok / len(peaks), 0.9)
        # the legacy matcher with the same window demonstrably cuts the stream
        _, ql = B.match_session(sets, raw, smooth, CFG, hevy_window=half, method="dp_legacy")
        self.assertTrue(ql["hevyTimesUsed"])
        self.assertLessEqual(ql["lastPeakS"], half[1] + 120)

    def test_duplicate_ids_newest_exercises(self):
        ex_old = [{"index": 0, "title": "A", "exercise_template_id": "T", "superset_id": None, "notes": "",
                   "sets": [{"index": 0, "type": "normal", "weight_kg": 100, "reps": 5, "rpe": 8}]}]
        ex_new = json.loads(json.dumps(ex_old))
        ex_new[0]["sets"][0]["weight_kg"] = 110
        old = {"id": "X", "title": "t", "start_time": "2026-08-17T12:34:33+00:00",
               "end_time": "2026-08-17T13:46:38+00:00", "updated_at": "2026-08-17T13:47:16Z", "exercises": ex_old}
        new = dict(old, start_time="2026-08-17T05:34:33+00:00", end_time="2026-08-17T06:46:50+00:00",
                   updated_at="2026-09-21T18:08:11Z", exercises=ex_new)
        hr = [{"start": B.parse_ts("2026-08-17T12:20:00+00:00"), "end": B.parse_ts("2026-08-17T13:50:00+00:00")}]
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hevy").mkdir()
            for name, w in (("a.json", old), ("b.json", new)):
                (Path(d) / "hevy" / name).write_text(json.dumps(w), encoding="utf-8")
            chosen, dups = B.load_hevy(d, hr)
        self.assertEqual(len(chosen), 1)
        self.assertEqual(chosen[0]["exercises"][0]["sets"][0]["weight_kg"], 110)   # newest sets
        self.assertEqual(chosen[0]["start_time"], old["start_time"])              # HR-overlapping times
        self.assertEqual(dups[0]["chosen"], "b.json")
        self.assertEqual(dups[0]["timesFrom"], "a.json")


def write_hr(raw, sub, name, start, ts, vals):
    d = Path(raw) / sub
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps({
        "startTime": start, "sampleCount": len(vals),
        "streams": {"heart_rate": {"unit": "bpm", "values": vals}}, "timestamps": ts}), encoding="utf-8")


class TestHrInputSelection(unittest.TestCase):
    """raw/strava_hr (1 s, machine-fetched) is preferred over raw/garmin_hr for the same activity."""

    T = [0, 1, 2, 3]
    V = [80, 81, 82, 83]

    def sessions(self, files):
        with tempfile.TemporaryDirectory() as d:
            for sub, name, start in files:
                write_hr(d, sub, name, start, self.T, self.V)
            return B.load_hr_sessions(d)

    def test_strava_preferred_when_both_exist(self):
        out = self.sessions([("garmin_hr", "2026-09-29_111", "2026-09-29T08:05:25.000Z"),
                             ("strava_hr", "2026-09-29_999", "2026-09-29T08:06:20.000Z")])   # 55 s apart
        self.assertEqual([(h["source"], h["activityId"]) for h in out], [("strava", "999")])

    def test_within_two_minutes_boundary(self):
        out = self.sessions([("garmin_hr", "2026-09-29_111", "2026-09-29T08:00:00.000Z"),
                             ("strava_hr", "2026-09-29_999", "2026-09-29T08:02:00.000Z")])
        self.assertEqual([h["source"] for h in out], ["strava"])          # exactly 120 s = same activity
        out = self.sessions([("garmin_hr", "2026-09-29_111", "2026-09-29T08:00:00.000Z"),
                             ("strava_hr", "2026-09-29_999", "2026-09-29T08:02:01.000Z")])
        self.assertEqual(sorted(h["source"] for h in out), ["garmin", "strava"])   # different activities

    def test_garmin_only_and_strava_only(self):
        out = self.sessions([("garmin_hr", "2026-09-24_111", "2026-09-24T08:00:00.000Z"),
                             ("strava_hr", "2026-09-26_222", "2026-09-26T08:00:00.000Z"),
                             ("garmin_hr", "2026-09-29_333", "2026-09-29T08:00:00.000Z"),
                             ("strava_hr", "2026-09-29_444", "2026-09-29T08:01:00.000Z")])
        self.assertEqual([(h["date"], h["source"]) for h in out],
                         [("2026-09-24", "garmin"), ("2026-09-26", "strava"), ("2026-09-29", "strava")])

    def test_no_strava_dir_is_fine(self):
        with tempfile.TemporaryDirectory() as d:
            write_hr(d, "garmin_hr", "2026-09-29_111", "2026-09-29T08:00:00.000Z", self.T, self.V)
            out = B.load_hr_sessions(d)
        self.assertEqual([h["source"] for h in out], ["garmin"])

    def test_build_records_hr_source(self):
        ts, vals, peaks, spec, main_start = anchor_session(1)
        w = make_workout(spec)
        w.update({"id": "W1", "title": "t", "updated_at": "2026-09-29T10:00:00.000Z",
                  "start_time": "2026-09-29T08:00:00+00:00",
                  "end_time": (B.parse_ts("2026-09-29T08:00:00+00:00")
                               + B.dt.timedelta(seconds=ts[-1])).isoformat()})
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hevy").mkdir()
            (Path(d) / "hevy" / "2026-09-29_W1.json").write_text(json.dumps(w), encoding="utf-8")
            write_hr(d, "garmin_hr", "2026-09-29_111", "2026-09-29T08:00:03.000Z", ts, vals)
            write_hr(d, "strava_hr", "2026-09-29_999", "2026-09-29T08:00:00.000Z", ts, vals)
            data, _, _ = B.build(d, CFG, [])
            self.assertEqual(data["meta"]["matchSummary"]["sessions"], 1)
            self.assertEqual(data["workouts"][0]["hr"]["source"], "strava")
            self.assertEqual(data["workouts"][0]["hr"]["activityId"], "999")
            self.assertIsNotNone(data["workouts"][0]["match"])
            (Path(d) / "strava_hr" / "2026-09-29_999.json").unlink()
            data, _, _ = B.build(d, CFG, [])
            self.assertEqual(data["workouts"][0]["hr"]["source"], "garmin")


def _idx_near(ts, t):
    return min(range(len(ts)), key=lambda k: abs(ts[k] - t))


class TestArtifacts(unittest.TestCase):
    """HR spikes and strap dropouts are removed before matching; a set's peak is
    never taken from an artifact."""

    def match(self, ts, vals, spec, filt):
        arts = {}
        if filt:
            raw, smooth = B.build_hr_series(ts, vals, dropout_from=900, artifacts=arts)
        else:
            raw, smooth = B.build_hr_series(ts, vals)
        out, q = B.match_session(B.ordered_sets(make_workout(spec)), raw, smooth, CFG,
                                 artifacts=arts if filt else None)
        return out, q, arts

    def test_clean_session_untouched(self):
        for seed in range(10):
            ts, vals, *_ = anchor_session(seed)
            _, _, info = B.filter_artifacts(ts, vals, 900)
            self.assertEqual((info["spikes"], info["dropoutS"]), (0, 0), f"seed {seed}")

    def test_spike_not_taken_as_peak(self):
        for seed in (0, 1, 2):
            ts, vals, peaks, spec, _ = anchor_session(seed)
            vals = list(vals)
            p = peaks[3]                                  # second anchor (main work) set peak
            k = _idx_near(ts, p + 4)
            base = max(v for v in vals[k - 3:k + 4] if v is not None)
            spike = base + 60                             # 113 -> 165 -> 140 style, steep both ways
            vals[k] = spike
            vals[k + 1] = spike - 2                       # 2-sample excursion
            out, _, _ = self.match(ts, vals, spec, filt=False)
            self.assertGreaterEqual(max(o["peakHR"] or 0 for o in out), spike - 2, "spike must bite unfiltered")
            out, q, arts = self.match(ts, vals, spec, filt=True)
            self.assertEqual(arts["spikes"], 1, f"seed {seed}")
            self.assertLess(max(o["peakHR"] or 0 for o in out), spike - 2, f"seed {seed}")
            self.assertLessEqual(abs(q["anchor"]["tPeaks"][1] - p), 20, f"seed {seed}: {q['anchor']}")
            near = [o for o in out if o.get("nearArtifact")]
            self.assertTrue(near, f"seed {seed}")
            for o in near:
                self.assertLessEqual(o["conf"], B.ARTIFACT_CONF)

    def test_flat_dropout_not_taken_as_peak(self):
        for seed in (0, 1, 2):
            ts, vals, peaks, spec, _ = anchor_session(seed)
            vals = list(vals)
            # longest rest among the accessory sets; freeze the strap there at a high value
            j = max(range(5, len(peaks) - 1), key=lambda i: peaks[i + 1] - peaks[i])
            a, b = peaks[j] + 30, peaks[j + 1] - 45
            self.assertGreaterEqual(b - a, 40)
            frozen = max(v for v in vals if v is not None) + 5
            for i, t in enumerate(ts):
                if a <= t <= b:
                    vals[i] = frozen
            out, q, arts = self.match(ts, vals, spec, filt=True)
            self.assertGreaterEqual(arts["dropoutS"], b - a - 3, f"seed {seed}: {arts}")
            self.assertEqual(arts["spikes"], 0)
            for o in out:
                if o["tPeak"] is not None:
                    self.assertFalse(a <= o["tPeak"] <= b, f"seed {seed}: peak {o['tPeak']} in dropout {a}-{b}")
                    self.assertLess(o["peakHR"], frozen, f"seed {seed}")
            got = [o["tPeak"] for o in out]
            ok = sum(1 for g, pk in zip(got, peaks) if g is not None and abs(g - pk) <= 20)
            self.assertGreaterEqual(ok / len(peaks), 0.85, f"seed {seed}: {got} vs {peaks}")

    def test_multi_level_freeze_merged_and_nearby_sets_capped(self):
        """06-07 regression: the strap froze at 125, then 118, then 72 with a short
        live-looking blip between the first two.  Runs < 90 s apart merge into one
        dropout span, the blip is removed with them, no peak is taken inside the
        span, and sets whose peak is within 30 s of it are capped."""
        for seed in (0, 1, 2):
            ts0, vals0, peaks, spec, _ = anchor_session(seed)
            raw0, _ = B.build_hr_series(ts0, vals0)
            ts = list(range(len(raw0)))
            vals = [None if v is None else round(v) for v in raw0]
            j = 7                                           # an accessory set well inside the main block
            a = peaks[j] - 40
            levels = [(a, a + 45, 125), (a + 45 + 45, a + 45 + 45 + 50, 118), (a + 190, a + 260, 72)]
            blip = (levels[0][1] + 1, levels[1][0] - 1)     # 43 s live-looking stretch between levels 1 and 2
            self.assertLess(blip[1] - blip[0], 90)
            for lo, hi, v in levels:
                for t in range(lo, hi + 1):
                    vals[t] = v
            lo_span, hi_span = levels[0][0], levels[2][1]
            out, q, arts = self.match(ts, vals, spec, filt=True)
            self.assertEqual(len(arts["dropouts"]), 1, f"seed {seed}: {arts['dropouts']}")
            d0, d1 = arts["dropouts"][0]
            self.assertLessEqual(d0, lo_span + 1)
            self.assertGreaterEqual(d1, hi_span - 1)
            self.assertGreaterEqual(arts["dropoutS"], hi_span - lo_span - 3)
            kept_ts, _, _ = B.filter_artifacts(ts, vals, 900)
            self.assertFalse([t for t in kept_ts if d0 <= t <= d1], "samples inside the merged span survive")
            for o in out:
                if o["tPeak"] is not None:
                    self.assertFalse(d0 <= o["tPeak"] <= d1, f"seed {seed}: peak {o['tPeak']} in span {d0}-{d1}")
                    if d0 - 30 <= o["tPeak"] <= d1 + 30:
                        self.assertTrue(o.get("nearArtifact"), f"seed {seed}: {o}")
                        self.assertLessEqual(o["conf"], B.ARTIFACT_CONF)
            # a peak 25 s outside the span is capped (30 s window), 45 s outside is not by the dropout rule
            self.assertTrue(B.near_artifact(d0 - 25, arts))
            self.assertTrue(B.near_artifact(d1 + 25, arts))
            self.assertFalse(B.near_artifact(d1 + 45, arts))

    def test_dropouts_far_apart_stay_separate(self):
        pts_t = list(range(0, 400))
        vals = [100 + (t % 7) * 4 for t in pts_t]
        for t in range(50, 90):
            vals[t] = 130
        for t in range(200, 240):                           # 110 s later: not merged
            vals[t] = 118
        _, _, info = B.filter_artifacts(pts_t, vals, 0)
        self.assertEqual(len(info["dropouts"]), 2, info)

    def test_steep_step_helper(self):
        raw = [100, 101, 103, 119, 120, None, 140, 141]
        self.assertTrue(B.steep_step(raw, 0, 4))           # 103 -> 119 = 16 bpm/s
        self.assertFalse(B.steep_step(raw, 3, 7))          # the None gap is not a step
        self.assertFalse(B.steep_step(raw, 0, 2))
        self.assertFalse(B.steep_step(raw, None, 4))

    def test_steep_rise_caps_conf_keeps_samples(self):
        """06-13 regression (113 -> 139 -> 157 -> 165 strap step on a set's rise):
        a > 15 bpm/s step that does not come back is no spike -> samples kept,
        the set is flagged nearArtifact + steepRise with conf <= 0.25."""
        for seed in (0, 1, 2):
            ts0, vals0, peaks, spec, _ = anchor_session(seed)
            raw0, _ = B.build_hr_series(ts0, vals0)
            ts = list(range(len(raw0)))                      # exact 1 Hz so the step size is known
            vals = [None if v is None else round(v) for v in raw0]
            p = peaks[3]                                      # second anchor (main work) set peak
            for t in range(p - 12, len(vals)):                # +20 bpm in one second, never returns steeply
                if vals[t] is not None:
                    vals[t] += 20 if t <= p + 15 else max(0, 20 - 0.5 * (t - p - 15))
            out, q, arts = self.match(ts, vals, spec, filt=True)
            self.assertEqual(arts["spikes"], 0, f"seed {seed}: the step must not be removed as a spike")
            hit = [o for o in out if o.get("steepRise")]
            self.assertTrue(hit, f"seed {seed}")
            k = min(range(len(out)), key=lambda i: abs((out[i]["tPeak"] or -10 ** 6) - p))
            self.assertTrue(out[k].get("steepRise"), f"seed {seed}: {out[k]}")
            for o in hit:
                self.assertTrue(o.get("nearArtifact"))
                self.assertLessEqual(o["conf"], B.ARTIFACT_CONF)
                self.assertLess(o["tStart"], p - 12)          # the step lies inside tStart -> tPeak
                self.assertGreaterEqual(o["tPeak"], p - 12)
            self.assertEqual(q["nearArtifact"], sum(1 for o in out if o.get("nearArtifact")))

    def test_clean_session_no_steep_rise(self):
        for seed in range(10):
            ts, vals, _, spec, _ = anchor_session(seed)
            out, _, _ = self.match(ts, vals, spec, filt=True)
            self.assertFalse([o for o in out if o.get("steepRise") or o.get("nearArtifact")], f"seed {seed}")

    def test_build_records_artifacts_and_low_conf(self):
        ts, vals, peaks, spec, _ = anchor_session(1)
        vals = list(vals)
        a = peaks[8] + 20
        for i, t in enumerate(ts):
            if a <= t <= a + 70:
                vals[i] = 72                              # strap dropped: frozen 72 bpm for 70 s
        w = make_workout(spec)
        w.update({"id": "W1", "title": "t", "updated_at": "2026-09-29T10:00:00.000Z",
                  "start_time": "2026-09-29T08:00:00+00:00",
                  "end_time": (B.parse_ts("2026-09-29T08:00:00+00:00")
                               + B.dt.timedelta(seconds=ts[-1])).isoformat()})
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hevy").mkdir()
            (Path(d) / "hevy" / "2026-09-29_W1.json").write_text(json.dumps(w), encoding="utf-8")
            write_hr(d, "strava_hr", "2026-09-29_999", "2026-09-29T08:00:00.000Z", ts, vals)
            data, _, _ = B.build(d, CFG, [])
        art = data["workouts"][0]["hr"]["artifacts"]
        self.assertEqual(art["spikes"], 0)
        self.assertGreaterEqual(art["dropoutS"], 60)
        self.assertIn("2026-09-29", data["meta"]["matchSummary"]["lowConfSessions"])
        self.assertIn("HR stream (Strava/Garmin, HRM600", data["meta"]["source"])


GYM_CFG = dict(CFG, gyms={"the ?fit(ness)?": "The Fitness", r"\bxxl\s*1?": "XXL", "technogym": "The Fitness"},
               machineTokens=["kl", "pq", "sprava", "1sprava", "masina", "sjedeci", "siroki", "uski",
                              "normal grip", "technogym"])
GYM_TMPL = {"ROW": {"equipment": "machine"}, "SSP": {"equipment": "machine"}, "CHEST": {"equipment": "machine"},
            "PULL": {"equipment": "cable"}, "BB": {"equipment": "barbell"}, "DB": {"equipment": "dumbbell"}}


def gym_workout(wid, exs, title="t", desc=""):
    """exs: [(templateId, notes)]"""
    return {"id": wid, "title": title, "description": desc,
            "exercises": [{"index": i, "title": f"{tid} title", "exercise_template_id": tid, "notes": n,
                           "superset_id": None, "sets": []} for i, (tid, n) in enumerate(exs)]}


class TestGymInference(unittest.TestCase):
    def test_machine_tokens_whole_words(self):
        self.assertEqual(B.machine_tokens("Xxl 1sprava uspravna", GYM_CFG), ["1sprava"])
        self.assertEqual(B.machine_tokens("The fitness sprava X", GYM_CFG), ["sprava"])
        self.assertEqual(B.machine_tokens("Normal  grip.", GYM_CFG), ["normal grip"])
        self.assertEqual(B.machine_tokens("Klthe fit x sprava", GYM_CFG), ["sprava"])   # 'kl' only as a word
        self.assertEqual(B.machine_tokens("Kl", GYM_CFG), ["kl"])
        self.assertEqual(B.machine_tokens("", GYM_CFG), [])

    def test_technogym_is_the_fitness(self):
        w = gym_workout("a", [("ROW", "technogym masina")])
        self.assertEqual(B.derive_gym(w, GYM_CFG), "The Fitness")

    def test_explicit_inferred_conflict_none(self):
        ws = [gym_workout("f1", [("ROW", "The fitness"), ("BB", ""), ("CHEST", "sprava X")]),
              gym_workout("x1", [("SSP", "Xxl"), ("BB", ""), ("DB", ""), ("CHEST", "Xxl 1sprava")]),
              gym_workout("f2", [("PULL", "")], title="The Fitness pull day"),
              gym_workout("x2", [("PULL", "")], desc="xxl1"),
              gym_workout("u_row", [("ROW", ""), ("BB", "")]),                 # ROW only at The Fitness
              gym_workout("u_ssp", [("SSP", ""), ("PULL", "Normal grip")]),    # SSP only at XXL; PULL both
              gym_workout("u_both", [("ROW", ""), ("SSP", "")]),               # conflict
              gym_workout("u_free", [("BB", ""), ("DB", "")]),                 # free weights: never evidence
              gym_workout("u_bbonly_f", [("DB", "")]),                         # DB seen only at XXL, still no
              gym_workout("u_tok", [("CHEST", "1sprava")]),                    # chest in both; + token -> XXL
              gym_workout("u_tok2", [("CHEST", "sprava")])]                    # -> The Fitness
        res = B.infer_gyms(ws, GYM_CFG, GYM_TMPL)
        self.assertEqual(res["f1"], ("The Fitness", "explicit", []))
        self.assertEqual(res["x1"][:2], ("XXL", "explicit"))
        self.assertEqual(res["f2"][:2], ("The Fitness", "explicit"))
        self.assertEqual(res["x2"][:2], ("XXL", "explicit"))
        self.assertEqual(res["u_row"], ("The Fitness", "inferred", ["ROW title"]))
        self.assertEqual(res["u_ssp"], ("XXL", "inferred", ["SSP title"]))
        self.assertEqual(res["u_both"][:2], ("unknown", "conflict"))
        self.assertEqual(sorted(res["u_both"][2]), ["ROW title (The Fitness)", "SSP title (XXL)"])
        self.assertEqual(res["u_free"], ("unknown", "none", []))
        self.assertEqual(res["u_bbonly_f"], ("unknown", "none", []))
        self.assertEqual(res["u_tok"], ("XXL", "inferred", ["CHEST title [1sprava]"]))
        self.assertEqual(res["u_tok2"], ("The Fitness", "inferred", ["CHEST title [sprava]"]))

    def test_no_propagation_from_inferred(self):
        # u1 is inferred The Fitness via ROW; its LEG machine must NOT become Fitness evidence for u2
        tm = dict(GYM_TMPL, LEG={"equipment": "machine"})
        ws = [gym_workout("f", [("ROW", "the fitness")]), gym_workout("x", [("SSP", "xxl")]),
              gym_workout("u1", [("ROW", ""), ("LEG", "")]), gym_workout("u2", [("LEG", "")])]
        res = B.infer_gyms(ws, GYM_CFG, tm)
        self.assertEqual(res["u1"][:2], ("The Fitness", "inferred"))
        self.assertEqual(res["u2"], ("unknown", "none", []))

    def test_build_uses_inferred_gym_in_keys(self):
        def hevy(wid, day, exs, title="t"):
            w = gym_workout(wid, exs, title=title)
            for e in w["exercises"]:
                e["sets"] = [{"index": 0, "type": "normal", "weight_kg": 50, "reps": 10, "rpe": 8}]
            w.update({"updated_at": f"2026-09-{day}T10:00:00Z", "start_time": f"2026-09-{day}T08:00:00+00:00",
                      "end_time": f"2026-09-{day}T09:00:00+00:00"})
            return w
        tm = [dict(v, id=k, title=k) for k, v in GYM_TMPL.items()]
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hevy").mkdir()
            for w in (hevy("F", "01", [("ROW", "the fitness"), ("BB", "")]),
                      hevy("X", "02", [("SSP", "xxl"), ("BB", "")]),
                      hevy("U", "03", [("ROW", ""), ("BB", "")]),
                      hevy("C", "04", [("ROW", ""), ("SSP", "")])):
                (Path(d) / "hevy" / f"{w['id']}.json").write_text(json.dumps(w), encoding="utf-8")
            data, _, _ = B.build(d, GYM_CFG, tm)
        by = {w["id"]: w for w in data["workouts"]}
        self.assertEqual((by["U"]["gym"], by["U"]["gymSource"], by["U"]["gymEvidence"]),
                         ("The Fitness", "inferred", ["ROW title"]))
        self.assertEqual((by["C"]["gym"], by["C"]["gymSource"]), ("unknown", "conflict"))
        self.assertEqual(by["F"]["gymSource"], "explicit")
        self.assertNotIn("gymEvidence", by["F"])
        self.assertEqual(len(data["exercises"]["ROW@The Fitness"]["series"]), 2)   # F + inferred U
        self.assertEqual(len(data["exercises"]["ROW@unknown"]["series"]), 1)       # conflict C
        self.assertEqual(data["meta"]["gymSummary"], {"explicit": {"The Fitness": 1, "XXL": 1},
                                                      "inferred": {"The Fitness": 1}, "conflict": 1, "unknown": 0})


class TestTemplates(unittest.TestCase):
    def raw_dir(self, d, tid):
        (Path(d) / "hevy").mkdir()
        (Path(d) / "hevy" / "w.json").write_text(json.dumps(
            {"id": "w", "exercises": [{"exercise_template_id": tid}]}), encoding="utf-8")
        return d

    def test_unknown_template_refreshes_once(self):
        calls = []

        def fetch():
            calls.append(1)
            return [{"id": "OLD"}, {"id": "NEW", "primary_muscle_group": "chest"}]
        with tempfile.TemporaryDirectory() as d:
            out = B.ensure_templates([{"id": "OLD"}], self.raw_dir(d, "NEW"), fetch=fetch)
            self.assertEqual(len(calls), 1)
            self.assertIn("NEW", {t["id"] for t in out})
            B.ensure_templates(out, d, fetch=fetch)       # all known now -> no fetch
            self.assertEqual(len(calls), 1)
            B.ensure_templates([{"id": "OLD"}], d, refreshed=True, fetch=fetch)   # already refreshed this run
            self.assertEqual(len(calls), 1)

    def test_refresh_failure_keeps_cache(self):
        def fetch():
            raise SystemExit("template fetch failed on page 1: HTTPError 503")
        with tempfile.TemporaryDirectory() as d:
            out = B.ensure_templates([{"id": "OLD"}], self.raw_dir(d, "NEW"), fetch=fetch)
        self.assertEqual(out, [{"id": "OLD"}])


if __name__ == "__main__":
    unittest.main()
