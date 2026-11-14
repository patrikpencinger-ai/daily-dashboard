"""Unit tests for tools/build_dashboard.py (stdlib unittest, offline).

    python -m unittest tools/test_build_dashboard.py

The end-to-end tests replay the SYNTHETIC recordings in tools/fixtures/build_dashboard/
(invented numbers): repo snapshot 2026-10-22, run --date 2026-10-28, i.e. a 6-day backfill
with a DST night (wake 10-25), an untracked night (wake 10-26), a merged gym + walk day
(10-25), a gym day with no Hevy workout (10-27) and two rest days (10-26, 10-28).
"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dashboard as B  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "build_dashboard"
REPLAY = FIX / "replay"
NOW = datetime(2026, 10, 28, 6, 15, 30, tzinfo=timezone.utc)          # 07:15:30 CET
FILES = ("sleep-data.json", "training-data.json", "strength-data.json", "data.json")


def run_cli(args, now=NOW, hevy_dir=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = B.main(args, now=now, hevy_dir=hevy_dir)
    return rc, out.getvalue() + err.getvalue()


class Rounding(unittest.TestCase):
    def test_half_up_integers(self):
        self.assertEqual([B.rhu(x) for x in (0.5, 1.5, 2.5, 72.5, 58.5, 60.5)], [1, 2, 3, 73, 59, 61])
        self.assertEqual(round(2.5), 2)                       # why rhu exists: Python rounds half to even

    def test_half_up_decimals(self):
        self.assertEqual(B.rhu(14.25, 1), 14.3)
        self.assertEqual(B.rhu(0.005, 2), 0.01)
        self.assertEqual(B.rhu(6.35, 1), 6.4)
        self.assertEqual(B.rhu(22800 / 3600, 2), 6.33)

    def test_negative_ties_toward_plus_infinity(self):        # JS Math.round
        self.assertEqual(B.rhu(-2.5), -2)
        self.assertEqual(B.rhu(-2.6), -3)
        self.assertIsNone(B.rhu(None))


class Formulas(unittest.TestCase):
    def test_readiness_fitted_formula(self):
        trend = [{"hrv": 40, "rhr": 56}] * 27 + [{"hrv": 46, "rhr": 53}]
        # hb 40.214, rb 55.893 -> hN .740, rN .773 -> 78.30
        self.assertEqual(B.readiness(trend, 78, 46, 53), 78)

    def test_readiness_window_is_last_28_rows_nulls_skipped(self):
        old = [{"hrv": 99, "rhr": 99}] * 10
        trend = old + [{"hrv": None, "rhr": 56}] + [{"hrv": 40, "rhr": 56}] * 26 + [{"hrv": 46, "rhr": 53}]
        self.assertEqual(B.readiness(trend, 78, 46, 53), 78)

    def test_readiness_clamps(self):
        trend = [{"hrv": 40, "rhr": 56}] * 28
        hi = B.readiness(trend, 90, 400, 20)                  # hN, rN clamp to 1
        self.assertEqual(hi, B.rhu(100 * (1.0981 * 0.9 + 0.0269 - 0.0181 - 0.0794)))

    def test_c5l_bands(self):                                 # LEAD D5
        got = [B.c5l(x, "en") for x in (95, 88, 87, 80, 79, 60, 59, 10)]
        self.assertEqual(got, ["Excellent", "Excellent", "Good", "Good", "Fair", "Fair", "Poor", "Poor"])
        self.assertEqual([B.c5l(x, "hr") for x in (88, 86, 61, 45)], ["Izvrsna", "Dobra", "Osrednja", "Loša"])

    def test_sleep_score_band(self):
        self.assertEqual([B.band(x, "en") for x in (90, 89, 80, 79, 60, 59)],
                         ["excellent", "good", "good", "fair", "fair", "poor"])
        self.assertEqual(B.band(48, "hr"), "loša")

    def test_effort_and_clock(self):
        self.assertEqual(B.clock_dec("23:40", True), -0.33)
        self.assertEqual(B.clock_dec("00:11", True), 0.18)
        self.assertEqual(B.clock_dec("06:03", False), 6.05)

    def test_version_bump(self):
        self.assertEqual(B.bump_version("v2.36-auto"), "v2.37-auto")
        self.assertEqual(B.bump_version("v1.99-auto"), "v2.00-auto")


class Labels(unittest.TestCase):
    def test_durations(self):
        self.assertEqual(B.hm(380), "6h 20m")
        self.assertEqual(B.hm(369), "6h 09m")
        self.assertEqual(B.hm_compact(516), "8h36")
        self.assertEqual(B.signed_dur(-37), "−37m")
        self.assertEqual(B.signed_dur(65), "+1h 05m")         # LEAD D12
        self.assertEqual(B.signed_dur(-97), "−1h 37m")

    def test_deltas(self):
        self.assertEqual(B.sg(0), "±0")
        self.assertEqual(B.sg(-3), "−3")
        self.assertEqual(B.delta_clause(46, 38, "en", "night"), "+8 vs the last recorded night (38)")
        self.assertEqual(B.delta_clause(36, 36, "en", "avg"), "±0 vs the 7-night avg (36)")       # LEAD D12
        self.assertEqual(B.delta_clause(36, 36, "hr", "avg"), "±0 vs prosjek 7 noći (36)")
        self.assertEqual(B.delta_clause(85, 85, "hr", "night"), "±0 vs zadnja zabilježena noć (85)")

    def test_croatian_plurals(self):
        f = lambda n: B.hr_count(n, "trening", "treninga", "treninga")  # noqa: E731
        self.assertEqual([f(n) for n in (1, 2, 4, 5, 0)], ["1 trening", "2 treninga", "4 treninga", "5 treninga",
                                                            "0 treninga"])
        g = lambda n: B.hr_count(n, "teretana", "teretane", "teretana")  # noqa: E731
        self.assertEqual([g(n) for n in (1, 3, 5, 7, 11, 12, 13, 14)],
                         ["1 teretana", "3 teretane", "5 teretana", "7 teretana", "11 teretana", "12 teretana",
                          "13 teretana", "14 teretana"])
        self.assertEqual(B.hr_count(2, "šetnja", "šetnje", "šetnji"), "2 šetnje")
        self.assertEqual(B.hr_count(6, "šetnja", "šetnje", "šetnji"), "6 šetnji")

    def test_k3d(self):
        self.assertEqual(B.k3d(["str", "rest", "str", "str"], "en"), "3 gym sessions · no swim")
        self.assertEqual(B.k3d(["str", "rest", "str", "str"], "hr"), "3 teretane · bez plivanja")
        self.assertEqual(B.k3d(["str"], "en"), "1 gym session · no swim")
        self.assertEqual(B.k3d(["str", "str", "pool", "walk"], "en"), "2 gym sessions · 1 swim · 1 walk")
        self.assertEqual(B.k3d(["str", "str", "pool", "walk"], "hr"), "2 teretane · 1 plivanje · 1 šetnja")
        self.assertEqual(B.k3d(["str", "str", "pool", "pool", "ows", "walk", "hike"], "en"),
                         "2 gym sessions · 2 pool swims · 1 open-water swim · 1 walk · 1 hike")
        self.assertEqual(B.k3d(["str"] * 5, "hr"), "5 teretana · bez plivanja")
        self.assertEqual(B.k3d(["str", "pool", "pool", "walk", "walk", "hike"], "hr"),
                         "1 teretana · 2 plivanja u bazenu · 2 šetnje · 1 planinarenje")

    def test_swim_set(self):
        self.assertEqual(B.swim_set("2200m 10x100 10x50"), "10×100 + 10×50")
        self.assertEqual(B.swim_set("500 + 8x200 + 100"), "500 + 8×200 + 100")
        self.assertEqual(B.swim_set("N4x4 v2 2200m"), "N4×4")

    def test_lift_ladder(self):
        self.assertEqual([B.lift_of(t) for t in ("Hack Squat day", "Squats day front loaded barbell",
                                                 "Barbell DEAD LIFT☀️", "Trap bar deadlift day ☀️", "Squats day",
                                                 "Strength")],
                         ["hack", "front", "bbdl", "trap", "squat", "other"])

    def test_lift_clause(self):
        t = {"latest": {"d": "2026-11-12", "w": 120, "reps": 8}, "previous": {"d": "2026-11-05", "w": 130, "reps": 8},
             "pctChange": -7.7}
        self.assertEqual(B.lift_clause("bbdl", t, "en"), "barbell deadlift 120 kg × 8 on Nov 12, −7.7% on Nov 5")
        self.assertEqual(B.lift_clause("bbdl", t, "hr"),
                         "mrtvo dizanje sa šipkom 120 kg × 8 dana 12.11., −7,7% na 5.11.")
        t = {"latest": {"d": "2026-11-09", "w": 180, "reps": 15}, "previous": {"d": "2026-11-03", "w": 180, "reps": 12},
             "pctChange": 0.0}
        self.assertEqual(B.lift_clause("hack", t, "en"), "hack squat 180 kg × 15 on Nov 9, up from 180 kg × 12 on Nov 3")


class EndToEnd(unittest.TestCase):
    """Replays the synthetic fixture with the real CLI entry point."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bd-test-"))
        self.repo = self.tmp / "repo"
        shutil.copytree(FIX / "repo", self.repo)
        self.facts = self.tmp / "facts.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def args(self, date="2026-10-28", replay=REPLAY, *extra):
        return ["--date", date, "--repo", str(self.repo), "--replay", str(replay), "--facts", str(self.facts)] \
            + list(extra)

    def snapshot(self):
        return {f: (self.repo / f).read_bytes() for f in FILES}

    def build(self):
        rc, log = run_cli(self.args())
        self.assertEqual(rc, 0, log)
        load = lambda f: json.loads((self.repo / f).read_text(encoding="utf-8"))  # noqa: E731
        return load("sleep-data.json"), load("training-data.json"), load("data.json"), \
            json.loads(self.facts.read_text(encoding="utf-8"))

    # ---- sleep ------------------------------------------------------------------------- #

    def test_backfill_appends_every_missing_trend_day(self):
        s, _, _, facts = self.build()
        tail = s["num"]["trend"][-6:]
        self.assertEqual([r["d"] for r in tail], [f"2026-10-{d}" for d in range(23, 29)])
        self.assertEqual(facts["appended"]["trend"], [f"2026-10-{d}" for d in range(23, 29)])
        before = json.loads((FIX / "repo" / "sleep-data.json").read_text(encoding="utf-8"))["num"]["trend"]
        self.assertEqual(s["num"]["trend"][:len(before)], before)          # history untouched

    def test_untracked_night_is_a_null_trend_row_and_skipped_in_week(self):
        s, _, _, facts = self.build()
        row = [r for r in s["num"]["trend"] if r["d"] == "2026-10-26"][0]
        self.assertEqual(row, {"d": "2026-10-26", "rhr": row["rhr"], "hrv": None, "score": None, "durH": None,
                               "deepH": None, "awakeMin": None})
        self.assertIsNotNone(row["rhr"])
        en, hr = s["text"]["en"], s["text"]["hr"]
        self.assertEqual(en["daysFull"], ["Tue 20", "Wed 21", "Thu 22", "Fri 23", "Sat 24", "Mon 26", "Tue 27"])
        self.assertEqual(hr["daysShort"], ["U20", "S21", "Č22", "P23", "S24", "P26", "U27"])
        self.assertTrue(all(len(v) == 7 for k, v in s["num"]["week"].items() if k != "hrvAvg"))
        self.assertTrue(s["meta"]["footEn"].endswith("Tue 20 through Tue 27 (Sun 25 untracked)."))
        self.assertTrue(s["meta"]["footHr"].endswith("uto 20. do uto 27. (ned 25. nije zabilježena)."))
        self.assertEqual(facts["sleep"]["untrackedInSpan"], ["2026-10-25"])

    def test_dst_night_bed_time_is_real_cest_wall_clock(self):
        s, _, _, _ = self.build()
        sw = s["num"]["sleepWake"]
        i = s["text"]["en"]["daysFull"].index("Sat 24")        # wake 2026-10-25, clocks went back that night
        self.assertEqual((sw["bedL"][i], sw["wakeL"][i]), ("21:50", "05:50"))   # Garmin *Local said 20:50
        self.assertEqual(sw["bed"][i], -2.17)
        self.assertEqual(sw["dur"][i], "8h40")

    def test_last_night_labels_and_meta(self):
        s, _, _, _ = self.build()
        ln, en, hr = s["num"]["lastNight"], s["text"]["en"], s["text"]["hr"]
        self.assertEqual(en["today"], f"Tue→Wed night: {ln['durationLabel']}, {ln['awakeMin']} min awake")
        self.assertEqual(hr["today"], f"Noć uto→sri: {ln['durationLabel']}, {ln['awakeMin']} min budan")
        self.assertEqual(en["badge"], f"Score {ln['score']} on {ln['durationLabel']} · HRV {ln['hrv']} · RHR {ln['rhr']}")
        self.assertEqual(en["c5l"], B.c5l(ln["readiness"], "en"))
        self.assertEqual(s["meta"]["version"], "v2.00-auto")
        self.assertEqual(s["meta"]["snapshot"], "2026-10-28")
        self.assertEqual(s["meta"]["refreshedAt"], "2026-10-28T07:15:30+01:00")
        self.assertEqual(en["rec"], "Narrative sleep rec (en) — keep me.")
        self.assertEqual(en["c5d"], "static c5d en")
        self.assertEqual(list(s["meta"]), ["version", "snapshot", "refreshedAt", "footEn", "footHr"])

    # ---- training ---------------------------------------------------------------------- #

    def test_merged_multi_activity_day(self):
        _, t, _, _ = self.build()
        dl = t["num"]["daily"]
        i = t["text"]["en"]["days"].index("Sun 25")
        self.assertEqual(dl["type"][i], "str")
        self.assertEqual(dl["names"][i], "Front squat day — front squat + accessories, 2,230 kg + "
                                         "Zagreb walk 3.1 km, 1h 01m")
        self.assertEqual(dl["dur"][i], 126)                    # (3900 + 3660) s
        self.assertEqual(dl["kcal"][i], 730)
        self.assertEqual(dl["avghr"][i], 107)                  # duration-weighted (116, 98)
        self.assertEqual(dl["maxhr"][i], 158)
        self.assertEqual(dl["effort"][i], B.rhu(126 * (107 - 53) / 121))
        self.assertEqual(dl["vol"][i], 2230)
        self.assertIsNone(dl["dist"][i])

    def test_rest_day_hr_from_usersummary_and_daily_samples(self):
        _, t, _, _ = self.build()
        dl, days = t["num"]["daily"], t["text"]["en"]["days"]
        i, j = days.index("Mon 26"), days.index("Wed 28")
        self.assertEqual((dl["type"][i], dl["names"][i]), ("rest", "Rest day"))
        self.assertEqual((dl["maxhr"][i], dl["avghr"][i]), (118, 61))   # mean 60.5 -> 61 (half up)
        self.assertEqual((dl["maxhr"][j], dl["avghr"][j]), (99, 56))
        self.assertEqual([dl[k][i] for k in ("effort", "dur", "kcal", "vol", "dist")], [None] * 5)
        self.assertIsNotNone(dl["rhr"][i])

    def test_gym_day_without_hevy(self):
        _, t, _, facts = self.build()
        row = t["num"]["gym"][-1]
        self.assertEqual(row["d"], "2026-10-27")
        self.assertEqual([row[k] for k in ("vol", "sets", "reps", "top")], [None] * 4)
        self.assertEqual((row["t"], row["mx"], row["av"], row["dur"], row["kcal"]), ("Strength", 149, 112, 58, 455))
        i = t["text"]["en"]["days"].index("Tue 27")
        self.assertEqual(t["num"]["daily"]["names"][i], "Strength")         # no kg (LEAD D12)
        self.assertTrue(any("2026-10-27" in w and "Hevy" in w for w in facts["warnings"]))

    def test_gym_swim_mld_append_only_with_dedupe(self):
        _, t, _, _ = self.build()
        n = t["num"]
        self.assertEqual([r["d"] for r in n["gym"]], ["2026-10-12", "2026-10-22", "2026-10-23", "2026-10-25",
                                                      "2026-10-27"])
        self.assertEqual(n["gym"][1]["volWork"], 1760)                     # builder key preserved
        self.assertNotIn("volWork", n["gym"][2])                           # never computed here
        g = n["gym"][2]
        self.assertEqual((g["t"], g["lift"], g["vol"], g["sets"], g["reps"], g["top"]),
                         ("Hack Squat day", "hack", 7385, 6, 62, {"w": 170, "reps": 12}))
        self.assertEqual((g["tmax"], g["tmin"]), (14.3, 6.4))
        self.assertEqual([r["d"] for r in n["swim"]], ["2026-10-17", "2026-10-24"])
        sw = n["swim"][-1]
        self.assertEqual((sw["t"], sw["sec100"], sw["pace"], sw["lengths"], sw["spm"]),
                         ("2200m 10x100 10x50", 133, "2:13", 90, 27))
        self.assertEqual(n["mld"]["hack"][-1], {"d": "2026-10-23", "l": "Oct 23", "w": 170, "mx": 155, "av": 129,
                                                "dl": 34, "pk": [112, 129, 146], "cf": 0})
        self.assertEqual(len(n["mld"]["trap"]), 1)                         # retired lift untouched

    def test_windows_kpis_text(self):
        _, t, _, _ = self.build()
        en, hr, n = t["text"]["en"], t["text"]["hr"], t["num"]
        self.assertEqual(en["days"], ["Thu 22", "Fri 23", "Sat 24", "Sun 25", "Mon 26", "Tue 27", "Wed 28"])
        self.assertEqual(hr["daysM"], ["Č22", "P23", "S24", "N25", "P26", "U27", "S28"])
        self.assertEqual(n["daily"]["type"], ["str", "str", "pool", "str", "rest", "str", "rest"])
        self.assertEqual(n["kpis"], {"sessions": "5", "totalTime": "6h 17m", "volume": "11,675 kg",
                                     "activeCals": "2,995"})
        self.assertEqual(en["k1d"], "5 sessions · 5/7 days active")
        self.assertEqual(en["k2d"], "avg 75m per session")
        self.assertEqual(en["k3d"], "4 gym sessions · 1 swim")
        self.assertEqual(hr["k3d"], "4 teretane · 1 plivanje")
        self.assertEqual(en["foot"], "Data: 2026-10-22 → 2026-10-28 · Garmin fenix 8 via the Garmin Connect API + Hevy")
        self.assertEqual(hr["foot"], "Podaci: 22.10. → 28.10.2026. · Garmin fenix 8 putem Garmin Connect API-ja + Hevy")
        self.assertTrue(en["foot2"].startswith("ACWR 2.25 on 10,775 kg acute vs 4,794 kg chronic work tonnage · "))
        self.assertIn("hack squat 170 kg × 12 on Oct 23, +13.3% on Oct 12", en["foot2"])
        self.assertTrue(hr["foot2"].endswith("zadnje plivanje 10×100 + 10×50 uz 2:13 po 100 m dana 24.10."))
        self.assertEqual(en["i1"], "Narrative i1 (en) — keep me.")
        self.assertEqual(en["today"], "static today en")
        self.assertEqual(t["meta"], {"version": "v2.10-auto", "snapshot": "2026-10-28",
                                     "refreshedAt": "2026-10-28T07:15:30+01:00"})

    def test_energy_burn_bridge_from_food_log(self):
        _, t, _, facts = self.build()
        e, b = t["num"]["energy"], t["num"]["burn"]
        self.assertEqual(e["eint"], [None, None, 1850, None, None, None, None])
        self.assertEqual(b["logged"], [False, False, True, False, False, False, False])
        self.assertEqual(b["intake"][2], 1850)
        self.assertEqual(b["exnet"], e["edaily"])
        self.assertEqual(e["eavg"], [B.rhu(sum(e["edaily"]) / 7)] * 7)
        self.assertEqual(t["num"]["bridge"], [{"label": "Sat 24", "int": 1850, "ex": e["edaily"][2],
                                               "bal": 1850 - (2414 + e["edaily"][2])}])
        self.assertEqual(t["text"]["en"]["k4d"], f"~{e['eavg'][0]} kcal/day active · intake logged 1/7 days")
        self.assertEqual(facts["training"]["foodLogCount"], 1)

    def test_facts(self):
        _, t, _, f = self.build()
        self.assertEqual(f["flag"]["id"], "acwr")
        self.assertEqual(f["flag"]["acwr"], 2.25)
        # volWork (10-22) / strength-data tonnageWork (10-23: 6785, not vol 7385) / vol (10-25)
        self.assertEqual(f["training"]["tonnage"]["now"]["acute"], 1760 + 6785 + 2230)
        self.assertEqual(f["filled"], [])
        self.assertEqual(f["training"]["liftsSeen28d"], ["bbdl", "front", "hack", "other"])
        self.assertEqual(f["training"]["topSets"]["hack"]["pctChange"], 13.3)
        self.assertEqual(f["sleep"]["baseline28"]["rows"], 28)
        self.assertIn("count", f["sleep"]["sleepDebt"])
        self.assertEqual(f["appended"]["mld"], [["hack", "2026-10-23"]])

    def set_snapshot(self, snap):
        p = self.repo / "sleep-data.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        doc["meta"]["snapshot"] = snap
        p.write_text(B.dump_json(doc), encoding="utf-8")

    def test_hevy_lag_row_completed_once_hevy_syncs(self):
        """LEAD D14 (verifier repro): gym row appended before Hevy synced -> later run completes it."""
        lag = self.tmp / "replay-lag"
        shutil.copytree(REPLAY, lag)
        (lag / "hevy" / "2026-10-23_w-hack.json").unlink()
        rc, log = run_cli(self.args("2026-10-28", lag))
        self.assertEqual(rc, 0, log)
        t1 = json.loads((self.repo / "training-data.json").read_text(encoding="utf-8"))
        r1 = [r for r in t1["num"]["gym"] if r["d"] == "2026-10-23"][0]
        self.assertEqual((r1["t"], r1["lift"], r1["vol"], r1["top"]), ("Strength", "other", None, None))
        self.assertNotIn("2026-10-23", [x["d"] for x in t1["num"]["mld"]["hack"]])
        self.set_snapshot("2026-10-27")                        # next run, Hevy file now in the cache
        _, t, _, f = self.build()
        rows = [r for r in t["num"]["gym"] if r["d"] == "2026-10-23"]
        self.assertEqual(len(rows), 1)                         # completed in place, not appended twice
        r = rows[0]
        self.assertEqual((r["t"], r["lift"], r["vol"], r["sets"], r["reps"], r["top"]),
                         ("Hack Squat day", "hack", 7385, 6, 62, {"w": 170, "reps": 12}))
        self.assertEqual(list(r), list(r1))                    # key order kept
        self.assertEqual((r["mx"], r["av"], r["dur"], r["kcal"], r["tmax"]), (r1["mx"], r1["av"], r1["dur"],
                                                                                r1["kcal"], r1["tmax"]))
        mld = t["num"]["mld"]["hack"]
        self.assertEqual(mld[-1], {"d": "2026-10-23", "l": "Oct 23", "w": 170, "mx": 155, "av": 129, "dl": 34,
                                   "pk": [112, 129, 146], "cf": 0})
        self.assertEqual([x["d"] for x in mld], sorted(x["d"] for x in mld))
        self.assertEqual([(x["d"], x["t"], x["lift"]) for x in f["filled"]],
                         [("2026-10-23", "Hack Squat day", "hack")])
        self.assertEqual(f["appended"]["mld"], [["hack", "2026-10-23"]])

    def test_hevy_lag_never_touches_non_null_vol_or_rows_older_than_7_days(self):
        p = self.repo / "training-data.json"
        t0 = json.loads(p.read_text(encoding="utf-8"))
        old, recent = t0["num"]["gym"]
        old.update({"vol": None, "t": "Strength"})            # 10-12: outside the 7-day window
        recent.update({"vol": 9999, "sets": None})            # 10-22: vol known -> never touched
        p.write_text(B.dump_json(t0), encoding="utf-8")
        _, t, _, f = self.build()
        o, r = t["num"]["gym"][0], t["num"]["gym"][1]
        self.assertEqual((o["vol"], o["t"]), (None, "Strength"))
        self.assertEqual((r["vol"], r["sets"]), (9999, None))
        self.assertEqual(f["filled"], [])

    def test_tracked_night_without_hrv(self):
        nohrv = self.tmp / "replay-nohrv"
        shutil.copytree(REPLAY, nohrv)
        hp = nohrv / "garmin" / B.slug("/hrv-service/hrv/daily/2026-10-01/2026-10-28", None)
        h = json.loads(hp.read_text(encoding="utf-8"))
        h["hrvSummaries"] = [x for x in h["hrvSummaries"] if x["calendarDate"] != "2026-10-28"]
        hp.write_text(json.dumps(h), encoding="utf-8")
        rc, log = run_cli(self.args("2026-10-28", nohrv))
        self.assertEqual(rc, 0, log)
        s = json.loads((self.repo / "sleep-data.json").read_text(encoding="utf-8"))
        f = json.loads(self.facts.read_text(encoding="utf-8"))
        wk, ln = s["num"]["week"], s["num"]["lastNight"]
        self.assertIsNone(ln["hrv"])
        self.assertIsNone(wk["hrv"][-1])
        self.assertIsNone(s["num"]["trend"][-1]["hrv"])
        self.assertEqual(wk["hrvAvg"], B.rhu(sum(wk["hrv"][:-1]) / 6))
        self.assertEqual(s["text"]["en"]["c4d"], "no HRV reading")
        self.assertEqual(s["text"]["hr"]["c4d"], "nema HRV očitanja")
        self.assertIn("HRV n/a", s["text"]["en"]["badge"])
        trend = s["num"]["trend"]
        w = trend[-28:]
        rb = sum(x["rhr"] for x in w) / len(w)
        rN = (max(0.9, min(1.1, rb / ln["rhr"])) - 0.9) / 0.2
        expect = B.rhu(100 * (1.0981 * ln["score"] / 100 + 0.0269 * 0.5 - 0.0181 * rN - 0.0794))
        self.assertEqual(ln["readiness"], expect)               # hN = 0.5 (neutral)
        self.assertIsNone(f["sleep"]["lastNight"]["vsPrevNight"]["hrv"])
        self.assertTrue(any("without an HRV reading" in x for x in f["warnings"]))

    # ---- format, idempotence, exit codes ----------------------------------------------- #

    def test_output_format_round_trips(self):
        for f in ("sleep-data.json", "training-data.json"):
            raw = (FIX / "repo" / f).read_text(encoding="utf-8")
            self.assertEqual(B.dump_json(json.loads(raw)), raw)          # a no-change rebuild is no diff
        self.build()
        raw = (self.repo / "sleep-data.json").read_bytes()
        self.assertTrue(raw.endswith(b"}\n") and b"\r\n" not in raw)
        self.assertIn("→".encode("utf-8"), raw)                           # ensure_ascii=False
        self.assertTrue(raw.startswith(b'{\n  "meta": {\n    "version"'))

    def test_idempotent_second_run_exit_4_no_diff(self):
        self.build()
        before = self.snapshot()
        rc, _ = run_cli(self.args())
        self.assertEqual(rc, 4)
        self.assertEqual(self.snapshot(), before)

    def test_dry_run_writes_facts_only(self):
        before = self.snapshot()
        rc, log = run_cli(self.args("2026-10-28", REPLAY, "--dry-run"))
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(json.loads(self.facts.read_text(encoding="utf-8"))["dryRun"])

    def test_exit_3_no_sleep_record_writes_nothing(self):
        before = self.snapshot()
        rc, _ = run_cli(self.args("2026-10-26"))
        self.assertEqual(rc, 3)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.facts.exists())

    def test_exit_5_date_before_snapshot(self):
        before = self.snapshot()
        rc, log = run_cli(self.args("2026-10-21"))
        self.assertEqual(rc, 5, log)
        self.assertIn("earlier than sleep-data.json meta.snapshot", log)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.facts.exists())

    def test_exit_6_internal_error_writes_nothing(self):
        before = self.snapshot()
        saved = B.build_sleep

        def boom(*a, **k):
            raise KeyError("synthetic bug")
        B.build_sleep = boom
        try:
            rc, log = run_cli(self.args())
        finally:
            B.build_sleep = saved
        self.assertEqual(rc, 6)
        self.assertIn("Traceback", log)
        self.assertIn("synthetic bug", log)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.facts.exists())

    def test_exit_4_already_refreshed(self):
        rc, _ = run_cli(self.args("2026-10-22"))
        self.assertEqual(rc, 4)

    def test_exit_5_local_inputs(self):
        before = self.snapshot()
        (self.repo / "strength-data.json").unlink()
        self.assertEqual(run_cli(self.args())[0], 5)
        shutil.copy(FIX / "repo" / "strength-data.json", self.repo / "strength-data.json")
        (self.repo / "training-data.json").write_text("{ not json", encoding="utf-8")
        self.assertEqual(run_cli(self.args())[0], 5)
        shutil.copy(FIX / "repo" / "training-data.json", self.repo / "training-data.json")
        no_hevy = self.tmp / "replay-no-hevy"
        shutil.copytree(REPLAY, no_hevy)
        shutil.rmtree(no_hevy / "hevy")
        self.assertEqual(run_cli(self.args("2026-10-28", no_hevy), hevy_dir=self.tmp / "missing")[0], 5)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.facts.exists())

    def test_exit_1_missing_recording(self):
        before = self.snapshot()
        self.assertEqual(run_cli(self.args("2026-10-27"))[0], 1)
        self.assertEqual(self.snapshot(), before)

    def test_open_meteo_failure_gives_null_temps_and_warning(self):
        broken = self.tmp / "replay-no-meteo"
        shutil.copytree(REPLAY, broken)
        shutil.rmtree(broken / "openmeteo")
        rc, log = run_cli(self.args("2026-10-28", broken))
        self.assertEqual(rc, 0, log)
        t = json.loads((self.repo / "training-data.json").read_text(encoding="utf-8"))
        self.assertEqual({(r["tmax"], r["tmin"]) for r in t["num"]["gym"][-3:]}, {(None, None)})
        f = json.loads(self.facts.read_text(encoding="utf-8"))
        self.assertTrue(any("Open-Meteo" in w for w in f["warnings"]))


