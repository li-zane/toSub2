import fs from "node:fs/promises";
import path from "node:path";

export const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";
export const HOUR_MS = 60 * 60_000;
const HOURS = 6;

// Only completed, half-open hours are shown: at 03:00 the last point is [02:00, 03:00).
export function completedHours(now = Date.now()) {
  const end = Math.floor(now / HOUR_MS) * HOUR_MS;
  return Array.from({ length: HOURS }, (_, index) => ({
    start: new Date(end - (HOURS - index) * HOUR_MS).toISOString(),
    end: new Date(end - (HOURS - index - 1) * HOUR_MS).toISOString(),
    count: null,
  }));
}

function containsOverload(value) {
  if (typeof value === "string") return value.includes(OVERLOAD_MESSAGE);
  return false;
}

function isOverload(row) {
  return Number(row.upstream_status_code ?? row.status_code) === 503
    && [row.message, row.upstream_error_message, row.upstream_error_detail, row.error_body].some(containsOverload);
}

// The split upstream list includes recovered failures, so successful failovers still count.
// The legacy endpoint is used only when the split endpoint does not exist.
export async function collectOverloadHours({ config, accountIds, request, now = Date.now(), isEnabled = () => true }) {
  const points = completedHours(now);
  const start = Date.parse(points[0].start);
  const end = Date.parse(points.at(-1).end);
  const counts = Array(HOURS).fill(0);
  const seen = new Set();
  for (const accountId of new Set(accountIds.map(String))) {
    let endpoint = "/api/v1/admin/ops/upstream-errors";
    let expectedTotal = null;
    let received = 0;
    for (let page = 1; ; page += 1) {
      if (!isEnabled()) return null;
      if (page > 1000) throw new Error("运维日志分页超过上限，统计未完成");
      const query = new URLSearchParams({
        page: String(page), page_size: "500", platform: "openai", account_id: accountId,
        start_time: points[0].start, end_time: points.at(-1).end,
        status_codes: "503", view: "all", sort_by: "created_at", sort_order: "asc",
      });
      let payload;
      try {
        payload = await request(config, `${endpoint}?${query}`);
      } catch (error) {
        if (page !== 1 || error.remoteStatus !== 404 || endpoint.endsWith("/errors")) throw error;
        endpoint = "/api/v1/admin/ops/errors";
        payload = await request(config, `${endpoint}?${query}`);
      }
      const data = payload?.data ?? payload;
      if (!data || !Array.isArray(data.items)) throw new Error("运维日志响应格式无效");
      const total = Number(data.total);
      if (data.total === null || data.total === "" || !Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
        throw new Error("运维日志列表发生变化或总数无效，请重试");
      }
      expectedTotal = total;
      received += data.items.length;
      for (const item of data.items) {
        if (!isEnabled()) return null;
        if (String(item.account_id) !== accountId) continue;
        const timestamp = Date.parse(item.created_at);
        if (!Number.isFinite(timestamp)) throw new Error("运维日志缺少有效时间");
        if (timestamp < start || timestamp >= end) continue;
        if (item.id === undefined || item.id === null) throw new Error("运维日志缺少记录 ID");
        const key = String(item.id);
        if (seen.has(key)) continue;
        seen.add(key);
        let row = item;
        if (!isOverload(row) && Number(row.upstream_status_code ?? row.status_code) === 503) {
          // List rows omit the upstream body; inspect it before deciding whether to count.
          if (!isEnabled()) return null;
          const detail = await request(config, `${endpoint}/${encodeURIComponent(item.id)}`);
          row = detail?.data ?? detail;
          if (!row || String(row.id) !== String(item.id) || String(row.account_id) !== accountId) {
            throw new Error("运维日志详情与账号不匹配");
          }
        }
        if (isOverload(row)) counts[Math.floor((timestamp - start) / HOUR_MS)] += 1;
      }
      if (received >= total) break;
      if (!data.items.length) throw new Error("运维日志分页不完整");
    }
  }
  return points.map((point, index) => ({ ...point, count: counts[index] }));
}

