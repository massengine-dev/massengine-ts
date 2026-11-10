import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import util from "node:util";
import { MassEngineClient, MassEngineError } from "../src/index.mjs";

test("MassEngineClient self-contained lifecycle and User-Agent", async () => {
  let seenUserAgent = "";

  const server = http.createServer(async (req, res) => {
    seenUserAgent = req.headers["user-agent"] || "";
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const auth = req.headers["authorization"] || "";

    const send = (code, body, ct = "application/json") => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(code, { "Content-Type": ct });
      res.end(payload);
    };

    if (req.method === "GET" && req.url === "/v1/health") {
      return send(200, { status: "ok" });
    }
    if (req.method === "PUT" && req.url.endsWith("/quota")) {
      return send(200, { tenant: "acme", quota: JSON.parse(raw) });
    }
    if (req.method === "POST" && req.url.endsWith("/keys")) {
      return send(200, { tenant: "acme", key: "mk_ts_test_key" });
    }
    if (req.method === "POST" && req.url.endsWith("/ingest")) {
      const body = JSON.parse(raw);
      return send(200, { ingested: body.docs.length, degraded: false });
    }
    if (req.method === "POST" && req.url === "/v1/search") {
      return send(200, {
        hits: [{ id: "ts-1", doc_id: 1, score: 0.99, shard: 0 }],
        took_ms: 1.4,
      });
    }
    if (req.method === "GET" && req.url === "/v1/tenants/acme") {
      return send(200, { tenant: "acme", doc_count: 2, byte_count: 4096 });
    }
    if (req.method === "PATCH" && req.url.includes("/docs/")) {
      const body = JSON.parse(raw);
      return send(200, {
        id: "ts-2",
        category: body.category,
        metadata: body.metadata,
      });
    }
    if (req.method === "GET" && req.url.endsWith("/export")) {
      return send(
        200,
        '{"id":"ts-1","vector":[1,0]}\n{"id":"ts-2","vector":[0,1]}\n',
        "application/x-ndjson"
      );
    }
    if (req.method === "GET" && req.url.endsWith("/usage")) {
      return send(200, {
        tenant: "acme",
        plan: "pro",
        live_docs: 2,
        read_units: 3,
        write_units: 3,
      });
    }
    if (req.method === "GET" && req.url.endsWith("/docs/ts-1")) {
      if (auth === "Bearer revoked") {
        return send(401, { error: "unauthorized" });
      }
      return send(200, { id: "ts-1", tenant: "acme" });
    }
    if (req.method === "DELETE") {
      return send(200, { deleted: true, docs_deleted: 2, revoked: true });
    }
    return send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const admin = new MassEngineClient({ baseUrl, apiKey: "  admin-key  " });
    assert.equal(admin.apiKey, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(admin)), { baseUrl });
    assert.ok(!util.inspect(admin).includes("admin-key"));

    const h = await admin.health();
    assert.equal(h.status, "ok");
    assert.equal(seenUserAgent, "massengine-ts/1.1.2");

    const quota = await admin.setTenantQuota("acme", {
      plan: "pro",
      max_docs: 50,
      max_qps: 250,
    });
    assert.equal(quota.plan, "pro");
    assert.equal(quota.max_docs, 50);

    const tKey = await admin.createTenantKey("acme");
    assert.ok(tKey.startsWith("mk_"));

    const client = new MassEngineClient({ baseUrl, apiKey: tKey });
    const ing = await client.ingest("acme", [
      { id: "ts-1", vector: [1, 0], category: 1, metadata: { region: "us-east" } },
      { id: "ts-2", vector: [0, 1], category: 2, metadata: { region: "eu-west" } },
    ]);
    assert.equal(ing.ingested, 2);

    const sr = await client.search({
      tenant: "acme",
      vector: [1, 0],
      k: 5,
      metadata_filter: { region: { $eq: "us-east" } },
    });
    assert.equal(sr.hits.length, 1);
    assert.equal(sr.hits[0].id, "ts-1");
    assert.equal(sr.took_ms, 1.4);

    const summary = await client.getTenant("acme");
    assert.equal(summary.doc_count, 2);
    assert.equal(summary.byte_count, 4096);

    const patched = await client.patchDoc("acme", "ts-2", {
      category: 8,
      metadata: { region: "us-east", priority: 9 },
    });
    assert.equal(patched.category, 8);
    assert.equal(patched.metadata.priority, 9);

    const exported = await client.exportTenant("acme");
    assert.equal(exported.length, 2);

    const usage = await client.getTenantUsage("acme");
    assert.equal(usage.plan, "pro");
    assert.equal(usage.live_docs, 2);

    const revokedClient = new MassEngineClient({ baseUrl, apiKey: "revoked" });
    await assert.rejects(
      () => revokedClient.getDoc("acme", "ts-1"),
      (err) => err instanceof MassEngineError && err.statusCode === 401
    );
  } finally {
    server.close();
  }
});

