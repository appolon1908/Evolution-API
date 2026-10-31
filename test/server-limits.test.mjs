import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

// Connection/memory bound: each connection may hold up to 3 MiB of an
// unauthenticated Meta body, so the number of connections and the time a
// request may take to arrive are both bounded.

async function listen(env = {}) {
  const server = createApp(loadConfig({ PORT: "0", ADAPTER_SERVICE_TOKEN: "test-service-token", ...env }), { logger: () => {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function close(server) {
  server.closeAllConnections?.();
  server.close();
  await once(server, "close");
}

function connect(port) {
  const socket = net.connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("error", () => {});
  const closed = once(socket, "close").then(() => data);
  return { socket, closed, ready: once(socket, "connect") };
}

test("limits: sensible defaults are applied to the HTTP server", async () => {
  const server = await listen();
  try {
    assert.equal(server.maxConnections, 128);
    assert.equal(server.headersTimeout, 10000);
    assert.equal(server.requestTimeout, 30000);
  } finally { await close(server); }
});

test("limits: connection cap and timeouts are configurable via env", async () => {
  const server = await listen({ HTTP_MAX_CONNECTIONS: "7", HTTP_HEADERS_TIMEOUT_MS: "2000", HTTP_REQUEST_TIMEOUT_MS: "5000" });
  try {
    assert.equal(server.maxConnections, 7);
    assert.equal(server.headersTimeout, 2000);
    assert.equal(server.requestTimeout, 5000);
  } finally { await close(server); }
});

test("limits: invalid values fall back to defaults; headers timeout never exceeds request timeout", () => {
  const bad = loadConfig({ HTTP_MAX_CONNECTIONS: "0", HTTP_HEADERS_TIMEOUT_MS: "-1", HTTP_REQUEST_TIMEOUT_MS: "abc" });
  assert.equal(bad.httpMaxConnections, 128);
  assert.equal(bad.httpHeadersTimeoutMs, 10000);
  assert.equal(bad.httpRequestTimeoutMs, 30000);
  const clamped = loadConfig({ HTTP_HEADERS_TIMEOUT_MS: "9000", HTTP_REQUEST_TIMEOUT_MS: "3000" });
  assert.equal(clamped.httpHeadersTimeoutMs, 3000);
});

test("limits: connections over the cap are dropped without being served", async () => {
  const server = await listen({ HTTP_MAX_CONNECTIONS: "2" });
  const port = server.address().port;
  try {
    const held = [connect(port), connect(port)];
    await Promise.all(held.map((c) => c.ready));
    // Start (but do not finish) a request on each so both stay open.
    for (const c of held) c.socket.write("POST /internal/v1/whatsapp/webhooks/meta HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab");
    await new Promise((r) => setTimeout(r, 50));
    const extra = connect(port);
    await extra.ready;
    extra.socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
    const data = await extra.closed;
    assert.equal(data, "", "the connection over the cap must not be served");
    for (const c of held) c.socket.destroy();
  } finally { await close(server); }
});

test("limits: a slow request body times out with 408 and the connection is closed", async () => {
  const server = await listen({ HTTP_HEADERS_TIMEOUT_MS: "200", HTTP_REQUEST_TIMEOUT_MS: "300" });
  const port = server.address().port;
  try {
    const c = connect(port);
    await c.ready;
    const started = Date.now();
    c.socket.write("POST /internal/v1/whatsapp/webhooks/meta HTTP/1.1\r\nHost: x\r\nContent-Length: 3000000\r\n\r\n" + "x".repeat(1024));
    const timer = setTimeout(() => c.socket.destroy(), 5000);
    const data = await c.closed;
    clearTimeout(timer);
    assert.match(data, /^HTTP\/1\.1 408 /);
    assert.ok(Date.now() - started < 4000, "closed by the request timeout, not the test guard");
  } finally { await close(server); }
});

test("limits: slow request headers time out", async () => {
  const server = await listen({ HTTP_HEADERS_TIMEOUT_MS: "200", HTTP_REQUEST_TIMEOUT_MS: "300" });
  const port = server.address().port;
  try {
    const c = connect(port);
    await c.ready;
    c.socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n");
    const timer = setTimeout(() => c.socket.destroy(), 5000);
    const data = await c.closed;
    clearTimeout(timer);
    assert.match(data, /^HTTP\/1\.1 408 /);
  } finally { await close(server); }
});
