import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";
import { assertLinear, LIMIT_MS, TIMING_TEST_OPTIONS } from "./timing-helpers.mjs";

// R1 go-live v2 optional nit: whitespace before the colon in Bearer/Token/
// Basic values ("Bearer :abcdefgh") is redacted too, and stays linear.

const BASIC = Buffer.from("test-user:test-pass-not-real").toString("base64");

test("auth rules: whitespace before the colon is accepted", () => {
  for (const v of ["Bearer :abcdefgh", "Bearer\n:abcdefgh", "Bearer : abcdefgh", "Token  :  abcdefgh", "TOKEN\t:abcdefgh", `Basic : ${BASIC}`, `basic\n:${BASIC}`]) {
    assert.equal(redactSecrets({ v }).v, REDACTED, JSON.stringify(v));
  }
});

test("auth rules: ordinary text is still kept", () => {
  for (const v of ["Bearer :", "Bearer : x", "Token : required please", "Basic : plan", "Bearer :: abcdefgh"]) {
    assert.equal(redactSecrets({ v }).v, v, JSON.stringify(v));
  }
});

const N = 8000; // just under the 8192-character whole-string guard
for (const word of ["Bearer", "Token", "Basic"]) {
  const cases = {
    [`${word} + spaces + !`]: word + " ".repeat(N) + "!",
    [`${word} + spaces + : + !`]: word + " ".repeat(N) + ":!",
    [`${word} + spaces + : + spaces + !`]: word + " ".repeat(N / 2) + ":" + " ".repeat(N / 2) + "!",
    [`${word} + " :" repeated + !`]: word + " :".repeat(N / 2) + "!",
    [`${word} + mixed whitespace + : + !`]: word + " \t\n\r".repeat(N / 4) + ":!"
  };
  for (const [name, value] of Object.entries(cases)) {
    test(`auth rules are linear: ${name} under ${LIMIT_MS} ms`, TIMING_TEST_OPTIONS, () => assertLinear(name, "redactSecrets", { text: value }));
  }
}
