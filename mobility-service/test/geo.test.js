const test = require("node:test");
const assert = require("node:assert/strict");
const { distanceMeters } = require("../src/services/geo");

test("distance is zero for the same coordinate", () => {
  assert.equal(distanceMeters({ latitude: 51.5, longitude: -0.1 }, { latitude: 51.5, longitude: -0.1 }), 0);
});

test("distance is symmetric and non-negative", () => {
  const a = { latitude: 21.1702, longitude: 72.8311 };
  const b = { latitude: 21.1458, longitude: 79.0882 };
  assert.ok(distanceMeters(a, b) > 0);
  assert.ok(Math.abs(distanceMeters(a, b) - distanceMeters(b, a)) < 0.001);
});

test("distance is measured in metres at city scale", () => {
  const a = { latitude: 0, longitude: 0 };
  const b = { latitude: 0, longitude: 0.01 };
  const distance = distanceMeters(a, b);
  assert.ok(distance > 1100 && distance < 1125, "expected approximately 1.11 km");
});
