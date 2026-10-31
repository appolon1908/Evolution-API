import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { withServer, readState, EVOLUTION_SECRET } from "./webhook-helpers.mjs";

// Per-instance Evolution webhook secrets (owner decision 2026-10-30).
// Synthetic test-only values.
const SECRET_A = "test-instance-a-secret-not-real";
const SECRET_B = "test-instance-b-secret-not-real";
const SECRETS = JSON.stringify({ "inst-a": SECRET_A, "inst-b": SECRET_B });

function update(instance, keyId, status) {
  return JSON.stringify({ event: "messages.update", instance, data: { keyId, remoteJid: "15550000000@s.whatsapp.net", fromMe: true, status, instanceId: "uuid", messageId: "db-cuid" } });
}

async function post(base, raw, secret) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-codestra-webhook-secret"] = secret;
  const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", { method: "POST", headers, body: raw });
  return { status: res.status, body: await res.json() };
}

async function readyz(base) {
  const res = await fetch(base + "/readyz");
  return { status: res.status, body: await res.json() };
}

test("instance secrets: each instance authenticates with its own secret", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: SECRETS }, async (base) => {
    assert.equal((await post(base, update("inst-a", "m-a", "DELIVERY_ACK"), SECRET_A)).status, 202);
    assert.equal((await post(base, update("inst-b", "m-b", "DELIVERY_ACK"), SECRET_B)).status, 202);
    assert.equal((await readState(base, "m-a")).body.state, "DELIVERED");
    assert.equal((await readState(base, "m-b")).body.state, "DELIVERED");
  });
});

test("instance secrets: instance A's secret cannot update instance B's message", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: SECRETS }, async (base, _state, logs) => {
    assert.equal((await post(base, update("inst-b", "m-b", "SERVER_ACK"), SECRET_B)).status, 202);
    // Claiming instance B with A's secret is rejected before any state change.
    const forged = await post(base, update("inst-b", "m-b", "READ"), SECRET_A);
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error.code, "invalid_webhook_secret");
    // Honestly naming instance A while targeting B's message is ignored by the scope check.
    const cross = await post(base, update("inst-a", "m-b", "READ"), SECRET_A);
    assert.equal(cross.status, 202);
    assert.equal(cross.body.ignored, true);
    assert.equal((await readState(base, "m-b")).body.state, "SENT");
    assert.ok(!JSON.stringify(logs).includes(SECRET_A) && !JSON.stringify(logs).includes(SECRET_B));
  });
});

test("instance secrets: an instance with no secret, a missing instance or a missing header gets 401 and changes nothing", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: SECRETS }, async (base) => {
    for (const [raw, secret] of [
      [update("inst-c", "m-c", "READ"), SECRET_A],
      [update("inst-c", "m-c", "READ"), ""],
      [JSON.stringify({ event: "messages.update", data: { keyId: "m-c", status: "READ" } }), SECRET_A],
      [update("inst-a", "m-c", "READ"), undefined],
      [update("inst-a", "m-c", "READ"), SECRET_A + "x"],
      ["{not json", SECRET_A],
      ["[1,2]", SECRET_A]
    ]) {
      const res = await post(base, raw, secret);
      assert.equal(res.status, 401, raw);
      assert.equal(res.body.error.code, "invalid_webhook_secret");
    }
    assert.equal((await readState(base, "m-c")).status, 404);
  });
});

test("instance secrets: instance names are compared trimmed, like state instance ids", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: JSON.stringify({ " inst-a ": SECRET_A }) }, async (base) => {
    assert.equal((await post(base, update("inst-a", "m-t", "READ"), SECRET_A)).status, 202);
    assert.equal((await post(base, update("  inst-a", "m-t2", "READ"), SECRET_A)).status, 202);
  });
});

test("instance secrets: instanceName is used when instance is absent", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: SECRETS }, async (base) => {
    const raw = JSON.stringify({ event: "messages.update", instanceName: "inst-a", data: { keyId: "m-n", status: "READ" } });
    assert.equal((await post(base, raw, SECRET_A)).status, 202);
    assert.equal((await post(base, raw, SECRET_B)).status, 401);
  });
});

test("instance secrets: the map can be loaded from a file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-secrets-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, SECRETS);
  try {
    await withServer({ EVOLUTION_WEBHOOK_SECRETS_FILE: file }, async (base) => {
      assert.equal((await post(base, update("inst-a", "m-f", "READ"), SECRET_A)).status, 202);
      const { status, body } = await readyz(base);
      assert.equal(status, 200);
      assert.equal(body.webhooks.evolution.configured, true);
      assert.equal(body.webhooks.evolution.instances, 2);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legacy shared secret: ignored by default (fail closed), with a readiness warning", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET }, async (base) => {
    assert.equal((await post(base, update("any", "m-l", "READ"), EVOLUTION_SECRET)).status, 401);
    const { status, body } = await readyz(base);
    assert.equal(status, 200);
    assert.ok(body.warnings.includes("evolution_webhook_legacy_secret_ignored"));
    assert.equal(body.webhooks.evolution.configured, false);
    assert.equal(body.webhooks.evolution.legacy_shared_secret_enabled, false);
  });
});

