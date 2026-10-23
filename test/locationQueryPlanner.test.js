const test = require("node:test");
const assert = require("node:assert/strict");
const { planDistanceQuestion } = require("../src/services/locationQueryPlanner.service");

test("parses friend-to-place distance questions in either wording", () => {
  assert.deepEqual(
    planDistanceQuestion("how far is Sri Lanka from user2", ["user2"]),
    {
      intent: "distance",
      origin: "friend",
      originPerson: "user2",
      originType: "person",
      destination: "Sri Lanka",
      destinationType: "place"
    }
  );
  assert.equal(
    planDistanceQuestion("how far is user2 from Nagpur", ["user2"]).destination,
    "Nagpur"
  );
});

test("parses self-to-place questions", () => {
  const plan = planDistanceQuestion("how far am I from Mumbai");
  assert.equal(plan.origin, "me");
  assert.equal(plan.destination, "Mumbai");
});

test("parses friend-to-friend distance questions", () => {
  const plan = planDistanceQuestion("how far is Siddhant from user2", ["Siddhant", "user2"]);
  assert.equal(plan.originPerson, "Siddhant");
  assert.equal(plan.destination, "user2");
  assert.equal(plan.destinationType, "person");
});

test("parses place-to-place distance questions", () => {
  const plan = planDistanceQuestion("distance between Nagpur and Durg");
  assert.equal(plan.originPlace, "Nagpur");
  assert.equal(plan.destination, "Durg");
});

test("plans which-place-is-closer comparisons", () => {
  assert.deepEqual(
    planDistanceQuestion("which is closer to me, Raipur or Durg"),
    {
      intent: "compare_places",
      targetType: "me",
      target: null,
      places: ["Raipur", "Durg"]
    }
  );
});

test("plans closest/farthest friend comparisons", () => {
  assert.deepEqual(
    planDistanceQuestion("which friend is closest to me", ["Siddhant", "user2"]),
    { intent: "nearest_person", relation: "closest", targetType: "me", target: null }
  );
  assert.deepEqual(
    planDistanceQuestion("which friend is farthest from Durg", ["Siddhant", "user2"]),
    { intent: "nearest_person", relation: "farthest", targetType: "place", target: "Durg" }
  );
});
