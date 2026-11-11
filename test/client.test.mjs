import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { MassEngineClient, MassEngineError } from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("MassEngineClient self-contained lifecycle and User-Agent", async () => {
  let seenUserAgent = "";

  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
  );
  assert.equal(pkg.version, "1.1.4");

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
        degraded: false,
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
    if (req.method === "GET" && req.url === "/v1/usage") {
      return send(200, {
        tenants: [],
        total_live_docs: 2,
        total_live_bytes: 8192,
        total_read_units: 3,
        total_write_units: 3,
      });
    }
    if (req.method === "GET" && req.url.endsWith("/usage")) {
      return send(200, {
        tenant: "acme",
        plan: "pro",
        partition_count: 2,
        live_docs: 2,
        live_bytes: 8192,
        max_bytes: 1073741824,
        read_requests: 3,
        read_units: 3,
        write_requests: 2,
        write_units: 3,
        rate_limited: 0,
        search_latency: { count: 4, avg_ms: 0.9, p50_ms: 0.8, p95_ms: 1.4, p99_ms: 1.8 },
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
    assert.equal(seenUserAgent, "massengine-ts/1.1.4");

    const quota = await admin.setTenantQuota("acme", {
      plan: "pro",
      max_docs: 50,
      max_bytes: 1073741824,
      max_qps: 250,
    });
    assert.equal(quota.plan, "pro");
    assert.equal(quota.max_docs, 50);
    assert.equal(quota.max_bytes, 1073741824);

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
    assert.equal(patched.degraded, false);
    assert.equal(patched.metadata.priority, 9);

    const exported = await client.exportTenant("acme");
    assert.equal(exported.length, 2);

    const usage = await client.getTenantUsage("acme");
    assert.equal(usage.plan, "pro");
    assert.equal(usage.live_docs, 2);
    assert.equal(usage.live_bytes, 8192);
    assert.equal(usage.partition_count, 2);
    assert.equal(usage.search_latency.p95_ms, 1.4);

    const report = await admin.listUsage();
    assert.equal(report.total_live_bytes, 8192);

    const revokedClient = new MassEngineClient({ baseUrl, apiKey: "revoked" });
    await assert.rejects(
      () => revokedClient.getDoc("acme", "ts-1"),
      (err) => err instanceof MassEngineError && err.statusCode === 401
    );
  } finally {
    server.close();
  }
});

test("Empty search vector rejected client-side and index.d.ts updated", async () => {
  const dts = fs.readFileSync(path.join(__dirname, "../src/index.d.ts"), "utf8");
  assert.ok(!dts.includes("query_text"), "query_text must be removed from index.d.ts");
  assert.ok(!dts.includes("hybrid_alpha"), "hybrid_alpha must be removed from index.d.ts");
  assert.ok(dts.includes("max_bytes?: number"), "max_bytes must exist in index.d.ts");
  assert.ok(dts.includes("degraded?: boolean"), "degraded?: boolean must exist on patchDoc");
  assert.ok(dts.includes("partition_count"), "partition_count must exist in TenantUsage");
  assert.ok(dts.includes("live_bytes"), "live_bytes must exist in TenantUsage");
  assert.ok(dts.includes("search_latency"), "search_latency must exist in TenantUsage");
  assert.ok(dts.includes("total_live_bytes"), "total_live_bytes must exist in UsageReport");
  assert.ok(dts.includes("listDatabases"), "listDatabases must exist in index.d.ts");
  assert.ok(dts.includes("createDatabase"), "createDatabase must exist in index.d.ts");
  assert.ok(dts.includes("getDatabase"), "getDatabase must exist in index.d.ts");
  assert.ok(dts.includes("deleteDatabase"), "deleteDatabase must exist in index.d.ts");

  let contacted = false;
  const server = http.createServer((_req, res) => {
    contacted = true;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const client = new MassEngineClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(() => client.search({ tenant: "acme", k: 5 }), TypeError);
    await assert.rejects(() => client.search({ tenant: "acme", vector: [], k: 5 }), TypeError);
    await assert.rejects(() => client.batchSearch([]), TypeError);
    await assert.rejects(
      () => client.batchSearch([{ tenant: "acme", vector: [1, 0], k: 5 }, { tenant: "acme", vector: [], k: 5 }]),
      TypeError
    );
    assert.equal(contacted, false);
  } finally {
    server.close();
  }
});

test("ready() returns ReadyStatus on HTTP 503 JSON without throwing MassEngineError", async () => {
  let mode = "503_json";
  const server = http.createServer((_req, res) => {
    if (mode === "503_json") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false, unavailable_shards: [1, 3] }));
      return;
    }
    if (mode === "503_text") {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("503 Bad Gateway");
      return;
    }
    if (mode === "503_err") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "cluster upstream not configured" }));
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const client = new MassEngineClient({ baseUrl: `http://127.0.0.1:${port}` });
    const st = await client.ready();
    assert.equal(st.ready, false);
    assert.deepEqual(st.unavailable_shards, [1, 3]);

    for (const errMode of ["503_text", "503_err", "500"]) {
      mode = errMode;
      await assert.rejects(
        () => client.ready(),
        (err) => err instanceof MassEngineError
      );
    }
  } finally {
    server.close();
  }
});

