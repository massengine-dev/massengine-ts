# MassEngine TypeScript & Node.js SDK (`@massengine/client`)

Official zero-dependency TypeScript / JavaScript SDK for [MassEngine](https://massengine.com) — the sub-5ms filtered and hybrid vector search database. Works natively in Node.js 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.

## Installation

```bash
npm install @massengine/client
```

## Quickstart

```ts
import { MassEngineClient } from "@massengine/client";

const client = new MassEngineClient({
  baseUrl: "https://api.massengine.com",
  apiKey: "mk_your_tenant_api_key",
});

// 1. Ingest vectors + structured metadata
await client.ingest("acme-prod", [
  {
    id: "doc-1",
    vector: [0.12, -0.44, 0.88, 0.05],
    category: 1,
    metadata: { department: "security", clearance: 3, tags: ["soc2", "policy"] },
  },
]);

// 2. Hybrid dense + BM25 search with rich metadata filter operators
const { hits } = await client.search({
  tenant: "acme-prod",
  vector: [0.12, -0.44, 0.88, 0.05],
  query_text: "soc2 policy",
  hybrid_alpha: 0.7,
  k: 10,
  min_score: 0.5,
  metadata_filter: {
    department: { $in: ["security", "legal"] },
    clearance: { $gte: 2 },
    tags: { $contains: "soc2" },
  },
});

// 3. In-place metadata patching without re-embedding
await client.patchDoc("acme-prod", "doc-1", {
  metadata: { clearance: 4, reviewed: true },
});

// 4. Inspect tenant quota & billable usage
const usage = await client.getTenantUsage("acme-prod");
console.log(usage);
```

## License

Apache License 2.0
