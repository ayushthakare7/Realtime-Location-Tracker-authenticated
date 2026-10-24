const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateRemainingDistanceMeters, decodePolyline } = require("../src/services/routeProgress.service");

const SAMPLE_ROUTE = "_p~iF~ps|U_ulLnnqC_mqNvxq" + String.fromCharCode(96) + "@";

test("decodes a Google encoded polyline", () => {
  const points = decodePolyline(SAMPLE_ROUTE);
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0].latitude - 38.5) < 0.00001);
  assert.ok(Math.abs(points[0].longitude + 120.2) < 0.00001);
});

test("remaining distance decreases along the route", () => {
  const points = decodePolyline(SAMPLE_ROUTE);
  const atStart = calculateRemainingDistanceMeters(SAMPLE_ROUTE, points[0].latitude, points[0].longitude);
  const atEnd = calculateRemainingDistanceMeters(SAMPLE_ROUTE, points[2].latitude, points[2].longitude);
  assert.ok(atStart > atEnd);
  assert.equal(atEnd, 0);
});

test("returns null when there is no usable route or coordinate", () => {
  assert.equal(calculateRemainingDistanceMeters("", 10, 10), null);
  assert.equal(calculateRemainingDistanceMeters(SAMPLE_ROUTE, NaN, 10), null);
});
