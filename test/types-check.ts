import { MassEngineClient, type Doc } from "@massengine/client";

interface ArticleMeta {
  title: string;
  views: number;
}

async function verifyTypes() {
  const client = new MassEngineClient({ baseUrl: "http://127.0.0.1:8081", apiKey: "mk_test" });
  const docs: Doc<ArticleMeta>[] = [
    {
      id: "doc-1",
      vector: [1, 0],
      metadata: { title: "hello", views: 42 },
    },
  ];
  await client.ingest("acme", docs, "articles");
  await client.importTenant("acme", docs, { database: "articles" });
  const sr = await client.search<ArticleMeta>({ vector: [1, 0], k: 5 });
  const title: string | undefined = sr.hits[0]?.metadata?.title;
  await client.patchDoc<ArticleMeta>("acme", "doc-1", { metadata: { title: title || "x", views: 1 } });
}

void verifyTypes;