test("Path segment validation rejects dot-segments, control chars, and non-strings", async () => {
  let serverContacted = false;
  const server = http.createServer((_req, res) => {
    serverContacted = true;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const client = new MassEngineClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "mk_valid",
    });

    for (const badTenant of ["", ".", "..", "acme/evil", "acme\\evil", "acme\x00", "acme\n", "acme\x7f", 123, null]) {
      await assert.rejects(() => client.getTenant(badTenant), TypeError);
      await assert.rejects(() => client.getDoc(badTenant, "doc-1"), TypeError);
    }

    for (const badId of ["", ".", "..", "batch-get", "doc\x00", "doc\r\n", "doc\x7f", undefined, {}]) {
      await assert.rejects(() => client.getDoc("acme", badId), TypeError);
      await assert.rejects(() => client.deleteDoc("acme", badId), TypeError);
    }

    assert.equal(serverContacted, false);
  } finally {
    server.close();
  }
});

test("HTTP 302 redirect is blocked without leaking Authorization", async () => {
  let trapContacted = false;
  let leakedAuth = "";

  const trap = http.createServer((req, res) => {
    trapContacted = true;
    leakedAuth = req.headers["authorization"] || "";
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => trap.listen(0, "127.0.0.1", resolve));
  const trapPort = trap.address().port;

  const origin = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${trapPort}/steal` });
    res.end();
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;

  try {
    const client = new MassEngineClient({
      baseUrl: `http://127.0.0.1:${originPort}`,
      apiKey: "mk_secret_bearer_token",
    });

    await assert.rejects(() => client.ready());
    assert.equal(trapContacted, false);
    assert.equal(leakedAuth, "");
  } finally {
    origin.close();
    trap.close();
  }
});

test("Invalid baseUrl and apiKey control-chars rejected without echoing secret", () => {
  for (const badUrl of [
    "ftp://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:pass@example.com",
    "",
  ]) {
    assert.throws(() => new MassEngineClient({ baseUrl: badUrl }), TypeError);
  }

  const secret = "mk_confidential_secret_888";
  for (const badKey of [
    `${secret}\r\nX-Injected: 1`,
    `${secret}\n`,
    `${secret}\x00`,
    `${secret} space`,
    "   ",
  ]) {
    assert.throws(
      () => new MassEngineClient({ baseUrl: "https://api.massengine.com", apiKey: badKey }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(!err.message.includes(secret));
        assert.ok(!String(err.stack || "").includes(secret));
        return true;
      }
    );
  }
});

test("Timeout and maxResponseBytes limits are enforced", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true, pad: "x".repeat(2048) }));
      return;
    }
    if (req.url === "/v1/tenants/acme/export") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end('{"id":"1","vector":[1,2,3,4,5,6]}\n'.repeat(15));
      return;
    }
    if (req.url === "/v1/flush") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"flushed":true}');
      }, 150);
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const smallClient = new MassEngineClient({ baseUrl, maxResponseBytes: 128 });
    await assert.rejects(
      () => smallClient.ready(),
      (err) => err instanceof MassEngineError && err.message.includes("maxResponseBytes")
    );

    await assert.rejects(
      () => smallClient.exportTenant("acme"),
      (err) => err instanceof MassEngineError && err.message.includes("maxResponseBytes")
    );

    await assert.rejects(
      () => smallClient.exportTenant("err-tenant"),
      (err) =>
        err instanceof MassEngineError &&
        err.statusCode === 500 &&
        err.message === "massengine api (status 500): boom"
    );

    const fastClient = new MassEngineClient({ baseUrl, timeoutMs: 30 });
    await assert.rejects(() => fastClient.flush());
  } finally {
    server.close();
  }
});
