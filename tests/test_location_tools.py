import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rag_service"))
import location_tools


class LocationToolTests(unittest.TestCase):
    def setUp(self):
        with location_tools._MEMORY_LOCK:
            location_tools._MEMORY_CACHE.clear()

    def test_rejects_invalid_coordinates_without_network(self):
        with patch.object(location_tools, "_nominatim_get") as provider:
            result = location_tools.reverse_geocode(999, 181)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid_coordinates")
        provider.assert_not_called()

    def test_reverse_geocode_uses_free_nominatim_and_normalizes_region(self):
        response = {
            "name": "Test locality",
            "address": {
                "suburb": "Test locality",
                "city": "Example City",
                "state": "Example State",
                "country": "Example Country",
            },
        }
        with patch.object(location_tools, "_nominatim_get", return_value=response) as provider:
            result = location_tools.reverse_geocode(21.2345, 81.4567)
        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "nominatim")
        self.assertEqual(result["city"], "Example City")
        self.assertEqual(result["state"], "Example State")
        self.assertEqual(result["country"], "Example Country")
        provider.assert_called_once()

    def test_reverse_geocode_falls_back_when_nominatim_fails(self):
        fallback = {
            "city": "Fallback City",
            "locality": "Fallback Locality",
            "principalSubdivision": "Fallback State",
            "countryName": "Fallback Country",
            "localityInfo": {"administrative": []},
        }
        with patch.object(location_tools, "_nominatim_get", side_effect=TimeoutError()), \
             patch.object(location_tools, "_http_json", return_value=fallback):
            result = location_tools.reverse_geocode(12.3456, 67.8901)
        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "bigdatacloud")
        self.assertEqual(result["country"], "Fallback Country")

    def test_forward_geocode_handles_nominatim_list_payload(self):
        response = [{
            "name": "Nagpur",
            "address": {"city": "Nagpur", "state": "Maharashtra", "country": "India"},
        }]
        with patch.object(location_tools, "_nominatim_get", return_value=response):
            result = location_tools.forward_geocode("Nagpur, India")
        self.assertTrue(result["ok"])
        self.assertEqual(result["city"], "Nagpur")
        self.assertEqual(result["state"], "Maharashtra")
        self.assertEqual(result["country"], "India")

    def test_personal_location_routes_only_to_matching_authorized_person(self):
        context = {
            "currentLocations": [
                {"username": "you", "latitude": 21.2, "longitude": 81.3},
                {"username": "Siddhant", "latitude": 21.3, "longitude": 81.4},
            ]
        }
        self.assertEqual(location_tools.location_tool_route("Where is Siddhant right now?", context), "reverse_geocode")
        self.assertEqual(location_tools.location_tool_route("Where am I currently?", context), "reverse_geocode")


    def test_resolver_returns_only_the_named_friend(self):
        context = {
            "currentLocations": [
                {"username": "you", "latitude": 21.2, "longitude": 81.3, "lastSeen": "now"},
                {"username": "Siddhant", "latitude": 21.3, "longitude": 81.4, "lastSeen": "now"},
            ]
        }
        with patch.object(location_tools, "reverse_geocode", return_value={
            "ok": True, "label": "Nagpur, Maharashtra, India", "locality": "Nagpur",
            "city": "Nagpur", "state": "Maharashtra", "country": "India", "source": "nominatim",
        }) as provider:
            result = location_tools.resolve_location_tools("What city is Siddhant in?", context)
        self.assertEqual(result["route"], "reverse_geocode")
        self.assertEqual([row["person"] for row in result["results"]], ["Siddhant"])
        provider.assert_called_once()

    def test_missing_friend_coordinates_are_not_forward_geocoded_as_a_place(self):
        context = {"currentLocations": [{"username": "Siddhant", "latitude": None, "longitude": None}]}
        self.assertEqual(location_tools.location_tool_route("Where is Siddhant right now?", context), "none")

    def test_reverse_geocode_extracts_road_and_locality(self):
        result = location_tools._clean_address({
            "road": "Knowledge Park Road",
            "neighbourhood": "Knowledge Park",
            "city": "Bhilai",
            "state": "Chhattisgarh",
            "country": "India",
        })
        self.assertEqual(result["road"], "Knowledge Park Road")
        self.assertEqual(result["locality"], "Knowledge Park")
        self.assertEqual(result["city"], "Bhilai")
        self.assertEqual(result["state"], "Chhattisgarh")
        self.assertEqual(result["country"], "India")

    def test_self_road_question_routes_to_reverse_geocoder(self):
        context = {"currentLocations": [{"username": "you", "latitude": 21.2, "longitude": 81.3}]}
        self.assertEqual(location_tools.location_tool_route("What road am I near?", context), "reverse_geocode")

    def test_public_place_question_uses_forward_geocoder(self):
        context = {"currentLocations": [{"username": "you", "latitude": 21.2, "longitude": 81.3}]}
        self.assertEqual(location_tools.location_tool_route("Where is Nagpur?", context), "forward_geocode")


if __name__ == "__main__":
    unittest.main()
