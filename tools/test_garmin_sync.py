"""Unit tests for tools/garmin_sync.py (stdlib unittest, offline).

    python -m unittest tools/test_garmin_sync.py
"""
import base64
import json
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import garmin_sync as G  # noqa: E402

# 2026-11-03 night: 22:22 -> 06:05 local, CET (+1 h)
SLEEP = {"calendarDate": "2026-11-03", "sleepTimeSeconds": 26040, "unmeasurableSleepSeconds": 0,
         "deepSleepSeconds": 5040, "lightSleepSeconds": 17520, "remSleepSeconds": 3480,
         "awakeSleepSeconds": 1740, "sleepStartTimestampGMT": 1793654557000,
         "sleepStartTimestampLocal": 1793658157000, "sleepEndTimestampLocal": 1793685937000,
         "sleepScores": {"overall": {"value": 78, "qualifierKey": "FAIR"}}}
UNTRACKED = {"deviceRemCapable": False, "sleepNeed": {"calendarDate": "2026-11-02", "actual": 440}}
HRV = [{"calendarDate": "2026-11-02", "lastNightAvg": 30, "weeklyAvg": 35, "status": "LOW"},
       {"calendarDate": "2026-11-03", "lastNightAvg": 43, "weeklyAvg": 35, "status": "LOW"}]
SUMMARY = [{"calendarDate": "2026-11-03", "heartRate": {"restingValue": 56}, "stress": {"avgLevel": 29},
            "calories": {"burnedResting": 651, "burnedActive": 13},
            "bodyBattery": {"chargedValue": 30, "drainedValue": 2, "maxValue": 48, "minValue": 18}}]


class BuildRows(unittest.TestCase):
    def setUp(self):
        self.rows = G.build_rows(date(2026, 11, 1), date(2026, 11, 3), [UNTRACKED, SLEEP], HRV, SUMMARY)

    def test_one_row_per_day_including_gaps(self):
        self.assertEqual(list(self.rows), ["2026-11-01", "2026-11-02", "2026-11-03"])
        self.assertIsNone(self.rows["2026-11-01"]["sleep_durationInSeconds"])

    def test_sleep_fields(self):
        r = self.rows["2026-11-03"]
        self.assertEqual(r["sleep_overallSleepScore"], 78)
        self.assertEqual(r["sleep_durationInSeconds"], 26040)
        self.assertEqual(r["sleep_remSleepInSeconds"], 3480)
        self.assertEqual((r["sleep_bedLocal"], r["sleep_wakeLocal"]), ("22:22", "06:05"))
        self.assertEqual(r["sleep_startTimeInSeconds"], 1793654557)
        self.assertEqual(r["sleep_startTimeOffsetInSeconds"], 3600)

    def test_untracked_night_keyed_by_sleep_need_and_hrv_nulled(self):
        r = self.rows["2026-11-02"]
        self.assertIsNone(r["sleep_durationInSeconds"])
        self.assertIsNone(r["hrv_lastNightAvg"])
        self.assertEqual(r["hrv_status"], "LOW")

    def test_daily_fields(self):
        r = self.rows["2026-11-03"]
        self.assertEqual(r["hrv_lastNightAvg"], 43)
        self.assertEqual(r["daily_restingHeartRateInBeatsPerMinute"], 56)
        self.assertEqual(r["daily_averageStressLevel"], 29)
        self.assertEqual((r["bb_charged"], r["bb_max"]), (30, 48))

    def test_unmeasurable_counts_as_sleep(self):
        rec = dict(SLEEP, sleepTimeSeconds=26488, unmeasurableSleepSeconds=780)
        rows = G.build_rows(date(2026, 11, 3), date(2026, 11, 3), [rec], [], [])
        self.assertEqual(round(rows["2026-11-03"]["sleep_durationInSeconds"] / 3600, 2), 7.57)


class Helpers(unittest.TestCase):
    def test_chunks_cover_range_without_overlap(self):
        cs = list(G.chunks(date(2026, 1, 1), date(2026, 3, 1)))
        self.assertEqual(cs[0], (date(2026, 1, 1), date(2026, 1, 28)))
        self.assertEqual(cs[-1][1], date(2026, 3, 1))
        self.assertTrue(all((b - a).days < G.CHUNK_DAYS for a, b in cs))

    def test_jwt_exp(self):
        payload = base64.urlsafe_b64encode(json.dumps({"exp": 1793772933}).encode()).decode().rstrip("=")
        self.assertEqual(G.jwt_exp(f"h.{payload}.s"), 1793772933)
        self.assertEqual(G.jwt_exp("not-a-jwt"), 0)


if __name__ == "__main__":
    unittest.main()
