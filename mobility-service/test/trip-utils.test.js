const test = require("node:test");
const assert = require("node:assert/strict");
const { validCoordinate, cleanTrip } = require("../src/utils/trips");

test("validCoordinate accepts legal coordinate boundaries and numeric strings", () => {
  assert.equal(validCoordinate({ latitude: -90, longitude: 180 }), true);
  assert.equal(validCoordinate({ latitude: 90, longitude: -180 }), true);
  assert.equal(validCoordinate({ latitude: "21.2", longitude: "79.1" }), true);
});

test("validCoordinate rejects missing, non-numeric, and out-of-range values", () => {
  assert.equal(validCoordinate(null), false);
  assert.equal(validCoordinate({ latitude: 91, longitude: 0 }), false);
  assert.equal(validCoordinate({ latitude: 0, longitude: -181 }), false);
  assert.equal(validCoordinate({ latitude: "north", longitude: 0 }), false);
});

test("cleanTrip serializes identifiers and recipient IDs predictably", () => {
  const trip = cleanTrip({ _id: "trip-id", userId: "user-id", recipients: [123], status: "ACTIVE", transportMode: "driving-car" });
  assert.equal(trip.id, "trip-id");
  assert.equal(trip.travellerId, "user-id");
  assert.deepEqual(trip.recipients, ["123"]);
  assert.equal(trip.status, "ACTIVE");
  assert.equal(cleanTrip(null), null);
});