test("Slash document IDs escape per-segment and invalid doc IDs are rejected across all methods", async () => {
  let seenUrls = [];
  const server = http.createServer(async (req, res) => {
    seenUrls.push(`${req.method} ${req.url}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");

    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/docs/batch-get")) {
      const body = JSON.parse(raw);
      return res.end(JSON.stringify({ docs: body.ids.map((id) => ({ id, tenant: "acme" })) }));
    }
    if (req.url.includes("/docs/")) {
      const rawId = req.url.split("/docs/")[1].split("?")[0];
      const decodedId = rawId.split("/").map(decodeURIComponent).join("/");
      return res.end(JSON.stringify({ id: decodedId, tenant: "acme", deleted: true }));
    }
    res.end(JSON.stringify({ ingested: 1, imported: 1 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const client = new MassEngineClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "mk_test" });
    const slashId = "docs/2026/q1 report.pdf#0";

    await client.ingest("acme", [{ id: slashId, vector: [1, 0] }]);
    seenUrls = [];
    const doc = await client.getDoc("acme", slashId);
    assert.equal(doc.id, slashId);
    assert.equal(seenUrls[0], "GET /v1/tenants/acme/docs/docs/2026/q1%20report.pdf%230");

    const patched = await client.patchDoc("acme", slashId, { category: 2 });
    assert.equal(patched.id, slashId);
    const bdocs = await client.batchGetDocs("acme", [slashId]);
    assert.equal(bdocs[0].id, slashId);
    await client.deleteDoc("acme", slashId);

    const beforeCount = seenUrls.length;
    const badIds = ["", ".", "..", "batch-get", "doc\x00", "doc\r\n", "doc\x7f", "a/../b", "a/./b", "/lead", "trail/", "a//b", undefined, {}];
    for (const badId of badIds) {
      await assert.rejects(() => client.ingest("acme", [{ id: badId, vector: [1, 0] }]), TypeError);
      await assert.rejects(() => client.importTenant("acme", [{ id: badId, vector: [1, 0] }]), TypeError);
      await assert.rejects(() => client.getDoc("acme", badId), TypeError);
      await assert.rejects(() => client.patchDoc("acme", badId, { category: 1 }), TypeError);
      await assert.rejects(() => client.batchGetDocs("acme", [badId]), TypeError);
      await assert.rejects(() => client.deleteDoc("acme", badId), TypeError);
    }
    assert.equal(seenUrls.length, beforeCount);
  } finally {
    server.close();
  }
});

test("Multi-database CRUD and database-scoped data-plane operations", async () => {
  const seenRequests = [];
  let getDb405 = false;

  const server = http.createServer(async (req, res) => {
    seenRequests.push(`${req.method} ${req.url}`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsedUrl = new URL(req.url, "http://localhost");
    const pathname = parsedUrl.pathname;
    const dbQuery = parsedUrl.searchParams.get("database") || "";

    const send = (code, body, ct = "application/json") => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(code, { "Content-Type": ct });
      res.end(payload);
    };

    if (req.method === "GET" && (pathname === "/v1/databases" || pathname.endsWith("/databases"))) {
      return send(200, {
        tenant: "acme",
        databases: [
          { tenant: "acme/analytics", database: "analytics", num_shards: 2, rf: 2, data_type: "int8", doc_count: 4 },
        ],
      });
    }
    if (req.method === "POST" && (pathname === "/v1/databases" || pathname.endsWith("/databases"))) {
      const body = JSON.parse(raw);
      return send(200, {
        ok: true,
        database: {
          tenant: `acme/${body.database}`,
          database: body.database,
          num_shards: body.num_shards || 1,
          rf: body.rf || 1,
          data_type: body.data_type || "int8",
          doc_count: 0,
        },
        partition: body.database,
      });
    }
    if (req.method === "GET" && pathname.includes("/databases/")) {
      if (getDb405) {
        return send(405, "Method Not Allowed", "text/plain");
      }
      const dbName = decodeURIComponent(pathname.split("/databases/")[1]);
      return send(200, { tenant: `acme/${dbName}`, database: dbName, num_shards: 2, doc_count: 4 });
    }
    if (req.method === "DELETE" && pathname.includes("/databases/")) {
      return send(200, { deleted: true, docs_deleted: 4 });
    }
    if (pathname === "/v1/ingest" || pathname.endsWith("/ingest")) {
      const body = JSON.parse(raw);
      return send(200, { ingested: body.docs.length, degraded: false, database: body.database });
    }
    if (pathname === "/v1/search") {
      return send(200, { hits: [{ id: "d1", doc_id: 1, score: 0.9, shard: 0 }] });
    }
    if (pathname === "/v1/search/batch") {
      return send(200, { results: [{ hits: [{ id: "d1", doc_id: 1, score: 0.9, shard: 0 }] }] });
    }
    if (pathname === "/v1/docs/batch-get" || pathname.endsWith("/docs/batch-get")) {
      const body = JSON.parse(raw);
      return send(200, { docs: body.ids.map((id) => ({ id, tenant: "acme", database: body.database })) });
    }
    if (pathname.includes("/docs/")) {
      const body = raw ? JSON.parse(raw) : {};
      return send(200, { id: "d1", tenant: "acme", database: dbQuery || body.database, deleted: true });
    }
    if (pathname === "/v1/import" || pathname.endsWith("/import")) {
      return send(200, { imported: 1 });
    }
    if (pathname === "/v1/export" || pathname.endsWith("/export")) {
      return send(200, `${JSON.stringify({ id: "d1", database: dbQuery, vector: [1, 0] })}\n`, "application/x-ndjson");
    }
    return send(404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const client = new MassEngineClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "mk_scoped" });

    for (const tenant of ["acme", ""]) {
      const created = await client.createDatabase(tenant, {
        database: "analytics",
        num_shards: 2,
        rf: 2,
        data_type: "int8",
        mode: "multi",
      });
      assert.equal(created.database, "analytics");
      assert.equal(created.num_shards, 2);

      const dbs = await client.listDatabases(tenant);
      assert.equal(dbs.length, 1);
      assert.equal(dbs[0].database, "analytics");

      getDb405 = false;
      const gotDb = await client.getDatabase(tenant, "analytics");
      assert.equal(gotDb.database, "analytics");

      getDb405 = true;
      const gotFb = await client.getDatabase(tenant, "analytics");
      assert.equal(gotFb.database, "analytics");

      const deleted = await client.deleteDatabase(tenant, "analytics");
      assert.equal(deleted, 4);

      const ing = await client.ingest(tenant, [{ id: "d1", vector: [1, 0] }], "analytics");
      assert.equal(ing.database, "analytics");

      await client.search({ tenant, database: "analytics", vector: [1, 0], k: 5 });
      await client.batchSearch([{ tenant, vector: [1, 0], k: 5 }], "analytics");

      const doc = await client.getDoc(tenant, "d1", "analytics");
      assert.equal(doc.database, "analytics");

      const pdoc = await client.patchDoc(tenant, "d1", { database: "analytics", category: 2 });
      assert.equal(pdoc.database, "analytics");

      const bdocs = await client.batchGetDocs(tenant, ["d1"], "analytics");
      assert.equal(bdocs[0].database, "analytics");

      await client.deleteDoc(tenant, "d1", "analytics");

      const imp = await client.importTenant(tenant, [{ id: "d1", vector: [1, 0] }], "analytics");
      assert.equal(imp, 1);

      const exp = await client.exportTenant(tenant, "analytics");
      assert.equal(exp[0].database, "analytics");
    }

    for (const r of seenRequests) {
      assert.ok(!r.includes("//"), `Unexpected double-slash request: ${r}`);
    }
    assert.ok(seenRequests.includes("POST /v1/import?database=analytics"));
    assert.ok(seenRequests.includes("GET /v1/export?database=analytics"));
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
    }

    for (const badScoped of [".", "..", "acme/evil", "acme\\evil", "acme\x00", "acme\n", "acme\x7f", 123, null]) {
      await assert.rejects(() => client.getDoc(badScoped, "doc-1"), TypeError);
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
      () => new MassEngineClient({ baseUrl: "https://massengine.com", apiKey: badKey }),
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
