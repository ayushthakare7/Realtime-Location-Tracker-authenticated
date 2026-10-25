import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rag_service"))
from time_queries import _distance_m, _requested_clock


class TimeQueryTests(unittest.TestCase):
    def test_parses_explicit_am_time_and_yesterday(self):
        now = datetime(2026, 10, 25, 11, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
        parsed = _requested_clock("Where was I at 1 AM yesterday?", now)
        self.assertEqual(parsed.strftime("%Y-%m-%d %H:%M"), "2026-10-24 01:00")

    def test_parses_minutes_and_pm(self):
        now = datetime(2026, 10, 25, 22, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
        parsed = _requested_clock("Where was I around 8:30 PM today?", now)
        self.assertEqual(parsed.strftime("%Y-%m-%d %H:%M"), "2026-10-25 20:30")

    def test_unqualified_future_time_means_most_recent_occurrence(self):
        now = datetime(2026, 10, 25, 0, 30, tzinfo=ZoneInfo("Asia/Kolkata"))
        parsed = _requested_clock("Where was I at 1 AM?", now)
        self.assertEqual(parsed.strftime("%Y-%m-%d %H:%M"), "2026-10-24 01:00")

    def test_haversine_distance_is_zero_for_same_point(self):
        self.assertAlmostEqual(_distance_m(21.2, 81.4, 21.2, 81.4), 0.0, places=6)


if __name__ == "__main__":
    unittest.main()
