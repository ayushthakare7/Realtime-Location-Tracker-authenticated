const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLocationPlan } = require("../src/services/gemini.service");

test("normalizes a self-to-place distance plan", () => {
  const plan = normalizeLocationPlan({
    intent: "distance",
    origin: "me",
    originPerson: null,
    originPlace: null,
    destination: "Nagpur",
    destinationType: "place"
  });
  assert.equal(plan.originType, "person");
  assert.equal(plan.destination, "Nagpur");
});

test("normalizes a friend-to-place distance plan", () => {
  const plan = normalizeLocationPlan({
    intent: "distance",
    origin: "friend",
    originPerson: "Siddhant",
    destination: "Raipur",
    destinationType: "place"
  });
  assert.equal(plan.originType, "person");
  assert.equal(plan.originPerson, "Siddhant");
});

test("normalizes a place-to-place distance plan", () => {
  const plan = normalizeLocationPlan({
    intent: "distance",
    origin: "place",
    originPlace: "Nagpur",
    destination: "Raipur",
    destinationType: "place"
  });
  assert.equal(plan.originType, "place");
  assert.equal(plan.originPlace, "Nagpur");
});

test("requires two places for a place comparison", () => {
  assert.throws(() => normalizeLocationPlan({
    intent: "compare_places",
    targetType: "me",
    target: "me",
    places: ["Nagpur"]
  }), /comparison endpoints/);
});

test("rejects a distance plan without a destination", () => {
  assert.throws(() => normalizeLocationPlan({
    intent: "distance",
    origin: "me",
    destination: null,
    destinationType: "place"
  }), /distance destination/);
});
