const SDK_VERSION = "1.1.4";
const USER_AGENT = `massengine-ts/${SDK_VERSION}`;
const DEFAULT_BASE_URL = "http://localhost:8081";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

function esc(segment) {
  if (
    typeof segment !== "string" ||
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    /[\x00-\x1f\x7f]/.test(segment)
  ) {
    throw new TypeError("Invalid URL path segment");
  }
  return encodeURIComponent(segment);
}

function escTenant(tenant) {
  if (typeof tenant !== "string" || tenant.includes("/") || tenant.includes("\\")) {
    throw new TypeError("Invalid tenant identifier");
  }
  return esc(tenant);
}

function escDatabase(database) {
  if (typeof database !== "string" || database.includes("/") || database.includes("\\")) {
    throw new TypeError("Invalid database identifier");
  }
  return esc(database);
}

function escOptionalTenant(tenant, allowUndefined = false) {
  if (allowUndefined && tenant === undefined) {
    return "";
  }
  if (tenant === "") {
    return "";
  }
  return escTenant(tenant);
}

function resolveDatabaseOption(optionOrDb) {
  if (optionOrDb === undefined || optionOrDb === "") {
    return "";
  }
  if (typeof optionOrDb === "string") {
    escDatabase(optionOrDb);
    return optionOrDb;
  }
  if (optionOrDb !== null && typeof optionOrDb === "object") {
    const db = optionOrDb.database;
    if (db === undefined || db === "") {
      return "";
    }
    escDatabase(db);
    return db;
  }
  throw new TypeError("Invalid database option");
}

function appendDatabaseQuery(basePath, database) {
  if (!database) {
    return basePath;
  }
  return `${basePath}?database=${escDatabase(database)}`;
}

function escDocId(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Invalid document identifier");
  }
  if (id === "batch-get") {
    throw new TypeError("Reserved document identifier");
  }
  return id.split("/").map(esc).join("/");
}

function validateDocs(docs) {
  if (!Array.isArray(docs)) {
    throw new TypeError("docs must be an array");
  }
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") {
      throw new TypeError("Each document must be an object");
    }
    escDocId(doc.id);
    if (doc.database !== undefined && doc.database !== "") {
      escDatabase(doc.database);
    }
  }
}

function validateSearchQuery(req) {
  if (!req || typeof req !== "object") {
    throw new TypeError("Search request must be an object");
  }
  if (!Array.isArray(req.vector) || req.vector.length === 0) {
    throw new TypeError("Search vector must be a non-empty array");
  }
  if (req.tenant !== undefined && req.tenant !== "") {
    escTenant(req.tenant);
  }
  if (req.database !== undefined && req.database !== "") {
    escDatabase(req.database);
  }
}

function extractErrorMessage(rawText) {
  let msg = rawText.trim();
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && parsed.error) {
      msg = String(parsed.error);
    }
  } catch {}
  return msg;
}

function validateBaseUrl(rawBase) {
  const input = rawBase === undefined ? DEFAULT_BASE_URL : rawBase;
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("baseUrl must be a valid http or https URL");
  }
  const cleaned = input.trim().replace(/\/+$/, "");
  if (/[\x00-\x20\x7f]/.test(cleaned)) {
    throw new TypeError("baseUrl contains invalid characters");
  }
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new TypeError("baseUrl must be a valid http or https URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.host ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("baseUrl must use http: or https: scheme with a valid host");
  }
  return cleaned;
}

function validateApiKey(rawKey) {
  if (rawKey === undefined || rawKey === null || rawKey === "") {
    return undefined;
  }
  if (typeof rawKey !== "string") {
    throw new TypeError("Invalid apiKey format");
  }
  const trimmed = rawKey.replace(/^[ \t]+|[ \t]+$/g, "");
  if (trimmed.length === 0 || !/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new TypeError("Invalid apiKey format");
  }
  return trimmed;
}

