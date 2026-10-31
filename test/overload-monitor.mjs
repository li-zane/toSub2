import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { completedHours, collectOverloadHours, collectRequestHours, OverloadMonitor, OVERLOAD_MESSAGE, HOUR_MS } from "../src/overload-monitor.mjs";
import { buildOverloadChart } from "../web/src/overload-chart.mjs";

const now = Date.parse("2026-10-31T03:00:00+08:00");
const end = Math.floor(now / HOUR_MS) * HOUR_MS;
const start = end - 6 * HOUR_MS;
assert.equal(completedHours(now).length, 6);
assert.equal(completedHours(now - 1).at(-1).end, new Date(end - HOUR_MS).toISOString());
assert.equal(completedHours(now).at(-1).start, "2026-10-30T18:00:00.000Z");
assert.equal(completedHours(now).at(-1).end, "2026-10-30T19:00:00.000Z");
const row = (id, offset, fields = {}) => ({ id, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE, created_at: new Date(start + offset).toISOString(), ...fields });
const rows = [
  row(1, 0), row(2, HOUR_MS - 1), row(3, HOUR_MS), row(4, 2 * HOUR_MS),
  row(5, 3 * HOUR_MS), row(6, 4 * HOUR_MS), row(7, 6 * HOUR_MS - 1),
  row(8, 6 * HOUR_MS), row(9, -1),
  row(10, 2, { status_code: 502 }), row(11, 2, { account_id: 123 }),
  row(12, 2, { message: "other 503" }), row(13, 2, { message: "generic upstream failure" }),
  row(14, 2, { message: "unrelated 503", resolved: true }),
];
const calls = [];
const request = async (_config, endpoint) => {
  calls.push(endpoint);
  const url = new URL(endpoint, "https://fixture.test");
  if (/\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").at(-1));
    return { data: { ...rows.find((item) => item.id === id), error_body: id === 13 ? JSON.stringify({ error: { message: OVERLOAD_MESSAGE } }) : "unrelated" } };
  }
  assert.equal(url.searchParams.get("start_time"), new Date(start).toISOString());
  assert.equal(url.searchParams.get("end_time"), new Date(end).toISOString());
  assert.equal(url.searchParams.get("status_codes"), "503");
  assert.equal(url.searchParams.get("view"), "all");
  const page = Number(url.searchParams.get("page"));
  // Small pages exercise pagination even when the server caps the requested page size.
  return { data: { items: rows.slice((page - 1) * 5, page * 5), total: rows.length } };
};
const points = await collectOverloadHours({ config: {}, accountIds: [7, 7], request, now });
assert.deepEqual(points.map((point) => point.count), [3, 1, 1, 1, 1, 1]);
assert.equal(calls.filter((call) => call.includes("page=")).length, 3);
assert(calls.some((call) => call.endsWith("/13")), "generic list message needs upstream detail");

let fallbackCalls = 0;
await collectOverloadHours({ config: {}, accountIds: [7], now, request: async (_c, endpoint) => {
  fallbackCalls += 1;
  if (endpoint.includes("upstream-errors")) throw Object.assign(new Error("missing"), { remoteStatus: 404 });
  assert(endpoint.startsWith("/api/v1/admin/ops/errors?"));
  return { data: { items: [], total: 0 } };
} });
assert.equal(fallbackCalls, 2);
for (const remoteStatus of [401, 403, 500, 503]) {
  await assert.rejects(collectOverloadHours({ config: {}, accountIds: [7], now, request: async () => { throw Object.assign(new Error(`upstream-${remoteStatus}`), { remoteStatus }); } }), new RegExp(`upstream-${remoteStatus}`));
}
for (const payload of [{ data: {} }, { data: { items: [], total: 2 } }, { data: { items: [], total: null } }, { data: { items: [], total: "" } }]) {
  await assert.rejects(collectOverloadHours({ config: {}, accountIds: [7], now, request: async () => payload }));
}
let dedupeCalls = 0;
const duplicate = await collectOverloadHours({ config: {}, accountIds: [7, 8], now, request: async (_c, endpoint) => {
  const url = new URL(endpoint, "https://fixture.test");
  const id = Number(url.searchParams.get("account_id"));
  dedupeCalls += 1;
  return { data: { total: 2, items: [row(id, 1, { account_id: id }), row(id, 1, { account_id: id })] } };
} });
assert.equal(dedupeCalls, 2);
assert.equal(duplicate[0].count, 2, "deduplicate the same log, sum distinct remote accounts");

