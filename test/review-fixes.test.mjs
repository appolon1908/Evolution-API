import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";

const FAKE = "test-secret-value-not-real";

// --- R1 nit 1: redaction fails closed past the depth limit -------------------

function nest(levels, leaf) {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = { child: v };
  return v;
}

test("redaction: an apikey nested 40 levels deep is not returned in clear", () => {
  const out = redactSecrets(nest(40, { apikey: FAKE }));
  assert.ok(!JSON.stringify(out).includes(FAKE));
  assert.ok(JSON.stringify(out).includes(REDACTED));
});

test("redaction: an over-deep array is cut, not returned in clear", () => {
  let v = [{ token: FAKE }];
  for (let i = 0; i < 40; i++) v = [v];
  assert.ok(!JSON.stringify(redactSecrets(v)).includes(FAKE));
});

test("redaction: shallow structure is unchanged by the depth cap", () => {
  const out = redactSecrets(nest(5, { status: "READ" }));
  assert.equal(out.child.child.child.child.child.status, "READ");
});
