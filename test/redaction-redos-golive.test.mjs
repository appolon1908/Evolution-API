import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "../src/webhooks.mjs";

// R1 go-live review: e4b0b24's JWT lookbehind (which lets "_" start a match
// while "_" is also in the scanned class) and its Basic/Token whole-string
// rules were quadratic. All value rules must be linear on third-party text.

const K64 = 64 * 1024;
const LIMIT_MS = 50;

function fastest(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
}

const pathological = {
  "_eyJ repeated (64 KiB)": "_eyJ".repeat(K64 / 4),
  "_eyJ repeated + dots (64 KiB)": "_eyJ".repeat(K64 / 8) + ".".repeat(K64 / 2),
  ".eyJ repeated (64 KiB)": ".eyJ".repeat(K64 / 4),
  "eyJaa. repeated (64 KiB)": "eyJaa.".repeat(Math.floor(K64 / 6)),
  "_eyJaa.bb repeated (64 KiB)": "_eyJaa.bb".repeat(Math.floor(K64 / 9)),
  "Token + 64K spaces + !": "Token" + " ".repeat(K64) + "!",
  "Token + 8000 spaces + !": "Token" + " ".repeat(8000) + "!",
  "Basic + 64K spaces + !": "Basic" + " ".repeat(K64) + "!",
  "Basic + 8000 spaces + !": "Basic" + " ".repeat(8000) + "!",
  "Basic + 8000 tabs + !": "Basic" + "\t".repeat(8000) + "!",
  "Basic: + 8000 spaces + !": "Basic:" + " ".repeat(8000) + "!",
  "Basic + 8000 base64 + !": "Basic " + "A".repeat(8000) + "!"
};

for (const [name, value] of Object.entries(pathological)) {
  test(`redaction is linear: ${name} under ${LIMIT_MS} ms`, () => {
    const ms = fastest(() => redactSecrets({ text: value }));
    assert.ok(ms < LIMIT_MS, `${name}: ${ms.toFixed(1)} ms`);
  });
}

// Synthetic shapes; not real tokens.
const JWS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LW5vdC1yZWFsIn0.c2lnbmF0dXJlLW5vdC1yZWFs";
const JWE = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYtbm90LXJlYWw.Y2lwaGVydGV4dC1ub3QtcmVhbA.dGFnLW5vdC1yZWFs";

test("linear JWT scan: same detections as before", () => {
  const redacted = [
    JWS, JWE, `token=${JWS}&x=1`, `Bearer: ${JWS}`, `see ${JWS} here`, `x_${JWS}`, `a.${JWS}`, `cookie-ish ${JWE}`,
    `_eyJ_${JWS}`, "eyJab.cd.", "eyJab..cd.ef.", `("${JWS}")`
  ];
  for (const v of redacted) assert.equal(redactSecrets({ v }).v, REDACTED, v);
});

test("linear JWT scan: non-JWT strings are kept as before", () => {
  const kept = [
    "honeyJar.abcdef.ghijkl", "keyJustify.aa.bb", "x-eyJab.cd.ef", "9eyJab.cd.ef", "eyJa.cd.ef", "eyJab.c.ef", "eyJab",
    "eyJab..c.ef.", "eyJab.cd", "wamid.HBgLMTU1NTAwMDAwMDAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA", "s.whatsapp.net", "1.2.3", "a.b.c"
  ];
  for (const v of kept) assert.equal(redactSecrets({ v }).v, v, v);
});

test("anchored Basic rule: still redacts user:pass credentials, keeps text", () => {
  const basic = Buffer.from("test-user:test-pass-not-real").toString("base64");
  for (const v of [`Basic ${basic}`, `basic ${basic}`, `Basic: ${basic}`, `Basic:${basic}`, `  Basic ${basic}  `, `Basic\t${basic}`, "Basic dXNlcjpwYXNz"]) {
    assert.equal(redactSecrets({ v }).v, REDACTED, v);
  }
  for (const v of ["Basic plan", "Basic shipping", "Basic", "Basic auth is not supported", `Basic ${basic} extra`]) {
    assert.equal(redactSecrets({ v }).v, v, v);
  }
});
