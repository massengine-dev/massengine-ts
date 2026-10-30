import test from "node:test";
import assert from "node:assert/strict";
import { MassEngineClient, MassEngineError } from "../src/index.mjs";

const baseUrl = process.env.MASSENGINE_URL || "http://127.0.0.1:18081";
const adminKey = process.env.MASSENGINE_ADMIN_KEY || "test-admin-secret";

test("MassEngineClient end-to-end lifecycle", async () => {
  const admin = new MassEngineClient({ baseUrl, apiKey: adminKey });
  const tenant = "ts-sdk-tenant";

  try {
    await admin.deleteTenant(tenant);
  } catch {}

  const h = await admin.health();
  assert.equal(h.status, "ok");

  const quota = await admin.setTenantQuota(tenant, {
    plan: "pro",
    max_docs: 50,
    max_qps: 250,
  });
  assert.equal(quota.plan, "pro");
  assert.equal(quota.max_docs, 50);

  const tKey = await admin.createTenantKey(tenant);
  assert.ok(tKey.startsWith("mk_"));

  const client = new MassEngineClient({ baseUrl, apiKey: tKey });

  const ing = await client.ingest(tenant, [
    {
      id: "ts-1",
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
      category: 1,
      metadata: { region: "us-east", priority: 10, tags: ["edge", "ts"] },
    },
    {
      id: "ts-2",
      vector: [0, 1, 0, 0, 0, 0, 0, 0],
      category: 2,
      metadata: { region: "eu-west", priority: 2, tags: ["batch"] },
    },
  ]);
  assert.equal(ing.ingested, 2);

  const sr = await client.search({
    tenant,
    vector: [1, 0, 0, 0, 0, 0, 0, 0],
    k: 5,
    metadata_filter: {
      region: { $eq: "us-east" },
      priority: { $gte: 5 },
      tags: { $contains: "ts" },
    },
  });
  assert.equal(sr.hits.length, 1);
  assert.equal(sr.hits[0].id, "ts-1");

  const patched = await client.patchDoc(tenant, "ts-2", {
    category: 8,
    metadata: { region: "us-east", priority: 9 },
  });
  assert.equal(patched.category, 8);
  assert.equal(patched.metadata.priority, 9);

  const exported = await client.exportTenant(tenant);
  assert.equal(exported.length, 2);

  const usage = await client.getTenantUsage(tenant);
  assert.equal(usage.plan, "pro");
  assert.equal(usage.live_docs, 2);
  assert.ok(usage.read_units >= 2);
  assert.ok(usage.write_units >= 3);

  await admin.revokeTenantKey(tenant, tKey);
  await assert.rejects(
    () => client.getDoc(tenant, "ts-1"),
    (err) => err instanceof MassEngineError && err.statusCode === 401
  );

  await admin.deleteTenant(tenant);
});
