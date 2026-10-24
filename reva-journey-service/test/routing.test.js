const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePoint } = require("../routing");

test("route point validation accepts legal coordinates", () => {
  assert.equal(validatePoint({ latitude: 51.5, longitude: -0.12 }), true);
  assert.equal(validatePoint({ latitude: "-90", longitude: "180" }), true);
});
test("route point validation rejects missing and out-of-range coordinates", () => {
  assert.equal(validatePoint(null), null);
  assert.equal(validatePoint({ latitude: 91, longitude: 0 }), false);
  assert.equal(validatePoint({ latitude: 0, longitude: -181 }), false);
  assert.equal(validatePoint({ latitude: "NaN", longitude: 0 }), false);
});
