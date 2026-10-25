const test = require("node:test");
const assert = require("node:assert/strict");
const { distanceMeters } = require("../src/services/geo");
const { routeBetween } = require("../src/services/routing");

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

test("routing fails explicitly when no free-tier API key is configured", async () => {
  const oldKey = process.env.ORS_API_KEY;
  delete process.env.ORS_API_KEY;
  try {
    await assert.rejects(
      routeBetween({ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }, "driving-car"),
      error => error.status === 503 && /not configured/i.test(error.message)
    );
  } finally {
    if (oldKey === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = oldKey;
  }
});