class FlagLadder(unittest.TestCase):
    DEBT0 = {"count": 0, "shortfallH": 0, "nights": []}
    LAST = {"rhr": 50, "hrv": 50}
    RAW = {"rhr": 55.0, "hrv": 40.0}
    BASE = {"rhr": 55.0, "hrv": 40.0}

    def tops(self, raw):
        return {"hack": {"latest": {"d": "2026-11-09", "w": 110.04, "reps": 8},
                         "previous": {"d": "2026-11-03", "w": 100, "reps": 8},
                         "pctChange": B.rhu(raw, 1), "_pct_raw": raw}}

    def test_acwr_compares_raw_value(self):
        t = {"acwr": 1.3, "_acwr_raw": 1.304, "acute": 13040, "chronic": 10000}
        self.assertEqual(B.flag_ladder(t, {}, self.DEBT0, self.LAST, self.RAW, self.BASE)["id"], "acwr")
        t = {"acwr": 1.3, "_acwr_raw": 1.2996, "acute": 12996, "chronic": 10000}
        self.assertEqual(B.flag_ladder(t, {}, self.DEBT0, self.LAST, self.RAW, self.BASE)["id"], "none")

    def test_top_set_jump_compares_raw_percent(self):
        t = {"acwr": 1.0, "_acwr_raw": 1.0, "acute": 1, "chronic": 1}
        f = B.flag_ladder(t, self.tops(10.04), self.DEBT0, self.LAST, self.RAW, self.BASE)
        self.assertEqual((f["id"], f["pctChange"]), ("topSetJump", 10.0))
        f = B.flag_ladder(t, self.tops(9.996), self.DEBT0, self.LAST, self.RAW, self.BASE)
        self.assertEqual(f["id"], "none")

    def test_ladder_order_debt_then_divergence(self):
        t = {"acwr": 1.0, "_acwr_raw": 1.0, "acute": 1, "chronic": 1}
        debt = {"count": 2, "shortfallH": 1.5, "nights": []}
        self.assertEqual(B.flag_ladder(t, {}, debt, {"rhr": 60, "hrv": 30}, self.RAW, self.BASE)["id"], "sleepDebt")
        self.assertEqual(B.flag_ladder(t, {}, self.DEBT0, {"rhr": 60, "hrv": 30}, self.RAW, self.BASE)["id"],
                         "rhrHrvDivergence")


