export interface MassEngineOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export interface Doc<M = Record<string, unknown>> {
  id: string;
  vector: number[];
  date?: number;
  category?: number;
  metadata?: M;
}

export interface SearchRequest {
  tenant: string;
  vector?: number[];
  query_text?: string;
  hybrid_alpha?: number;
  metadata_filter?: Record<string, unknown>;
  k: number;
  offset?: number;
  min_score?: number;
  rerank_pool?: number;
  nprobe?: number;
  min_date?: number;
  max_date?: number;
  category?: number;
  categories?: number[];
}

export interface SearchHit<M = Record<string, unknown>> {
  id: string;
  doc_id: number;
  score: number;
  shard: number;
  metadata?: M;
}

export interface SearchResponse<M = Record<string, unknown>> {
  hits: SearchHit<M>[];
  stats: Record<string, unknown>;
}

export interface PatchRequest<M = Record<string, unknown>> {
  date?: number;
  category?: number;
  metadata?: M;
  replace_metadata?: boolean;
}

export interface TenantQuota {
  plan?: string;
  max_docs?: number;
  max_qps?: number;
  burst?: number;
  suspended?: boolean;
}

export interface TenantUsage {
  tenant: string;
  plan?: string;
  suspended?: boolean;
  live_docs: number;
  max_docs?: number;
  max_qps?: number;
  read_requests: number;
  read_units: number;
  write_requests: number;
  write_units: number;
  rate_limited: number;
  updated_at?: string;
}

export interface UsageReport {
  tenants: TenantUsage[];
  total_live_docs: number;
  total_read_units: number;
  total_write_units: number;
}

export declare class MassEngineError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string);
}

export declare class MassEngineClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  constructor(options?: MassEngineOptions);
  ingest(tenant: string, docs: Doc[]): Promise<{ ingested: number; degraded: boolean }>;
  search<M = Record<string, unknown>>(req: SearchRequest): Promise<SearchResponse<M>>;
  batchSearch<M = Record<string, unknown>>(queries: SearchRequest[]): Promise<{ results: SearchResponse<M>[] }>;
  getDoc<M = Record<string, unknown>>(tenant: string, id: string): Promise<{ id: string; tenant: string; metadata?: M }>;
  patchDoc<M = Record<string, unknown>>(tenant: string, id: string, patch: PatchRequest<M>): Promise<{ id: string; tenant: string; date?: number; category?: number; metadata?: M }>;
  batchGetDocs<M = Record<string, unknown>>(tenant: string, ids: string[]): Promise<Array<{ id: string; tenant: string; metadata?: M }>>;
  deleteDoc(tenant: string, id: string): Promise<{ deleted: boolean; id: string }>;
  importTenant(tenant: string, docs: Doc[]): Promise<number>;
  exportTenant<M = Record<string, unknown>>(tenant: string): Promise<Doc<M>[]>;
  createTenantKey(tenant: string, key?: string): Promise<string>;
  revokeTenantKey(tenant: string, key: string): Promise<{ revoked: boolean }>;
  setTenantQuota(tenant: string, quota: TenantQuota): Promise<TenantQuota>;
  getTenantQuota(tenant: string): Promise<TenantQuota>;
  getTenantUsage(tenant: string): Promise<TenantUsage>;
  listUsage(): Promise<UsageReport>;
  listTenants(): Promise<Array<{ tenant: string; tag: number; mode: string; pinned_shard: number; doc_count: number }>>;
  getTenant(tenant: string): Promise<{ tenant: string; tag: number; mode: string; pinned_shard: number; doc_count: number }>;
  deleteTenant(tenant: string): Promise<number>;
  flush(): Promise<{ flushed: boolean }>;
  compact(): Promise<{ compacted: boolean }>;
  ready(): Promise<{ ready: boolean; unavailable_shards?: number[] }>;
  health(): Promise<{ status: string }>;
}
