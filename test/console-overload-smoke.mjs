import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOUR_MS, OVERLOAD_MESSAGE } from "../src/overload-monitor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-overload-http-"));
const output = path.join(temp, "output");
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const emails = ["overload@example.test", "paused@example.test"];
const records = [7, 8, 9].map((id, index) => ({ id, platform: "openai", type: "oauth", name: emails[index === 2 ? 1 : 0], status: "active", credentials: { email: emails[index === 2 ? 1 : 0] }, extra: {}, group_ids: [] }));
const counts = [0, 2, 5, 1, 3, 0];
const requestCounts = [198, 204, 210, 202, 196, 200];
const logRequests = [];
let child;
let headers;
let logs = "";
const remote = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.headers["x-api-key"] !== "fixture-admin-key") { res.statusCode = 401; return res.end("{}"); }
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: records, pages: 1, total: records.length } }));
  if (url.pathname === "/api/v1/admin/ops/requests") {
    const accountId = Number(url.searchParams.get("account_id"));
    const start = Date.parse(url.searchParams.get("start_time"));
    const page = Number(url.searchParams.get("page"));
    const items = accountId === 7 ? requestCounts.flatMap((count, index) => Array.from({ length: count }, (_, number) => ({
      request_id: `request-${index}-${number}`, account_id: accountId, kind: number % 2 ? "success" : "error",
      created_at: new Date(start + index * HOUR_MS + 10_000 + number).toISOString(),
    }))) : [];
    return res.end(JSON.stringify({ data: { items: items.slice((page - 1) * 100, page * 100), total: items.length } }));
  }
  if (url.pathname === "/api/v1/admin/ops/upstream-errors") {
    logRequests.push(url);
    const accountId = Number(url.searchParams.get("account_id"));
    const start = Date.parse(url.searchParams.get("start_time"));
    const items = accountId === 7 ? counts.flatMap((count, index) => Array.from({ length: count }, (_, number) => ({
      id: index * 100 + number + 1, account_id: accountId, status_code: 503,
      message: OVERLOAD_MESSAGE, created_at: new Date(start + index * HOUR_MS + 10_000 + number).toISOString(),
    }))) : [];
    return res.end(JSON.stringify({ data: { items, total: items.length, page: 1, page_size: 500, pages: 1 } }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture-admin-key", groupIds: [] };
const slot = http.createServer();
await new Promise((resolve) => slot.listen(0, "127.0.0.1", resolve));
const port = slot.address().port;
await new Promise((resolve) => slot.close(resolve));
const base = `http://127.0.0.1:${port}`;

async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  for (let index = 0; index < 150; index++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const data = await (await fetch(`${base}/api/bootstrap`)).json();
      headers = { "x-console-token": data.token, "content-type": "application/json" };
      assert.equal(data.features.overloadDetection, true);
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(logs || "startup timeout");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM"); await exited;
}
async function job(id = ids[0]) {
  const response = await fetch(`${base}/api/jobs`, { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  return data.jobs.find((item) => item.id === id);
}
async function toggle(enabled, { id = ids[0], expected = 200, authorized = true } = {}) {
  const response = await fetch(`${base}/api/jobs/${id}/overload-detection`, {
    method: "POST", headers: authorized ? headers : { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
  });
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}
async function populated() {
  for (let i = 0; i < 100; i++) {
    const entry = await job();
    if (entry.overloadDetection.updatedAt && entry.overloadDetection.points.every((point) => point.count !== null && point.requestCount !== null)) return entry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`statistics timeout ${logs}`);
}

try {
  for (let index = 0; index < ids.length; index++) {
    const dir = path.join(output, ids[index]);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ email: emails[index], status: "completed", plan_type: "plus", pool_only: true, created_at: new Date().toISOString() }));
    await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ name: emails[index], platform: "openai", type: "oauth", credentials: { email: emails[index], plan_type: "plus" }, extra: { email: emails[index], plan_type: "plus" } }] }));
  }
  await start();
  assert.equal((await job()).overloadDetection.configured, false);
  await toggle(true, { expected: 409 });
  await stop();
  await fs.writeFile(path.join(output, "sub2api-settings.json"), JSON.stringify(config));
  await start();
  assert.equal((await job()).overloadDetection.enabled, false);
  assert.equal(logRequests.length, 0, "default-off creates no log requests");
  await toggle(true, { authorized: false, expected: 403 });
  await toggle("true", { expected: 400 });
  await toggle(true, { id: "33333333-3333-4333-8333-333333333333", expected: 404 });
  await toggle(true);
  const entry = await populated();
  assert.deepEqual(entry.overloadDetection.points.map((point) => point.count), counts);
  assert.deepEqual(entry.overloadDetection.points.map((point) => point.requestCount), requestCounts);
  assert.equal((await job(ids[1])).overloadDetection.enabled, false);
  assert(logRequests.every((url) => ["7", "8"].includes(url.searchParams.get("account_id"))), "each remote account for this email is included");
  assert(logRequests.every((url) => url.searchParams.get("status_codes") === "503"));
  assert.equal(new Date(entry.overloadDetection.points.at(-1).end).getMinutes(), 0);
  await toggle(false);
  assert.equal((await job()).overloadDetection.enabled, false);
  const saved = JSON.parse(await fs.readFile(path.join(output, "overload-monitor.json"), "utf8"));
  assert.equal(saved.accounts[emails[0]].enabled, false);
  assert.deepEqual(saved.accounts[emails[0]].points.map((point) => point.count), counts);
  await stop(); await start();
  assert.equal((await job()).overloadDetection.enabled, false);
  assert.deepEqual((await job()).overloadDetection.points.map((point) => point.count), counts);
  assert.deepEqual((await job()).overloadDetection.points.map((point) => point.requestCount), requestCounts, "request history survives restart");
  await toggle(true);
  await populated();
  await stop(); await start(); await populated();
  assert.equal((await job()).overloadDetection.enabled, true);
  await toggle(false);
  const settingsResponse = await fetch(`${base}/api/task-settings`, { method: "POST", headers, body: JSON.stringify({
    autoActions: { plus: ["enable-overload-detection"] },
  }) });
  assert.equal(settingsResponse.status, 200);
  const imported = await fetch(`${base}/api/jobs/batch`, { method: "POST", headers, body: JSON.stringify({ text: emails[0] }) });
  assert.equal(imported.status, 201, await imported.clone().text());
  for (let i = 0; i < 100; i++) {
    const entry = await job();
    if (entry.overloadDetection.enabled && entry.autoTaskStatus === "completed") break;
    if (i === 99) throw new Error(`automatic detection did not complete: ${JSON.stringify({ status: entry.autoTaskStatus, error: entry.autoTaskError, plan: entry.planType })}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await job(ids[1])).overloadDetection.enabled, false, "auto action affects only imported account");
  await populated();
  console.log("PASS: overload HTTP auth, validation, six-hour overload+request counts, success+failure pagination, switch/history persistence, enabled restart/backfill, imported PlanType auto-enables detection and isolates other accounts");
  if (process.argv.includes("--serve")) {
    const metadata = { url: base, output, emails, ids };
    await fs.writeFile(path.join(root, "tmp/overload-detection-20261031/browser-fixture.json"), JSON.stringify(metadata, null, 2));
    console.log(`UI_FIXTURE=${base}`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally {
  await stop();
  await new Promise((resolve) => remote.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
