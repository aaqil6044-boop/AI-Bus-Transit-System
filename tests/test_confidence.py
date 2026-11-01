"""Journey Confidence: honest transfer-risk explanations."""
import unittest

from transit import confidence


def bus(name, wait=0, delay=None, stop="Interchange"):
    leg = {"transit": True, "role": "bus", "route_name": name,
           "wait_before_minutes": wait, "from": {"name": stop}}
    if delay is not None:
        leg["reliability"] = {"typical_delay_minutes": delay, "text": "measured"}
    return leg


class JourneyConfidenceTests(unittest.TestCase):
    def test_direct_service_has_no_connection_to_miss(self):
        result = confidence.assess({"legs": [bus("500-D")]})
        self.assertEqual((result["level"], result["score"]), ("high", 96))
        self.assertEqual(result["transfers"], [])

    def test_short_scheduled_connection_is_at_risk(self):
        route = {"legs": [bus("500-D"), bus("KBS-1K", 2, stop="Majestic")]}
        confidence.annotate([route])
        found = route["journey_confidence"]
        self.assertEqual(found["level"], "low")
        self.assertEqual(found["transfers"][0]["status"], "risky")
        self.assertEqual(route["legs"][1]["connection"]["stop"], "Majestic")

    def test_learned_lateness_reduces_the_usable_buffer(self):
        route = {"legs": [bus("500-D", delay=8), bus("KBS-1K", 10, stop="KBS")]}
        found = confidence.assess(route)
        transfer = found["transfers"][0]
        self.assertEqual(transfer["effective_buffer_minutes"], 2)
        self.assertEqual((transfer["status"], found["level"]), ("risky", "low"))
        self.assertTrue(transfer["has_reliability_evidence"])

    def test_early_running_is_not_used_as_false_extra_delay(self):
        found = confidence.assess({"legs": [bus("A", delay=-5), bus("B", 8)]})
        self.assertEqual(found["transfers"][0]["effective_buffer_minutes"], 8)
        self.assertEqual(found["level"], "high")

    def test_walk_only_has_no_transit_confidence_claim(self):
        self.assertIsNone(confidence.assess({"legs": [{"transit": False}]}))


if __name__ == "__main__":
    unittest.main()