const requestRows = [
  { account_id: 7, kind: "success", request_id: "success-1", created_at: new Date(start).toISOString() },
  { account_id: 7, kind: "error", request_id: "failed-1", created_at: new Date(start + HOUR_MS - 1).toISOString() },
  { account_id: 7, kind: "success", request_id: "success-2", created_at: new Date(start + HOUR_MS).toISOString() },
  { account_id: 7, kind: "success", request_id: "at-end", created_at: new Date(end).toISOString() },
  { account_id: 7, kind: "success", request_id: "too-old", created_at: new Date(start - 1).toISOString() },
  { account_id: 9, kind: "success", request_id: "other-account", created_at: new Date(start).toISOString() },
];
requestRows.push(requestRows[0]);
const requestPoints = await collectRequestHours({ config: {}, accountIds: [7, 7, 8], now, request: async (_config, endpoint) => {
  const url = new URL(endpoint, "https://fixture.test");
  assert.equal(url.pathname, "/api/v1/admin/ops/requests");
  assert.equal(url.searchParams.get("kind"), "all");
  assert.equal(url.searchParams.get("start_time"), new Date(start).toISOString());
  assert.equal(url.searchParams.get("end_time"), new Date(end).toISOString());
  const accountId = Number(url.searchParams.get("account_id"));
  const page = Number(url.searchParams.get("page"));
  const items = accountId === 7 ? requestRows : [{ account_id: 8, kind: "success", request_id: "another-id", created_at: new Date(start + 3 * HOUR_MS).toISOString() }];
  return { data: { items: items.slice((page - 1) * 3, page * 3), total: items.length } };
} });
assert.deepEqual(requestPoints.map((point) => point.requestCount), [2, 1, 0, 1, 0, 0], "success and errors, pagination, request-ID dedup, half-open buckets and multiple account IDs");
await assert.rejects(collectRequestHours({ config: {}, accountIds: [7], now, request: async () => ({ data: { items: [], total: null } }) }));
const chart = buildOverloadChart([
  { count: 10, requestCount: 200 }, { count: 20, requestCount: 210 }, { count: 0, requestCount: 0 },
  { count: null, requestCount: 190 }, { count: 15, requestCount: null },
]);
assert.equal(chart.positioned[1].y, chart.positioned[1].requestY, "both independent maxima occupy the same height");
assert.equal(chart.positioned[1].y, 10);
assert.equal(chart.positioned[0].y, 27);
assert(chart.positioned[0].requestY < 12, "200 requests are scaled independently of 20 overloads");
assert.equal(chart.positioned[2].y, 44);
assert.equal(chart.positioned[2].requestY, 44);
assert.equal(chart.positioned[3].y, null);
assert.equal(chart.positioned[4].requestY, null);
assert.equal(chart.overloadSegments.length, 2, "unknown values split the line");
assert.equal(chart.positioned[0].requestCount, 200, "plot scaling does not change raw tooltip values");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "overload-monitor-unit-"));
try {
  let clock = now;
  let backend = "one";
  let fail = false;
  let failRequests = false;
  let hold = null;
  let requests = 0;
  const filePath = path.join(root, "overload-monitor.json");
  const options = {
    filePath, now: () => clock, getConfig: () => ({ baseUrl: backend, adminApiKey: "test" }), backendIdentity: (config) => config.baseUrl,
    listAccounts: async () => new Map([["first@example.test", [7]], ["second@example.test", [8]]]),
    request: async (_config, endpoint) => { requests += 1; if (hold) await hold; if (fail) throw new Error("fixture outage"); if (failRequests && endpoint.includes("/ops/requests?")) throw new Error("request fixture outage"); return { data: { total: 0, items: [] } }; },
  };
  const monitor = new OverloadMonitor(options);
  await monitor.load();
  assert.equal(monitor.snapshot("first@example.test").enabled, false);
  await monitor.setEnabled("FIRST@example.test", true);
  assert.equal(monitor.snapshot("first@example.test").revision, 1);
  assert(monitor.snapshot("first@example.test").points.every((point) => point.count === null));
  await monitor.refresh();
  assert.deepEqual(monitor.snapshot("first@example.test").points.map((point) => point.count), [0, 0, 0, 0, 0, 0]);
  assert.equal(monitor.snapshot("second@example.test").enabled, false);
  clock += HOUR_MS;
  fail = true;
  await monitor.refresh();
  assert.equal(monitor.snapshot("first@example.test").points.at(-1).count, null, "failed fetch is unknown, never zero");
  assert.equal(monitor.snapshot("first@example.test").lastError, "fixture outage");
  assert.equal(monitor.snapshot("first@example.test").points[0].count, 0);
  assert.equal(monitor.snapshot("first@example.test").points.at(-1).requestCount, null);
  fail = false;
  failRequests = true;
  await monitor.refresh();
  assert.equal(monitor.snapshot("first@example.test").points.at(-1).count, 0, "request failure does not discard overload data");
  assert.equal(monitor.snapshot("first@example.test").points.at(-1).requestCount, null, "request failure is not a fabricated zero");
  assert.equal(monitor.snapshot("first@example.test").requestError, "request fixture outage");
  failRequests = false;
  fail = true;
  await monitor.setEnabled("first@example.test", false);
  const previousRequests = requests;
  await monitor.refresh();
  assert.equal(requests, previousRequests, "disabled accounts issue no log requests");
  const recovered = new OverloadMonitor(options);
  await recovered.load();
  assert.equal(recovered.snapshot("first@example.test").enabled, false);
  assert.equal(recovered.snapshot("first@example.test").revision, 2, "switch revisions persist across restart");
  assert.equal(recovered.snapshot("first@example.test").points[0].count, 0);
  await recovered.stop();
  fail = false;
  await monitor.setEnabled("first@example.test", true);
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const beforeDisable = monitor.snapshot("first@example.test").points;
  const running = monitor.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await monitor.setEnabled("first@example.test", false);
  release();
  await running;
  assert.deepEqual(monitor.snapshot("first@example.test").points, beforeDisable, "disable discards in-flight results");
  hold = null;
  await monitor.setEnabled("first@example.test", true);
  backend = "two";
  assert(monitor.snapshot("first@example.test").points.every((point) => point.count === null), "backend switch clears old counts");
  assert.equal(monitor.snapshot("first@example.test").enabled, true);
  await monitor.refresh();
  assert(monitor.snapshot("first@example.test").points.every((point) => point.count === 0));
  await monitor.remove("first@example.test");
  assert.equal(monitor.snapshot("first@example.test").enabled, false);
  await monitor.stop();
  let timer;
  let scheduledDelay;
  clock = now - 10_000;
  const scheduled = new OverloadMonitor({ ...options,
    filePath: path.join(root, "scheduled.json"),
    setTimer: (callback, delay) => { timer = callback; scheduledDelay = delay; return { unref() {} }; },
    clearTimer: () => { timer = null; },
  });
  await scheduled.setEnabled("first@example.test", true);
  scheduled.start();
  await scheduled.running;
  assert.equal(scheduledDelay, 10_000, "first wakeup targets the exact next hour");
  const previousEnd = scheduled.snapshot("first@example.test").points.at(-1).end;
  clock = now;
  timer();
  await scheduled.running;
  assert.equal(scheduledDelay, HOUR_MS, "subsequent wakeup remains aligned to the hour");
  assert.equal(Date.parse(scheduled.snapshot("first@example.test").points.at(-1).end) - Date.parse(previousEnd), HOUR_MS);
  assert(scheduled.snapshot("first@example.test").points.every((point) => point.count === 0));
  fail = true;
  clock += HOUR_MS;
  timer();
  await scheduled.running;
  assert.equal(scheduledDelay, 60_000, "transient failures retry in a minute");
  assert.equal(scheduled.snapshot("first@example.test").points.at(-1).count, null);
  fail = false;
  clock += 60_000;
  timer();
  await scheduled.running;
  assert.equal(scheduledDelay, HOUR_MS - 60_000, "retry returns to the next exact hour");
  assert.equal(scheduled.snapshot("first@example.test").points.at(-1).count, 0);
  await scheduled.stop();
  assert.equal(timer, null, "shutdown clears the hourly timer");
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log("PASS: overload and request hourly boundaries, success+failure requests, pagination/deduplication, independent chart scales/raw values/gaps, partial failure isolation, six completed hours, exact 503 message, per-account toggle, persistence/restart, disable race, backend isolation, exact-hour scheduler and retry");
