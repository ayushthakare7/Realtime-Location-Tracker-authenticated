const test = require("node:test");
const assert = require("node:assert/strict");
const { validateJourneyDraft } = require("../src/services/safetyJourney.service");

test("requires origin and destination labels", () => {
  assert.match(validateJourneyDraft({ destinationText: "Home" }).error, /originText/);
  assert.match(validateJourneyDraft({ originText: "Here" }).error, /destinationText/);
});

test("validates grace period range", () => {
  assert.match(validateJourneyDraft({ originText: "Here", destinationText: "Home", gracePeriodMinutes: -1 }).error, /gracePeriodMinutes/);
  assert.match(validateJourneyDraft({ originText: "Here", destinationText: "Home", gracePeriodMinutes: 181 }).error, /gracePeriodMinutes/);
});

test("natural language walking gets the walking avatar", () => {
  const result = validateJourneyDraft({ originText: "Here", destinationText: "Home", travelModeText: "I am walking" });
  assert.equal(result.modeResult.status, "resolved");
  assert.equal(result.modeResult.mode.id, "walking");
  assert.equal(result.modeResult.mode.avatarKey, "walking");
});

test("a selected bicycle gets a bicycle avatar", () => {
  const result = validateJourneyDraft({ originText: "Here", destinationText: "Home", transportModeId: "bicycle" });
  assert.equal(result.modeResult.status, "resolved");
  assert.equal(result.modeResult.mode.avatarKey, "bicycle");
});

test("ambiguous bike requests clarification instead of wrong avatar", () => {
  const result = validateJourneyDraft({ originText: "Here", destinationText: "Home", travelModeText: "I am going by bike" });
  assert.equal(result.modeResult.status, "clarification_required");
  assert.deepEqual(result.modeResult.options.map(option => option.id), ["bicycle", "motorcycle"]);
});

test("does not accept unknown travel mode IDs", () => {
  const result = validateJourneyDraft({ originText: "Here", destinationText: "Home", transportModeId: "cycle" });
  assert.equal(result.modeResult.status, "invalid_selection");
});
