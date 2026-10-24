const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDurationSeconds, supportedTravelMode } = require("../src/services/journeyRouting.service");

test("parses provider durations without guessing invalid formats", () => {
  assert.equal(parseDurationSeconds("123s"), 123);
  assert.equal(parseDurationSeconds("1.5s"), 2);
  assert.equal(parseDurationSeconds(""), null);
  assert.equal(parseDurationSeconds("2m"), null);
});

test("only enables route profiles backed by the configured Google Routes mapping", () => {
  assert.equal(supportedTravelMode("walking"), true);
  assert.equal(supportedTravelMode("bicycle"), true);
  assert.equal(supportedTravelMode("motorcycle"), true);
  assert.equal(supportedTravelMode("train"), true);
  assert.equal(supportedTravelMode("airplane"), false);
  assert.equal(supportedTravelMode("boat"), false);
});
