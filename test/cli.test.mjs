import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
test("CLI entrypoint stays running until terminated", async () => {
  const file = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, PORT: "0", WHATSAPP_PRODUCTION_SEND: "false", EXTERNAL_SEND_ENABLED: "false", FORWARD_EVENTS_ENABLED: "false" },
    stdio: "ignore"
  });
  try {
    await sleep(650);
    assert.equal(child.exitCode, null, "standalone server must not exit at startup");
    assert.equal(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
