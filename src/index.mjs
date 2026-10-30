export class MassEngineError extends Error {
  constructor(statusCode, message) {
    super(`massengine api (status ${statusCode}): ${message}`);
    this.name = "MassEngineError";
    this.statusCode = statusCode;
  }
}

export class MassEngineClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "http://localhost:8081").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this._fetch = options.fetch || globalThis.fetch.bind(globalThis);
  }

  _headers(contentType = "application/json") {
    const hdrs = {};
    if (contentType) {
      hdrs["Content-Type"] = contentType;
    }
    if (this.apiKey) {
      hdrs["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return hdrs;
  }

  async _requestJson(method, path, body) {
    const init = {
      method,
      headers: this._headers(body !== undefined ? "application/json" : null),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await this._fetch(`${this.baseUrl}${path}`, init);
    if (!resp.ok) {
      const raw = await resp.text();
      let msg = raw.trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.error) {
          msg = String(parsed.error);
        }
      } catch {}
      throw new MassEngineError(resp.status, msg);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async ingest(tenant, docs) {
    return this._requestJson(
      "POST",
      `/v1/tenants/${encodeURIComponent(tenant)}/ingest`,
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
      `/v1/tenants/${encodeURIComponent(tenant)}/docs/${encodeURIComponent(id)}`
    );
  }

  async patchDoc(tenant, id, patch) {
    return this._requestJson(
      "PATCH",
      `/v1/tenants/${encodeURIComponent(tenant)}/docs/${encodeURIComponent(id)}`,
      patch
    );
  }

  async batchGetDocs(tenant, ids) {
    const res = await this._requestJson(
      "POST",
      `/v1/tenants/${encodeURIComponent(tenant)}/docs/batch-get`,
      { ids }
    );
    return res?.docs || [];
  }

  async deleteDoc(tenant, id) {
    return this._requestJson(
      "DELETE",
      `/v1/tenants/${encodeURIComponent(tenant)}/docs/${encodeURIComponent(id)}`
    );
  }

  async importTenant(tenant, docs) {
    const payload = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    const resp = await this._fetch(
      `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenant)}/import`,
      {
        method: "POST",
        headers: this._headers("application/x-ndjson"),
        body: payload,
      }
    );
    if (!resp.ok) {
      const raw = await resp.text();
      let msg = raw.trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.error) msg = String(parsed.error);
      } catch {}
      throw new MassEngineError(resp.status, msg);
    }
    const out = await resp.json();
    return Number(out.imported || 0);
  }

  async exportTenant(tenant) {
    const resp = await this._fetch(
      `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenant)}/export`,
      {
        method: "GET",
        headers: this._headers(null),
      }
    );
    if (!resp.ok) {
      const raw = await resp.text();
      throw new MassEngineError(resp.status, raw.trim());
    }
    const text = await resp.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async createTenantKey(tenant, key = "") {
    const res = await this._requestJson(
      "POST",
      `/v1/tenants/${encodeURIComponent(tenant)}/keys`,
      { key }
    );
    return res.key;
  }

  async revokeTenantKey(tenant, key) {
    return this._requestJson(
      "DELETE",
      `/v1/tenants/${encodeURIComponent(tenant)}/keys`,
      { key }
    );
  }

  async setTenantQuota(tenant, quota) {
    const res = await this._requestJson(
      "PUT",
      `/v1/tenants/${encodeURIComponent(tenant)}/quota`,
      quota
    );
    return res.quota || res;
  }

  async getTenantQuota(tenant) {
    const res = await this._requestJson(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenant)}/quota`
    );
    return res.quota || res;
  }

  async getTenantUsage(tenant) {
    return this._requestJson(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenant)}/usage`
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
    return this._requestJson(
      "GET",
      `/v1/tenants/${encodeURIComponent(tenant)}`
    );
  }

  async deleteTenant(tenant) {
    const res = await this._requestJson(
      "DELETE",
      `/v1/tenants/${encodeURIComponent(tenant)}`
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