test("legacy shared secret: accepted for any instance only with the explicit opt-in flag", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    assert.equal((await post(base, update("any", "m-l", "READ"), EVOLUTION_SECRET)).status, 202);
    const { body } = await readyz(base);
    assert.equal(body.webhooks.evolution.configured, true);
    assert.equal(body.webhooks.evolution.legacy_shared_secret_enabled, true);
  });
});

test("legacy shared secret: an instance with its own secret never accepts the legacy secret", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRETS: SECRETS, EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    assert.equal((await post(base, update("inst-a", "m-x", "READ"), EVOLUTION_SECRET)).status, 401);
    assert.equal((await post(base, update("inst-a", "m-x", "READ"), SECRET_A)).status, 202);
    assert.equal((await post(base, update("inst-z", "m-z", "READ"), EVOLUTION_SECRET)).status, 202, "unmapped instance falls back to legacy");
  });
});

test("legacy shared secret: flag on with an empty secret is a readiness failure", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: "  ", EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 503);
    assert.ok(body.reasons.includes("evolution_webhook_legacy_secret_missing"));
  });
});

const invalid = {
  "not JSON": "{nope",
  "an array": "[]",
  "a string": "\"x\"",
  "an empty secret": JSON.stringify({ "inst-a": "" }),
  "a whitespace secret": JSON.stringify({ "inst-a": "   " }),
  "a non-string secret": JSON.stringify({ "inst-a": 5 }),
  "an empty instance name": JSON.stringify({ " ": SECRET_A }),
  "duplicate names after trimming": JSON.stringify({ "inst-a": SECRET_A, " inst-a": SECRET_B })
};

for (const [name, raw] of Object.entries(invalid)) {
  test(`instance secrets: ${name} is a config error -> not ready, all webhooks 401, no value echoed`, async () => {
    await withServer({ EVOLUTION_WEBHOOK_SECRETS: raw }, async (base) => {
      const { status, body } = await readyz(base);
      assert.equal(status, 503);
      assert.ok(body.reasons.some((r) => r.startsWith("evolution_webhook_secrets_")), JSON.stringify(body.reasons));
      assert.ok(!JSON.stringify(body).includes(SECRET_A));
      assert.equal((await post(base, update("inst-a", "m-i", "READ"), SECRET_A)).status, 401);
    });
  });
}

test("instance secrets: config errors are reason codes only", () => {
  assert.equal(loadConfig({ EVOLUTION_WEBHOOK_SECRETS: "{nope" }).evolutionWebhookSecretsError, "evolution_webhook_secrets_invalid_json");
  assert.equal(loadConfig({ EVOLUTION_WEBHOOK_SECRETS: "[]" }).evolutionWebhookSecretsError, "evolution_webhook_secrets_invalid");
  assert.equal(loadConfig({ EVOLUTION_WEBHOOK_SECRETS_FILE: "/nonexistent/evo-secrets.json" }).evolutionWebhookSecretsError, "evolution_webhook_secrets_unreadable");
  assert.equal(loadConfig({ EVOLUTION_WEBHOOK_SECRETS: SECRETS, EVOLUTION_WEBHOOK_SECRETS_FILE: "/x" }).evolutionWebhookSecretsError, "evolution_webhook_secrets_ambiguous");
  assert.equal(loadConfig({ EVOLUTION_WEBHOOK_SECRETS: SECRETS }).evolutionWebhookSecretsError, null);
  assert.equal(loadConfig({}).evolutionWebhookSecretsError, null);
});

test("readyz: a send-configured Evolution provider with no instance secrets is not ready", async () => {
  await withServer({ EVOLUTION_BASE_URL: "http://127.0.0.1:9", EVOLUTION_API_KEY: "test-key-not-real" }, async (base) => {
    const { status, body } = await readyz(base);
    assert.equal(status, 503);
    assert.ok(body.reasons.includes("evolution_webhook_secret_missing"));
  });
  await withServer({ EVOLUTION_BASE_URL: "http://127.0.0.1:9", EVOLUTION_API_KEY: "test-key-not-real", EVOLUTION_WEBHOOK_SECRETS: SECRETS }, async (base) => {
    assert.equal((await readyz(base)).status, 200);
  });
});
