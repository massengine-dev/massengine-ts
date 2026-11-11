export interface MassEngineOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface Doc<M = Record<string, unknown>> {
  id: string;
  database?: string;
  vector: number[];
  date?: number;
  category?: number;
  metadata?: M;
}

export interface SearchRequest {
  tenant?: string;
  database?: string;
  vector: number[];
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
  took_ms?: number;
}

export interface PatchRequest<M = Record<string, unknown>> {
  database?: string;
  date?: number;
  category?: number;
  metadata?: M;
  replace_metadata?: boolean;
}

export interface DatabaseConfig {
  database: string;
  num_shards?: number;
  rf?: number;
  mode?: string;
  data_type?: string;
}

export interface DatabaseInfo {
  tenant: string;
  database?: string;
  partition?: string;
  tag?: number;
  mode?: string;
  pinned_shard?: number;
  num_shards?: number;
  rf?: number;
  data_type?: string;
  explicit_shards?: boolean;
  doc_count: number;
  byte_count?: number;
}

export interface TenantSummary {
  tenant: string;
  database?: string;
  partition?: string;
  mode?: string;
  pinned_shard?: number;
  num_shards?: number;
  rf?: number;
  data_type?: string;
  doc_count: number;
  byte_count?: number;
}

export interface TenantQuota {
  plan?: string;
  max_docs?: number;
  max_bytes?: number;
  max_qps?: number;
  burst?: number;
  suspended?: boolean;
}

export interface LatencyBucket {
  le_ms: string;
  count: number;
}

export interface LatencyStats {
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  buckets?: LatencyBucket[];
}

export interface TenantUsage {
  tenant: string;
  plan?: string;
  suspended?: boolean;
  partition_count: number;
  live_docs: number;
  live_bytes: number;
  max_docs?: number;
  max_bytes?: number;
  max_qps?: number;
  read_requests: number;
  read_units: number;
  write_requests: number;
  write_units: number;
  rate_limited: number;
  search_latency: LatencyStats;
  updated_at?: string;
}

export interface UsageReport {
  tenants: TenantUsage[];
  total_live_docs: number;
  total_live_bytes: number;
  total_read_units: number;
  total_write_units: number;
}

export type DatabaseScopeOption = string | { database?: string };

export declare class MassEngineError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string);
}

export declare class MassEngineClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  constructor(options?: MassEngineOptions);
  toJSON(): { baseUrl: string };
  ingest(
    tenant: string,
    docs: Doc[],
    database?: DatabaseScopeOption
  ): Promise<{ ingested: number; degraded: boolean; database?: string }>;
  search<M = Record<string, unknown>>(req: SearchRequest): Promise<SearchResponse<M>>;
  batchSearch<M = Record<string, unknown>>(
    queries: SearchRequest[],
    options?: string | { tenant?: string; database?: string }
  ): Promise<{ results: SearchResponse<M>[] }>;
  getDoc<M = Record<string, unknown>>(
    tenant: string,
    id: string,
    database?: DatabaseScopeOption
  ): Promise<{ id: string; tenant: string; database?: string; date?: number; category?: number; metadata?: M }>;
  patchDoc<M = Record<string, unknown>>(
    tenant: string,
    id: string,
    patch: PatchRequest<M>,
    database?: DatabaseScopeOption
  ): Promise<{
    id: string;
    tenant?: string;
    database?: string;
    date?: number;
    category?: number;
    degraded?: boolean;
    metadata?: M;
  }>;
  batchGetDocs<M = Record<string, unknown>>(
    tenant: string,
    ids: string[],
    database?: DatabaseScopeOption
  ): Promise<Array<{ id: string; tenant: string; database?: string; date?: number; category?: number; metadata?: M }>>;
  deleteDoc(
    tenant: string,
    id: string,
    database?: DatabaseScopeOption
  ): Promise<{ deleted: boolean; id: string; database?: string }>;
  importTenant(tenant: string, docs: Doc[], database?: DatabaseScopeOption): Promise<number>;
  exportTenant<M = Record<string, unknown>>(tenant?: string, database?: DatabaseScopeOption): Promise<Doc<M>[]>;
  listDatabases(tenant?: string): Promise<DatabaseInfo[]>;
  createDatabase(tenant: string, config: DatabaseConfig): Promise<DatabaseInfo>;
  createDatabase(config: DatabaseConfig): Promise<DatabaseInfo>;
  getDatabase(tenant: string, database: string): Promise<DatabaseInfo>;
  deleteDatabase(tenant: string, database: string): Promise<number>;
  createTenantKey(tenant: string, key?: string): Promise<string>;
  revokeTenantKey(tenant: string, key: string): Promise<{ revoked: boolean }>;
  setTenantQuota(tenant: string, quota: TenantQuota): Promise<TenantQuota>;
  getTenantQuota(tenant: string): Promise<TenantQuota>;
  getTenantUsage(tenant: string): Promise<TenantUsage>;
  listUsage(): Promise<UsageReport>;
  listTenants(): Promise<TenantSummary[]>;
  getTenant(tenant: string, database?: DatabaseScopeOption): Promise<TenantSummary>;
  deleteTenant(tenant: string): Promise<number>;
  flush(): Promise<{ flushed: boolean }>;
  compact(): Promise<{ compacted: boolean }>;
  ready(): Promise<{ ready: boolean; unavailable_shards?: number[] }>;
  health(): Promise<{ status: string; ok?: boolean }>;
}
