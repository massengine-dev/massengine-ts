const SDK_VERSION = "1.1.2";
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

function escDocId(id) {
  if (id === "batch-get") {
    throw new TypeError("Reserved document identifier");
  }
  return esc(id);
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
    let msg = raw.trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error) {
        msg = String(parsed.error);
      }
    } catch {}
    throw new MassEngineError(resp.status, msg);
  }

  async #send(method, path, contentType, body) {
    const init = {
      method,
      headers: this._headers(contentType),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.body = body;
    }
    const resp = await this.#fetch(`${this.baseUrl}${path}`, init);
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

  async ingest(tenant, docs) {
    return this._requestJson(
      "POST",
      `/v1/tenants/${escTenant(tenant)}/ingest`,
      { docs }
    );
  }

  async search(req) {
    return this._requestJson("POST", "/v1/search", req);
  }

  async batchSearch(queries) {
    return this._requestJson("POST", "/v1/search/batch", { queries });
  }

  async getDoc(tenant, id) {
    return this._requestJson(
      "GET",
      `/v1/tenants/${escTenant(tenant)}/docs/${escDocId(id)}`
    );
  }

  async patchDoc(tenant, id, patch) {
    return this._requestJson(
      "PATCH",
      `/v1/tenants/${escTenant(tenant)}/docs/${escDocId(id)}`,
      patch
    );
  }

  async batchGetDocs(tenant, ids) {
    const res = await this._requestJson(
      "POST",
      `/v1/tenants/${escTenant(tenant)}/docs/batch-get`,
      { ids }
    );
    return res?.docs || [];
  }

  async deleteDoc(tenant, id) {
    return this._requestJson(
      "DELETE",
      `/v1/tenants/${escTenant(tenant)}/docs/${escDocId(id)}`
    );
  }

  async importTenant(tenant, docs) {
    const payload = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    const resp = await this.#send(
      "POST",
      `/v1/tenants/${escTenant(tenant)}/import`,
      "application/x-ndjson",
      payload
    );
    const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
    const out = text ? JSON.parse(text) : {};
    return Number(out.imported || 0);
  }

  async exportTenant(tenant) {
    const resp = await this.#send(
      "GET",
      `/v1/tenants/${escTenant(tenant)}/export`,
      null,
      undefined
    );
    const text = await readResponseTextBounded(resp, this.maxResponseBytes, false);
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
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

  async getTenant(tenant) {
    return this._requestJson("GET", `/v1/tenants/${escTenant(tenant)}`);
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
    return this._requestJson("GET", "/v1/ready");
  }

  async health() {
    return this._requestJson("GET", "/v1/health");
  }
}