async function readResponseTextBounded(resp, maxBytes, truncate = false) {
  const cl = resp.headers?.get?.("content-length");
  if (!truncate && cl !== null && cl !== undefined) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await resp.body?.cancel?.();
      } catch {}
      throw new MassEngineError(
        resp.status || 200,
        `Response body exceeds maxResponseBytes (${maxBytes})`
      );
    }
  }

  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (truncate) {
          const remaining = maxBytes - total;
          if (remaining <= 0) {
            await reader.cancel();
            break;
          }
          if (bytes.byteLength > remaining) {
            chunks.push(bytes.subarray(0, remaining));
            total += remaining;
            await reader.cancel();
            break;
          }
          chunks.push(bytes);
          total += bytes.byteLength;
        } else {
          total += bytes.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new MassEngineError(
              resp.status || 200,
              `Response body exceeds maxResponseBytes (${maxBytes})`
            );
          }
          chunks.push(bytes);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(merged);
  }

  const text = await resp.text();
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > maxBytes) {
    if (truncate) {
      return new TextDecoder("utf-8").decode(encoded.subarray(0, maxBytes));
    }
    throw new MassEngineError(
      resp.status || 200,
      `Response body exceeds maxResponseBytes (${maxBytes})`
    );
  }
  return text;
}

export class MassEngineError extends Error {
  constructor(statusCode, message) {
    super(`massengine api (status ${statusCode}): ${message}`);
    this.name = "MassEngineError";
    this.statusCode = statusCode;
  }
}

