import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("provider adapter exact-source certification passes fail-closed defaults", () => {
  const result = spawnSync(process.execPath, ["scripts/certify-contract.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EVOLUTION_PROVIDER_ADAPTER_CERTIFICATION=PASS/);
  assert.match(result.stdout, /PROVIDER_EFFECTS=0/);
  assert.match(result.stdout, /MIDDLEWARE_AUTHORITY=http:\/\/middleware-integration-api:8095/);
});
