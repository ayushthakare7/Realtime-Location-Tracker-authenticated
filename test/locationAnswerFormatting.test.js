const test = require("node:test");
const assert = require("node:assert/strict");
const {
  distanceKm,
  isCurrentQuestion,
  isOwnCurrentQuestion,
  isGeoAddressQuestion,
  requestedUsername,
  isFallbackPlace,
  describeNearbyLocation
} = require("../src/services/locationAnswerFormatting.service");

test("distanceKm returns zero for identical points and plausible city distance", () => {
  assert.equal(distanceKm(21.2, 81.3, 21.2, 81.3), 0);
  const distance = distanceKm(21.1458, 79.0882, 21.2514, 81.6296);
  assert.ok(distance > 250 && distance < 300);
});

test("location question classifiers distinguish current and regional queries", () => {
  assert.equal(isCurrentQuestion("Where is Siddhant right now?"), true);
  assert.equal(isCurrentQuestion("Where was Siddhant yesterday?"), false);
  assert.equal(isOwnCurrentQuestion("Where am I currently?"), true);
  assert.equal(isGeoAddressQuestion("Which city and state am I in?"), true);
});

test("requestedUsername matches known names case-insensitively", () => {
  assert.equal(requestedUsername("How far is SIDDHANT from me?", ["Reva", "Siddhant"]), "Siddhant");
  assert.equal(requestedUsername("How far away?", ["Reva", "Siddhant"]), undefined);
});

test("fallback coordinate labels are recognized", () => {
  assert.equal(isFallbackPlace("Location near 21.123, 81.456"), true);
  assert.equal(isFallbackPlace("IIT Bhilai"), false);
});

test("nearby location description prioritizes a close institution and region hierarchy", () => {
  const result = describeNearbyLocation(
    { road: "Campus Road", locality: "Kutelabhatha", city: "Bhilai", state: "Chhattisgarh", country: "India" },
    [{ name: "IIT Bhilai", category: "university", distanceKm: 0.15 }],
    "Location near 21.2, 81.3"
  );
  assert.match(result.label, /Campus Road/);
  assert.match(result.label, /IIT Bhilai/);
  assert.match(result.label, /Bhilai/);
  assert.equal(result.landmark, "IIT Bhilai");
});