export class MassEngineClient {
  #apiKey;
  #fetch;

  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.#apiKey = validateApiKey(options.apiKey);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive finite number");
    }
    this.timeoutMs = timeoutMs;

    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      typeof maxResponseBytes !== "number" ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes <= 0
    ) {
      throw new TypeError("maxResponseBytes must be a positive integer");
    }
    this.maxResponseBytes = maxResponseBytes;

    this.#fetch = options.fetch || globalThis.fetch.bind(globalThis);
  }

  toJSON() {
    return { baseUrl: this.baseUrl };
  }

  _headers(contentType = "application/json") {
    const hdrs = { "User-Agent": USER_AGENT };
    if (contentType) {
      hdrs["Content-Type"] = contentType;
    }
    if (this.#apiKey) {
      hdrs["Authorization"] = `Bearer ${this.#apiKey}`;
    }
    return hdrs;
  }

  async #unwrapError(resp) {
    const raw = await readResponseTextBounded(resp, MAX_ERROR_RESPONSE_BYTES, true);
    throw new MassEngineError(resp.status, extractErrorMessage(raw));
  }

  async #sendRaw(method, path, contentType, body) {
    const init = {
      method,
      headers: this._headers(contentType),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.body = body;
    }
    return this.#fetch(`${this.baseUrl}${path}`, init);
  }

  async #send(method, path, contentType, body) {
    const resp = await this.#sendRaw(method, path, contentType, body);
    if (!resp.ok || resp.status < 200 || resp.status >= 300) {
      await this.#unwrapError(resp);
    }
    return resp;
  }

  async _requestJson(method, path, body) {
    const resp = await this.#send(
      method,
      path,
      body !== undefined ? "application/json" : null,
      body !== undefined ? JSON.stringify(body) : undefined
    );
    const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
    return text ? JSON.parse(text) : null;
  }

  #docPath(tenant, id, database) {
    const escT = escOptionalTenant(tenant);
    const escId = escDocId(id);
    const base = escT === "" ? `/v1/docs/${escId}` : `/v1/tenants/${escT}/docs/${escId}`;
    return appendDatabaseQuery(base, database);
  }

  async ingest(tenant, docs, databaseOption) {
    const escT = escOptionalTenant(tenant);
    const db = resolveDatabaseOption(databaseOption);
    validateDocs(docs);
    const path = escT === "" ? "/v1/ingest" : `/v1/tenants/${escT}/ingest`;
    const body = db ? { database: db, docs } : { docs };
    return this._requestJson("POST", path, body);
  }

  async search(req) {
    validateSearchQuery(req);
    return this._requestJson("POST", "/v1/search", req);
  }

  async batchSearch(queries, options) {
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new TypeError("Batch search queries must be a non-empty array");
    }
    for (const q of queries) {
      validateSearchQuery(q);
    }
    let tenant = "";
    let database = "";
    if (typeof options === "string") {
      database = resolveDatabaseOption(options);
    } else if (options !== undefined && options !== null) {
      if (typeof options !== "object") {
        throw new TypeError("Invalid batchSearch options");
      }
      if (options.tenant !== undefined && options.tenant !== "") {
        escTenant(options.tenant);
        tenant = options.tenant;
      }
      database = resolveDatabaseOption(options);
    }
    const body = { queries };
    if (tenant) {
      body.tenant = tenant;
    }
    if (database) {
      body.database = database;
    }
    return this._requestJson("POST", "/v1/search/batch", body);
  }

  async getDoc(tenant, id, databaseOption) {
    const db = resolveDatabaseOption(databaseOption);
    return this._requestJson("GET", this.#docPath(tenant, id, db));
  }

  async patchDoc(tenant, id, patch, databaseOption) {
    if (!patch || typeof patch !== "object") {
      throw new TypeError("patch must be an object");
    }
    const optDb = resolveDatabaseOption(databaseOption);
    const bodyDb = patch.database !== undefined && patch.database !== "" ? patch.database : optDb;
    if (bodyDb) {
      escDatabase(bodyDb);
    }
    const payload = bodyDb ? { ...patch, database: bodyDb } : patch;
    return this._requestJson("PATCH", this.#docPath(tenant, id, ""), payload);
  }

  async batchGetDocs(tenant, ids, databaseOption) {
    const escT = escOptionalTenant(tenant);
    const db = resolveDatabaseOption(databaseOption);
    if (!Array.isArray(ids)) {
      throw new TypeError("ids must be an array");
    }
    for (const id of ids) {
      escDocId(id);
    }
    const path = escT === "" ? "/v1/docs/batch-get" : `/v1/tenants/${escT}/docs/batch-get`;
    const body = db ? { ids, database: db } : { ids };
    const res = await this._requestJson("POST", path, body);
    return res?.docs || [];
  }

  async deleteDoc(tenant, id, databaseOption) {
    const db = resolveDatabaseOption(databaseOption);
    return this._requestJson("DELETE", this.#docPath(tenant, id, db));
  }

  async importTenant(tenant, docs, databaseOption) {
    const escT = escOptionalTenant(tenant);
    const db = resolveDatabaseOption(databaseOption);
    validateDocs(docs);
    const basePath = escT === "" ? "/v1/import" : `/v1/tenants/${escT}/import`;
    const path = appendDatabaseQuery(basePath, db);
    const payload = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    const resp = await this.#send("POST", path, "application/x-ndjson", payload);
    const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
    const out = text ? JSON.parse(text) : {};
    return Number(out.imported || 0);
  }

  async exportTenant(tenant = "", databaseOption) {
    const escT = escOptionalTenant(tenant, true);
    const db = resolveDatabaseOption(databaseOption);
    const basePath = escT === "" ? "/v1/export" : `/v1/tenants/${escT}/export`;
    const path = appendDatabaseQuery(basePath, db);
    const resp = await this.#send("GET", path, null, undefined);
    const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async listDatabases(tenant = "") {
    const escT = escOptionalTenant(tenant, true);
    const path = escT === "" ? "/v1/databases" : `/v1/tenants/${escT}/databases`;
    const res = await this._requestJson("GET", path);
    return res?.databases || res?.partitions || [];
  }

  async createDatabase(tenant, config) {
    let targetTenant = tenant;
    let dbConfig = config;
    if (config === undefined && tenant !== null && typeof tenant === "object") {
      targetTenant = "";
      dbConfig = tenant;
    }
    const escT = escOptionalTenant(targetTenant, true);
    if (!dbConfig || typeof dbConfig !== "object") {
      throw new TypeError("Database config must be an object");
    }
    escDatabase(dbConfig.database);
    const path = escT === "" ? "/v1/databases" : `/v1/tenants/${escT}/databases`;
    const res = await this._requestJson("POST", path, dbConfig);
    if (res && typeof res.database === "object" && res.database !== null) {
      return {
        ...res.database,
        database: res.database.database || res.partition || dbConfig.database,
      };
    }
    return res;
  }

  async getDatabase(tenant, database) {
    const escT = escOptionalTenant(tenant, true);
    const escDb = escDatabase(database);
    const path = escT === "" ? `/v1/databases/${escDb}` : `/v1/tenants/${escT}/databases/${escDb}`;
    try {
      const res = await this._requestJson("GET", path);
      if (res && typeof res.database === "object" && res.database !== null) {
        return { ...res.database, database: res.database.database || database };
      }
      return res && typeof res === "object" ? { ...res, database: res.database || database } : res;
    } catch (err) {
      if (!(err instanceof MassEngineError) || err.statusCode !== 405) {
        throw err;
      }
      const dbs = await this.listDatabases(tenant);
      const match = dbs.find((d) => d.database === database || d.partition === database);
      if (!match) {
        throw new MassEngineError(404, "database not found");
      }
      return match;
    }
  }

  async deleteDatabase(tenant, database) {
    const escT = escOptionalTenant(tenant, true);
    const escDb = escDatabase(database);
    const path = escT === "" ? `/v1/databases/${escDb}` : `/v1/tenants/${escT}/databases/${escDb}`;
    const res = await this._requestJson("DELETE", path);
    return Number(res?.docs_deleted || 0);
  }

  async createTenantKey(tenant, key = "") {
    const res = await this._requestJson(
      "POST",
      `/v1/tenants/${escTenant(tenant)}/keys`,
      { key }
    );
    return res.key;
  }

  async revokeTenantKey(tenant, key) {
    return this._requestJson(
      "DELETE",
      `/v1/tenants/${escTenant(tenant)}/keys`,
      { key }
    );
  }

  async setTenantQuota(tenant, quota) {
    const res = await this._requestJson(
      "PUT",
      `/v1/tenants/${escTenant(tenant)}/quota`,
      quota
    );
    return res.quota || res;
  }

  async getTenantQuota(tenant) {
    const res = await this._requestJson(
      "GET",
      `/v1/tenants/${escTenant(tenant)}/quota`
    );
    return res.quota || res;
  }

  async getTenantUsage(tenant) {
    return this._requestJson(
      "GET",
      `/v1/tenants/${escTenant(tenant)}/usage`
    );
  }

  async listUsage() {
    return this._requestJson("GET", "/v1/usage");
  }

  async listTenants() {
    const res = await this._requestJson("GET", "/v1/tenants");
    return res?.tenants || [];
  }

  async getTenant(tenant, databaseOption) {
    const db = resolveDatabaseOption(databaseOption);
    const path = appendDatabaseQuery(`/v1/tenants/${escTenant(tenant)}`, db);
    return this._requestJson("GET", path);
  }

  async deleteTenant(tenant) {
    const res = await this._requestJson(
      "DELETE",
      `/v1/tenants/${escTenant(tenant)}`
    );
    return Number(res?.docs_deleted || 0);
  }

  async flush() {
    return this._requestJson("POST", "/v1/flush");
  }

  async compact() {
    return this._requestJson("POST", "/v1/compact");
  }

  async ready() {
    const resp = await this.#sendRaw("GET", "/v1/ready", null, undefined);
    if ((resp.status >= 200 && resp.status < 300) || resp.status === 503) {
      const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new MassEngineError(resp.status, extractErrorMessage(text));
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.ready !== "boolean") {
        throw new MassEngineError(resp.status, extractErrorMessage(text));
      }
      return parsed;
    }
    await this.#unwrapError(resp);
  }

  async health() {
    return this._requestJson("GET", "/v1/health");
  }
}