class OpenMeteo(unittest.TestCase):
    def test_http_exception_gives_null_temps_and_warning(self):
        import http.client
        saved_open, saved_sleep = B.urllib.request.urlopen, B.time.sleep

        def bad(*a, **k):
            raise http.client.IncompleteRead(b"")              # HTTPException, not OSError
        B.urllib.request.urlopen, B.time.sleep = bad, (lambda s: None)
        try:
            temps, warn = B.Fetcher().weather(B.D("2026-10-23"), B.D("2026-10-24"))
        finally:
            B.urllib.request.urlopen, B.time.sleep = saved_open, saved_sleep
        self.assertEqual(temps, {})
        self.assertIn("IncompleteRead", warn)
        self.assertIn("tmax/tmin null", warn)


class Record(unittest.TestCase):
    def test_record_then_replay_identical(self):
        """--record writes what --replay reads: record via a fake client, replay offline."""
        tmp = Path(tempfile.mkdtemp(prefix="bd-rec-"))
        try:
            src = B.Fetcher(replay=str(REPLAY))

            class FakeClient:
                def get(self, path, params=None):
                    return src.get(path, params)
            rec = B.Fetcher(record=str(tmp / "rec"))
            rec._client = FakeClient()
            for r in (tmp / "a", tmp / "b"):
                shutil.copytree(FIX / "repo", r)
            rec.weather = src.weather                      # Open-Meteo is not under test here
            with redirect_stdout(io.StringIO()):
                rc = B.run(B.D("2026-10-28"), tmp / "a", tmp / "fa.json", False, rec, now=NOW,
                           hevy_dir=REPLAY / "hevy")
            self.assertEqual(rc, 0)
            shutil.copytree(REPLAY / "openmeteo", tmp / "rec" / "openmeteo")
            with redirect_stdout(io.StringIO()):
                rc = B.run(B.D("2026-10-28"), tmp / "b", tmp / "fb.json", False,
                           B.Fetcher(replay=str(tmp / "rec")), now=NOW)
            self.assertEqual(rc, 0)
            for f in ("sleep-data.json", "training-data.json"):
                self.assertEqual((tmp / "a" / f).read_bytes(), (tmp / "b" / f).read_bytes())
            self.assertTrue((tmp / "rec" / "hevy" / "2026-10-23_w-hack.json").exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
