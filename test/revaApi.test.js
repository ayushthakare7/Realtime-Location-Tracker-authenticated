const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiClient } = require("../src/public/js/reva-api");

test("shared API client preserves caller headers and adds bearer auth", async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const api = createApiClient("/api/tracker/", "token-123");
    const result = await api("/friends", { method: "POST", headers: { "X-Test": "yes" }, body: "{}" });
    assert.deepEqual(result, { success: true });
    assert.equal(captured.url, "/api/tracker/friends");
    assert.equal(captured.options.headers.Authorization, "Bearer token-123");
    assert.equal(captured.options.headers["X-Test"], "yes");
  } finally {
    global.fetch = originalFetch;
  }
});

test("shared API client reports server-provided errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({ message: "Not allowed" }) });
  try {
    const api = createApiClient("/api/mobility", "token", "Mobility failed");
    await assert.rejects(api("/trips"), /Not allowed/);
  } finally {
    global.fetch = originalFetch;
  }
});
