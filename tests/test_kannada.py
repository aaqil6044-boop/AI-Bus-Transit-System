"""Kannada: BMTC's official Kannada stop names, Kannada commands for the built-in helper."""
import csv
import io
import os
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from test_backend import make_database          # noqa: E402
from transit import assistant, kannada          # noqa: E402


def gtfs_with_translations(path, rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["table_name", "field_name", "record_id", "language", "translation"])
    writer.writerows(["stops", "stop_name", stop_id, "kn", name] for stop_id, name in rows)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("translations.txt", buffer.getvalue())


class KannadaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = Path(make_database([
            ("1", "Hope Farm", 12.984, 77.752), ("2", "Kempegowda Bus Station", 12.977, 77.571),
            ("3", "Hebbala", 13.039, 77.589), ("4", "Jayanagara 4th Block", 12.925, 77.583),
            ("5", "Jayanagara Bus Station", 12.926, 77.584), ("6", "Jayanagara 9th Block", 12.920, 77.590),
            ("7", "KR Market", 12.965, 77.577)]))
        cls.zip = Path(tempfile.mkdtemp()) / "g.zip"
        gtfs_with_translations(cls.zip, [
            ("1", "ಹೋಪ್‌ ಫಾರ್ಮ್ (ಟುವರ್ಡ್ಸ್  ಹೊಸಕೋಟೆ)"), ("2", "ಕೆಂಪೇಗೌಡ ಬಸ್ ನಿಲ್ದಾಣ (ಟುವರ್ಡ್ಸ್  ಆಗಮನ)"),
            ("3", "ಹೆಬ್ಬಾಳ (ಟುವರ್ಡ್ಸ್  ಯಲಹಂಕ)"), ("4", "ಜಯನಗರ 4ನೇ ಬ್ಲಾಕ್ (ಟುವರ್ಡ್ಸ್  ಸಂಜಯ್ ಗಾಂಧಿ ಆಸ್ಪತ್ರೆ)"),
            ("5", "ಜಯನಗರ ಬಸ್ ನಿಲ್ದಾಣ (ಟುವರ್ಡ್ಸ್  ಆಗಮನ)"), ("6", "ಜಯನಗರ 9ನೇ ಬ್ಲಾಕ್"),
            ("7", "ಕೆ ಆರ್‌ ಮಾರುಕಟ್ಟೆ (ಟುವರ್ಡ್ಸ್  ಕಾರ್ಪೋರೇಷನ್)")])
        assert kannada.ensure_table(cls.db, cls.zip)

    def command(self, text):
        return kannada.to_command(self.db, text)

    def test_names_come_from_bmtc_without_the_towards_note(self):
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT name_kn FROM stop_names_kn WHERE stop_id='3'").fetchone()[0], "ಹೆಬ್ಬಾಳ")
        self.assertTrue(kannada.ensure_table(self.db, self.zip), "running again is harmless")
        self.assertFalse(kannada.ensure_table(Path(tempfile.mkdtemp()) / "none.db", self.zip))
        self.assertEqual(kannada.kannada_names(self.db)["Hope Farm"], "ಹೋಪ್‌ ಫಾರ್ಮ್")

    def test_stop_names_tolerate_spacing_and_small_spelling_differences(self):
        self.assertEqual(kannada.find_stop_name(self.db, "ಹೋಪ್ ಫಾರ್ಮ್"), "Hope Farm")     # no ZWNJ
        self.assertEqual(kannada.find_stop_name(self.db, "ಕೆಆರ್ ಮಾರುಕಟ್ಟೆ"), "KR Market")  # no space
        self.assertEqual(kannada.find_stop_name(self.db, "ಹೆಬ್ಬಾಲ"), "Hebbala")            # one letter off
        self.assertEqual(kannada.find_stop_name(self.db, "ಜಯನಗರ"), "Jayanagara", "a shared prefix -> the area name")
        self.assertEqual(kannada.find_stop_name(self.db, "ಮೆಜೆಸ್ಟಿಕ್"), "Majestic")
        self.assertIsNone(kannada.find_stop_name(self.db, "ಅಟ್ಲಾಂಟಿಸ್"), "no BMTC name: nothing is guessed")

    def test_commands(self):
        self.assertEqual(self.command("ಹೆಬ್ಬಾಳದಿಂದ ಮೆಜೆಸ್ಟಿಕ್‌ಗೆ"), "from Hebbala to Majestic")
        self.assertEqual(self.command("ಹೋಪ್ ಫಾರ್ಮ್ ಇಂದ ಕೆ ಆರ್ ಮಾರುಕಟ್ಟೆ ಗೆ ಕಡಿಮೆ ನಡಿಗೆ"), "from Hope Farm to KR Market, less walking")
        self.assertEqual(self.command("ಇಲ್ಲಿಂದ ಹೆಬ್ಬಾಳಕ್ಕೆ ಹೇಗೆ ಹೋಗುವುದು"), "from here to Hebbala")
        self.assertEqual(self.command("ಸಂಜೆ ೬ ಗಂಟೆಗೆ ಮನೆಗೆ"), "to home, leave at 6:00 pm")
        self.assertEqual(self.command("ಬೆಳಿಗ್ಗೆ 9:30 ಕ್ಕೆ ಹೆಬ್ಬಾಳದಿಂದ ಜಯನಗರಕ್ಕೆ ನೇರ ಬಸ್"),
                         "from Hebbala to Jayanagara, fewer transfers, leave at 9:30 am")
        self.assertEqual(self.command("೫೦೦-ಡಿ ಬಸ್ ಎಲ್ಲಿದೆ"), "where is the bus 500D")
        self.assertEqual(self.command("ವಿ-೫೦೦ಡಿ ತಡವಾಗಿ ಬರುತ್ತದೆಯೇ"), "is V-500D usually late")
        self.assertEqual(self.command("ನಮಸ್ಕಾರ"), "hello")
        self.assertEqual(self.command("ವಾಪಸ್"), "swap")
        self.assertEqual(self.command("Hope Farm ಇಂದ Majestic ಗೆ"), "from Hope Farm to Majestic")
        self.assertEqual(self.command("from Hope Farm to Majestic"), "from Hope Farm to Majestic", "English untouched")

    def test_parser_reads_the_converted_commands(self):
        parsed = assistant.parse_command(self.command("ಸಂಜೆ 6 ಗಂಟೆಗೆ ಹೆಬ್ಬಾಳದಿಂದ ಕೆ ಆರ್ ಮಾರುಕಟ್ಟೆಗೆ ಕಡಿಮೆ ನಡಿಗೆ"))
        self.assertEqual((parsed["origin"], parsed["destination"], parsed["preference"], parsed["depart_at"]),
                         ("Hebbala", "KR Market", "less_walking", "18:00"))

    def test_kannada_message_plans_and_answers_in_kannada(self):
        captured = {}

        def fake_plan(db, origin_id, destination_id, profile, origin_point=None, destination_point=None, now=None):
            captured.update(origin_id=origin_id, destination_id=destination_id)
            return {"origin": {"stop_name": "Hebbala"}, "destination": {"stop_name": "Kempegowda Bus Station"},
                    "routes": [], "requested": {"label": "Now"}, "fallback": {"message": "none"}}
        with patch.object(assistant, "plan_journey", fake_plan):
            result = assistant.handle_assistant(self.db, {"message": "ಹೆಬ್ಬಾಳದಿಂದ ಮೆಜೆಸ್ಟಿಕ್‌ಗೆ"})
        self.assertEqual(result["intent"], "plan")
        self.assertEqual((captured["origin_id"], captured["destination_id"]), ("3", "2"))
        greeting = assistant.handle_assistant(self.db, {"message": "ನಮಸ್ಕಾರ"})
        self.assertTrue(kannada.has_kannada(greeting["reply"]), "a Kannada message gets a Kannada reply")

    def test_unknown_kannada_place_is_not_invented(self):
        result = assistant.handle_assistant(self.db, {"message": "ಅಟ್ಲಾಂಟಿಸ್ ಗೆ"})
        self.assertFalse(result.get("ok", True) and result.get("intent") == "plan")
        self.assertTrue(kannada.has_kannada(result["reply"]))


if __name__ == "__main__":
    unittest.main()
