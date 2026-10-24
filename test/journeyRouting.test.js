const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDurationSeconds, supportedTravelMode, convertPolyline6To5, decodePolyline, encodePolyline } = require("../src/services/journeyRouting.service");

test("parses route duration in seconds without guessing invalid values", () => {
  assert.equal(parseDurationSeconds(123), 123);
  assert.equal(parseDurationSeconds(1.5), 2);
  assert.equal(parseDurationSeconds(-1), null);
  assert.equal(parseDurationSeconds("unknown"), null);
});

test("only enables travel modes that have a truthful free route mapping", () => {
  assert.equal(supportedTravelMode("walking"), true);
  assert.equal(supportedTravelMode("bicycle"), true);
  assert.equal(supportedTravelMode("motorcycle"), true);
  assert.equal(supportedTravelMode("car"), true);
  assert.equal(supportedTravelMode("train"), false);
  assert.equal(supportedTravelMode("airplane"), false);
  assert.equal(supportedTravelMode("boat"), false);
});

test("encodes and decodes a route polyline at the standard precision", () => {
  const points = [
    { latitude: 21.1904, longitude: 81.2849 },
    { latitude: 21.1912, longitude: 81.2861 },
    { latitude: 21.1930, longitude: 81.2880 }
  ];
  const decoded = decodePolyline(encodePolyline(points, 5), 5);
  assert.equal(decoded.length, points.length);
  assert.ok(Math.abs(decoded[1].latitude - points[1].latitude) < 0.00001);
  assert.ok(Math.abs(decoded[1].longitude - points[1].longitude) < 0.00001);
});

test("converts Valhalla precision-6 geometry to the route progress precision-5 format", () => {
  const points = [
    { latitude: 21.190401, longitude: 81.284901 },
    { latitude: 21.191202, longitude: 81.286103 },
    { latitude: 21.193004, longitude: 81.288005 }
  ];
  const converted = convertPolyline6To5(encodePolyline(points, 6));
  const decoded = decodePolyline(converted, 5);
  assert.equal(decoded.length, points.length);
  assert.ok(Math.abs(decoded[0].latitude - points[0].latitude) < 0.00001);
  assert.ok(Math.abs(decoded[2].longitude - points[2].longitude) < 0.00001);
});
