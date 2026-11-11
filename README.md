# MassEngine TypeScript & Node.js SDK (`@massengine/client`)

Official zero-dependency TypeScript / JavaScript SDK for [MassEngine](https://massengine.com) — the sub-5ms filtered vector search database. Works natively in Node.js 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.

## Installation

```bash
npm install @massengine/client
```

## Quickstart

```ts
import { MassEngineClient } from "@massengine/client";

// Connect to a local quickstart cluster (http://localhost:8080) or cloud gateway:
const client = new MassEngineClient({
  baseUrl: "http://localhost:8080",
  apiKey: "mk_your_tenant_or_meadm_admin_key",
});

// 1. Ingest dense vectors + structured metadata
await client.ingest("acme-prod", [
  {
    id: "docs/2026/policy-1",
    vector: [0.12, -0.44, 0.88, 0.05],
    category: 1,
    metadata: { department: "security", clearance: 3, tags: ["soc2", "policy"] },
  },
]);

// 2. Dense vector search with rich metadata filter operators
const { hits } = await client.search({
  tenant: "acme-prod",
  vector: [0.12, -0.44, 0.88, 0.05],
  k: 10,
  min_score: 0.5,
  metadata_filter: {
    department: { $in: ["security", "legal"] },
    clearance: { $gte: 2 },
    tags: { $contains: "soc2" },
  },
});

// 3. In-place metadata patching without re-embedding
await client.patchDoc("acme-prod", "docs/2026/policy-1", {
  metadata: { clearance: 4, reviewed: true },
});

// 4. Inspect tenant quota & billable usage
const usage = await client.getTenantUsage("acme-prod");
console.log(usage);
```

## Multi-Database Scoping

Create isolated databases within a tenant and scope operations using a database name (pass `tenant = ""` when authenticating with a tenant-scoped `mk_...` key):

```ts
await client.createDatabase("", { database: "analytics", data_type: "int8" });

await client.ingest("", [{ id: "event-1", vector: [0.1, 0.2, 0.3, 0.4] }], "analytics");

const { hits } = await client.search({
  database: "analytics",
  vector: [0.1, 0.2, 0.3, 0.4],
  k: 5,
});
```

## License

Apache License 2.0
