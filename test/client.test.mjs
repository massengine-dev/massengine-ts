import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MassEngineClient, MassEngineError } from "../src/index.mjs";

test("MassEngineClient self-contained lifecycle", async () => {
  const server = http.createServer(async (req, res) => {
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
        stats: {},
      });
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
    const admin = new MassEngineClient({ baseUrl, apiKey: "admin-key" });
    const h = await admin.health();
    assert.equal(h.status, "ok");

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
