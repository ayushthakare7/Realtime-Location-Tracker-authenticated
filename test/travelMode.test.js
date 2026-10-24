const test = require("node:test");
const assert = require("node:assert/strict");
const { getTravelModeById, listTravelModes, resolveTravelMode } = require("../src/services/travelMode.service");

test("explicit walking language resolves to walking avatar", () => {
  const result = resolveTravelMode("I am walking to home");
  assert.equal(result.status, "resolved");
  assert.equal(result.mode.id, "walking");
  assert.equal(result.mode.avatarKey, "walking");
});

test("explicit bicycle selection maps to bicycle asset, never a generic cycle asset", () => {
  const result = resolveTravelMode("", "bicycle");
  assert.equal(result.status, "resolved");
  assert.equal(result.mode.id, "bicycle");
  assert.equal(result.mode.avatarKey, "bicycle");
  assert.notEqual(result.mode.avatarKey, "cycle");
});

test("ambiguous bike wording asks bicycle or motorcycle", () => {
  const result = resolveTravelMode("I am going by bike");
  assert.equal(result.status, "clarification_required");
  assert.deepEqual(result.options.map(option => option.id), ["bicycle", "motorcycle"]);
});

test("explicit motorcycle wording maps to motorcycle avatar", () => {
  const result = resolveTravelMode("I am riding my motorcycle");
  assert.equal(result.status, "resolved");
  assert.equal(result.mode.id, "motorcycle");
  assert.equal(result.mode.avatarKey, "motorcycle");
});

test("explicit vehicle selection overrides phrase ambiguity", () => {
  const result = resolveTravelMode("I am going by bike", "bicycle");
  assert.equal(result.status, "resolved");
  assert.equal(result.source, "user_selection");
  assert.equal(result.mode.avatarKey, "bicycle");
});

test("unknown selected mode is rejected rather than silently remapped", () => {
  assert.equal(resolveTravelMode("", "cycle").status, "invalid_selection");
});

test("catalogue has unique IDs and exact avatar keys", () => {
  const modes = listTravelModes();
  assert.ok(modes.length >= 20);
  assert.equal(new Set(modes.map(mode => mode.id)).size, modes.length);
  for (const mode of modes) assert.equal(mode.avatarKey, mode.id);
  assert.equal(getTravelModeById("bicycle").iconKey, "bicycle");
});