// Count request-level success + failure records, not upstream retry/error attempts.
// Bin timestamps locally so an inclusive upstream end_time never leaks the next hour.
export async function collectRequestHours({ config, accountIds, request, now = Date.now(), isEnabled = () => true }) {
  const points = completedHours(now);
  const start = Date.parse(points[0].start);
  const end = Date.parse(points.at(-1).end);
  const counts = Array(HOURS).fill(0);
  const seen = new Set();
  for (const accountId of new Set(accountIds.map(String))) {
    let expectedTotal = null;
    let received = 0;
    for (let page = 1; ; page += 1) {
      if (!isEnabled()) return null;
      if (page > 1000) throw new Error("请求日志分页超过上限，统计未完成");
      const query = new URLSearchParams({
        page: String(page), page_size: "100", platform: "openai", account_id: accountId,
        start_time: points[0].start, end_time: points.at(-1).end,
        kind: "all", sort: "created_at_desc",
      });
      const payload = await request(config, `/api/v1/admin/ops/requests?${query}`);
      const data = payload?.data ?? payload;
      if (!data || !Array.isArray(data.items)) throw new Error("请求日志响应格式无效");
      const total = Number(data.total);
      if (data.total === null || data.total === "" || !Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
        throw new Error("请求日志列表发生变化或总数无效，请重试");
      }
      expectedTotal = total;
      received += data.items.length;
      for (const item of data.items) {
        if (String(item.account_id) !== accountId) continue;
        const timestamp = Date.parse(item.created_at);
        if (!Number.isFinite(timestamp)) throw new Error("请求日志缺少有效时间");
        if (timestamp < start || timestamp >= end) continue;
        if (!["success", "error"].includes(item.kind)) throw new Error("请求日志类型无效");
        const identity = item.request_id || (item.error_id ? `error:${item.error_id}` : null);
        if (identity) {
          const key = `${accountId}:${identity}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        counts[Math.floor((timestamp - start) / HOUR_MS)] += 1;
      }
      if (received >= total) break;
      if (!data.items.length) throw new Error("请求日志分页不完整");
    }
  }
  return points.map((point, index) => ({ ...point, requestCount: counts[index] }));
}

export class OverloadMonitor {
  constructor({ filePath, getConfig, backendIdentity, listAccounts, request, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { filePath, getConfig, backendIdentity, listAccounts, request, now, setTimer, clearTimer });
    this.backend = null;
    this.accounts = new Map();
    this.writePromise = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.stopped = false;
    this.rerun = false;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object") throw new Error("过载检测配置格式无效");
      this.backend = data.backend || null;
      for (const [email, entry] of Object.entries(data.accounts)) {
        if (entry && typeof entry.enabled === "boolean") this.accounts.set(email, {
          enabled: entry.enabled, points: Array.isArray(entry.points) ? entry.points.slice(-HOURS) : [],
          revision: Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0,
          updatedAt: entry.updatedAt || null, lastError: entry.lastError || null, requestError: entry.requestError || null,
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[warn] 过载检测配置读取失败：${error.message}`);
    }
  }

  syncBackend() {
    const config = this.getConfig();
    const backend = config?.baseUrl && config?.adminApiKey ? this.backendIdentity(config) : null;
    if (backend !== this.backend) {
      this.backend = backend;
      for (const [email, entry] of this.accounts) this.accounts.set(email, { ...entry, points: [], updatedAt: null, lastError: null, requestError: null });
    }
    return backend;
  }

  snapshot(email) {
    const configured = Boolean(this.syncBackend());
    const entry = this.accounts.get(email.toLowerCase());
    const stored = new Map((entry?.points || []).map((point) => [point.start, point]));
    return {
      configured, enabled: entry?.enabled === true, revision: entry?.revision || 0, updatedAt: entry?.updatedAt || null,
      lastError: entry?.lastError || null, requestError: entry?.requestError || null,
      points: completedHours(this.now()).map((point) => ({ ...point,
        count: stored.get(point.start)?.count ?? null, requestCount: stored.get(point.start)?.requestCount ?? null,
      })),
    };
  }

  persist() {
    const data = JSON.stringify({ version: 1, backend: this.backend, accounts: Object.fromEntries(this.accounts) }, null, 2);
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, `${data}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    });
    this.writePromise = operation;
    return operation;
  }

  async setEnabled(email, enabled) {
    this.syncBackend();
    if (enabled && !this.backend) throw new Error("请先配置 Sub2API 后端地址和管理员 API Key");
    email = email.toLowerCase();
    const previous = this.accounts.get(email);
    const entry = { ...previous, enabled, revision: (previous?.revision || 0) + 1, points: previous?.points || [], lastError: null, requestError: null };
    this.accounts.set(email, entry);
    try { await this.persist(); }
    catch (error) {
      if (this.accounts.get(email) === entry) {
        if (previous) this.accounts.set(email, previous);
        else this.accounts.delete(email);
      }
      throw error;
    }
    return this.snapshot(email);
  }

  async remove(email) {
    this.accounts.delete(email.toLowerCase());
    await this.persist();
  }

  start() {
    this.stopped = false;
    this.trigger();
  }

  trigger() {
    if (this.stopped) return;
    this.rerun = true;
    void this.refresh().catch((error) => console.warn(`[warn] 过载检测统计失败：${error.message}`));
  }

  refresh() {
    if (this.running) return this.running;
    this.clearTimer(this.timer);
    const startedHour = Math.floor(this.now() / HOUR_MS);
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.stopped) return;
      if (Math.floor(this.now() / HOUR_MS) !== startedHour) this.rerun = true;
      if (this.rerun) { this.trigger(); return; }
      const nextHour = HOUR_MS - (this.now() % HOUR_MS);
      const failed = [...this.accounts.values()].some((entry) => entry.enabled && (entry.lastError || entry.requestError));
      this.timer = this.setTimer(() => this.trigger(), failed ? Math.min(60_000, nextHour) : nextHour);
      this.timer.unref?.();
    });
    return this.running;
  }

  async run() {
    this.rerun = false;
    if (!this.syncBackend() || this.stopped) return;
    const backend = this.backend;
    const config = this.getConfig();
    const now = this.now();
    const entries = [...this.accounts].filter(([, entry]) => entry.enabled);
    if (!entries.length) return;
    let mapping;
    try { mapping = await this.listAccounts(config); }
    catch (error) {
      if (this.stopped || this.backendIdentity(this.getConfig()) !== backend) return;
      for (const [email, entry] of entries) if (this.accounts.get(email) === entry) this.accounts.set(email, { ...entry, lastError: error.message, requestError: error.message });
      await this.persist();
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const [email, entry] = entries[cursor++];
        const isEnabled = () => !this.stopped && this.accounts.get(email) === entry
          && this.getConfig() && this.backendIdentity(this.getConfig()) === backend;
        if (!isEnabled()) continue;
        try {
          const accountIds = mapping.get(email) || [];
          if (!accountIds.length) throw new Error("该账号尚未加入 Sub2API 号池");
          const options = { config, accountIds, request: this.request, now, isEnabled };
          const [overloads, requests] = await Promise.allSettled([collectOverloadHours(options), collectRequestHours(options)]);
          if (!isEnabled()) continue;
          const previous = new Map((entry.points || []).map((point) => [point.start, point]));
          const points = completedHours(now).map((point, index) => ({ ...point,
            count: overloads.status === "fulfilled" ? overloads.value?.[index].count ?? null : previous.get(point.start)?.count ?? null,
            requestCount: requests.status === "fulfilled" ? requests.value?.[index].requestCount ?? null : previous.get(point.start)?.requestCount ?? null,
          }));
          this.accounts.set(email, { ...entry, points,
            updatedAt: overloads.status === "fulfilled" || requests.status === "fulfilled" ? new Date(this.now()).toISOString() : entry.updatedAt || null,
            lastError: overloads.status === "rejected" ? String(overloads.reason?.message || overloads.reason).slice(0, 500) : null,
            requestError: requests.status === "rejected" ? String(requests.reason?.message || requests.reason).slice(0, 500) : null,
          });
        } catch (error) {
          if (isEnabled()) this.accounts.set(email, { ...entry, lastError: String(error.message).slice(0, 500), requestError: String(error.message).slice(0, 500) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
    if (this.backendIdentity(this.getConfig()) === backend) await this.persist();
  }

  async stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
    await this.running?.catch(() => {});
    await this.writePromise.catch(() => {});
  }
}
