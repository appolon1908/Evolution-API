import test from "node:test";
import assert from "node:assert/strict";
import { EVOLUTION_SECRET, withServer, readState } from "./webhook-helpers.mjs";

// E1 T9: duplicate and stale/out-of-order Evolution webhooks over HTTP cannot
// regress a terminal status (ordering was only HTTP-tested for Meta).

function evolutionStatus(id, status, instance = "inst-1") {
  return JSON.stringify({ event: "messages.update", instance, data: { key: { id, remoteJid: "15550000000@s.whatsapp.net", fromMe: true }, status } });
}

async function postEvolution(base, raw) {
  const res = await fetch(base + "/internal/v1/whatsapp/webhooks/evolution", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codestra-webhook-secret": EVOLUTION_SECRET },
    body: raw
  });
  return { status: res.status, body: await res.json() };
}

const env = { EVOLUTION_WEBHOOK_SECRET: EVOLUTION_SECRET };

test("evolution webhook: duplicate delivery is acknowledged idempotently", async () => {
  await withServer(env, async (base) => {
    const raw = evolutionStatus("evo.dup", "DELIVERY_ACK");
    const first = await postEvolution(base, raw);
    assert.equal(first.status, 202);
    assert.equal(first.body.duplicate, false);
    const second = await postEvolution(base, raw);
    assert.equal(second.status, 202);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.stale, false);
    assert.equal((await readState(base, "evo.dup")).body.state, "DELIVERED");
  });
});

test("evolution webhook: redelivered terminal READ is a duplicate and stays READ", async () => {
  await withServer(env, async (base) => {
    const raw = evolutionStatus("evo.read-dup", "READ");
    assert.equal((await postEvolution(base, raw)).status, 202);
    const again = await postEvolution(base, raw);
    assert.equal(again.body.duplicate, true);
    assert.equal((await readState(base, "evo.read-dup")).body.state, "READ");
  });
});

test("evolution webhook: stale out-of-order statuses do not regress READ", async () => {
  await withServer(env, async (base) => {
    assert.equal((await postEvolution(base, evolutionStatus("evo.order", "READ"))).status, 202);
    for (const status of ["DELIVERY_ACK", "SERVER_ACK", "ERROR"]) {
      const res = await postEvolution(base, evolutionStatus("evo.order", status));
      assert.equal(res.status, 202);
      assert.equal(res.body.stale, true, `${status} after READ must be stale`);
      assert.equal(res.body.duplicate, false);
    }
    assert.equal((await readState(base, "evo.order")).body.state, "READ");
  });
});

test("evolution webhook: FAILED is terminal; later progress events are stale", async () => {
  await withServer(env, async (base) => {
    assert.equal((await postEvolution(base, evolutionStatus("evo.failed", "ERROR"))).status, 202);
    for (const status of ["SERVER_ACK", "DELIVERY_ACK", "READ"]) {
      const res = await postEvolution(base, evolutionStatus("evo.failed", status));
      assert.equal(res.body.stale, true, `${status} after ERROR must be stale`);
    }
    assert.equal((await readState(base, "evo.failed")).body.state, "FAILED");
  });
});

test("evolution webhook: a late ERROR cannot undo a DELIVERED message", async () => {
  await withServer(env, async (base) => {
    await postEvolution(base, evolutionStatus("evo.delivered", "DELIVERY_ACK"));
    const late = await postEvolution(base, evolutionStatus("evo.delivered", "ERROR"));
    assert.equal(late.body.stale, true);
    assert.equal((await readState(base, "evo.delivered")).body.state, "DELIVERED");
  });
});

test("evolution webhook: interleaved duplicates and stale events end at the furthest status", async () => {
  await withServer(env, async (base) => {
    const seq = ["SERVER_ACK", "DELIVERY_ACK", "SERVER_ACK", "READ", "DELIVERY_ACK", "READ", "SERVER_ACK"];
    const flags = [];
    for (const status of seq) {
      const { body } = await postEvolution(base, evolutionStatus("evo.mix", status));
      flags.push(body.duplicate ? "dup" : body.stale ? "stale" : "applied");
    }
    assert.deepEqual(flags, ["applied", "applied", "stale", "applied", "stale", "dup", "stale"]);
    assert.equal((await readState(base, "evo.mix")).body.state, "READ");
  });
});

test("evolution webhook: in-order progress still advances to READ", async () => {
  await withServer(env, async (base) => {
    for (const status of ["SERVER_ACK", "DELIVERY_ACK", "READ"]) {
      const res = await postEvolution(base, evolutionStatus("evo.progress", status));
      assert.equal(res.body.stale, false);
      assert.equal(res.body.duplicate, false);
    }
    assert.equal((await readState(base, "evo.progress")).body.state, "READ");
  });
});
