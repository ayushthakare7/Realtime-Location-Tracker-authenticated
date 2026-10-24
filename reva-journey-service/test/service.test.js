const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");
const { authenticate } = require("../auth");
const jwt = require("jsonwebtoken");

test("health endpoint identifies the independent journey service", async () => {
  const server = app.listen(0);
  try {
    const address = server.address();
    const response = await fetch("http://127.0.0.1:" + address.port + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, service: "reva-journey-service", status: "ok" });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("journey authentication rejects missing bearer tokens", () => {
  const req = { get: () => undefined };
  let statusCode = 0, payload;
  const res = { status(code) { statusCode = code; return this; }, json(body) { payload = body; return this; } };
  let nextCalled = false;
  authenticate(req, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(payload.success, false);
  assert.equal(nextCalled, false);
});

test("journey authentication extracts the identity from a signed Reva JWT", () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-tests";
  try {
    const token = jwt.sign({ userId: "user-123", username: "traveller" }, process.env.JWT_SECRET);
    const req = { get: () => "Bearer " + token };
    const res = { status(code) { throw new Error("Unexpected status " + code); }, json(body) { throw new Error(JSON.stringify(body)); } };
    let nextCalled = false;
    authenticate(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(req.authUser, { id: "user-123", username: "traveller" });
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});
