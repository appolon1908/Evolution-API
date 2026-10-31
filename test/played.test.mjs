import test from "node:test";
import assert from "node:assert/strict";
import { createMessageState } from "../src/state.mjs";
import { EVOLUTION_SECRET, withServer, readState } from "./webhook-helpers.mjs";

// Owner decision 2026-10-30: Evolution PLAYED (renderStatus 5, a voice/video
// message was played) is READ, a terminal success.

function evo(status) {
  return { source: "evolution", provider_message_id: "p", instance_id: "i", provider_payload: { data: { keyId: "p", status } } };
}

test("state: PLAYED advances ACCEPTED, SENT and DELIVERED to READ", () => {
  for (const before of [[], ["SERVER_ACK"], ["SERVER_ACK", "DELIVERY_ACK"]]) {
    const state = createMessageState({ logger: () => {} });
    state.rememberAccepted({ provider: "evolution", provider_message_id: "p" }, { tenantId: "a", instanceId: "i" });
    for (const s of before) state.applyEvent(evo(s));
    const r = state.applyEvent(evo("PLAYED"));
    assert.equal(r.applied, true, before.join(","));
    assert.equal(r.unrecognized, false);
    assert.equal(state.get("p").state, "READ");
  }
});

test("state: PLAYED is terminal; READ then PLAYED is a duplicate; PLAYED after FAILED is stale", () => {
  const state = createMessageState({ logger: () => {} });
  state.rememberAccepted({ provider: "evolution", provider_message_id: "p" }, { tenantId: "a", instanceId: "i" });
  state.applyEvent(evo("PLAYED"));
  for (const s of ["DELIVERY_ACK", "SERVER_ACK", "ERROR"]) {
    assert.equal(state.applyEvent(evo(s)).stale, true, s);
  }
  assert.equal(state.applyEvent(evo("READ")).duplicate, true);
  assert.equal(state.applyEvent(evo("played")).duplicate, true);
  assert.equal(state.get("p").state, "READ");

  const failed = createMessageState({ logger: () => {} });
  failed.applyEvent(evo("ERROR"));
  assert.equal(failed.applyEvent(evo("PLAYED")).stale, true);
  assert.equal(failed.get("p").state, "FAILED");
});

test("http: an upstream-shaped PLAYED messages.update sets READ", async () => {
  await withServer({ EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET, EVOLUTION_WEBHOOK_LEGACY_SHARED_SECRET: "true" }, async (base) => {
    const post = (status) => fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
      body: JSON.stringify({ event: "messages.update", instance: "inst-1", data: { keyId: "evo.played", remoteJid: "15550000000@s.whatsapp.net", fromMe: true, status, instanceId: "uuid-1", messageId: "db-cuid" } })
    }).then((r) => r.json());
    await post("DELIVERY_ACK");
    const played = await post("PLAYED");
    assert.equal(played.unrecognized, false);
    assert.equal(played.stale, false);
    assert.equal((await readState(base, "evo.played")).body.state, "READ");
    assert.equal((await post("DELIVERY_ACK")).stale, true);
  });
});
