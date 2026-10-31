import test from "node:test";
import assert from "node:assert/strict";
import { createMessageState } from "../src/state.mjs";
import { normalizeMetaWebhook } from "../src/webhooks.mjs";
import { metaStatusBody } from "./webhook-helpers.mjs";

const metaEvent = (id, status) => normalizeMetaWebhook(JSON.parse(metaStatusBody(id, status)));

test("state: send acknowledgement after an early DELIVERED webhook does not regress to ACCEPTED", () => {
  const state = createMessageState();
  state.applyEvent(metaEvent("wamid.race", "delivered"));
  state.rememberAccepted({ provider: "meta", provider_message_id: "wamid.race" });
  assert.equal(state.get("wamid.race").state, "DELIVERED");
});

test("state: send acknowledgement with no prior event records ACCEPTED", () => {
  const state = createMessageState();
  state.rememberAccepted({ provider: "meta", provider_message_id: "wamid.new" });
  assert.equal(state.get("wamid.new").state, "ACCEPTED");
  assert.equal(state.get("wamid.new").provider, "meta");
});

test("state: FAILED cannot replace DELIVERED", () => {
  const state = createMessageState();
  state.applyEvent(metaEvent("wamid.df", "delivered"));
  assert.deepEqual(state.applyEvent(metaEvent("wamid.df", "failed")), { applied: false, duplicate: false, stale: true, ignored: false });
  assert.equal(state.get("wamid.df").state, "DELIVERED");
});

test("state: FAILED still replaces SENT and ACCEPTED", () => {
  const state = createMessageState();
  state.applyEvent(metaEvent("wamid.sf", "sent"));
  assert.equal(state.applyEvent(metaEvent("wamid.sf", "failed")).applied, true);
  assert.equal(state.get("wamid.sf").state, "FAILED");
  state.rememberAccepted({ provider: "meta", provider_message_id: "wamid.af" });
  assert.equal(state.applyEvent(metaEvent("wamid.af", "failed")).applied, true);
  assert.equal(state.get("wamid.af").state, "FAILED");
});
