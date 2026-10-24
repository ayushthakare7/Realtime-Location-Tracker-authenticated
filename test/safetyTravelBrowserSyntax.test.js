const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("browser Safety Travel scripts parse as valid JavaScript", () => {
  for (const file of ["src/public/js/safety-travel.js", "src/public/js/journey-offline-queue.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file + " should parse");
  }
});
