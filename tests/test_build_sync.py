"""The page warns when it talks to an older server; that only works if both build labels match."""
import re
import unittest
from pathlib import Path

import app as app_module


class BuildLabelTests(unittest.TestCase):
    def test_page_and_server_build_labels_match(self):
        script = (Path(app_module.__file__).parent / "static" / "app.js").read_text(encoding="utf-8")
        match = re.search(r'const APP_BUILD = "([^"]+)"', script)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), app_module.BUILD, "bump BUILD in app.py and APP_BUILD in app.js together")


if __name__ == "__main__":
    unittest.main()
