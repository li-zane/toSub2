import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-date-priority-"));
const make = (id, date, plan = "business") => ({ id, name: `date-${id}@example.com`, platform: "openai", type: "oauth", status: "active", schedulable: true, priority: 99, created_at: date, credentials: { email: `date-${id}@example.com`, plan_type: plan }, extra: { plan_type: plan }, group_ids: [] });
const records = [
  make(1, "2026-10-13T00:00:00+08:00"), make(2, "2026-10-13T12:00:00+08:00"),
  make(3, "2026-10-14T00:00:00+08:00"), make(4, "2026-10-14T05:00:00+08:00"), make(5, "2026-10-14T23:59:59+08:00"),
  make(6, "2026-10-15T00:00:00+08:00"), make(7, "2026-10-16T00:00:00+08:00"), make(8, "2026-10-17T00:00:00+08:00"),
  make(9, "2026-10-13T16:30:00Z"), make(10, "2026-10-14T01:00:00+08:00", "free"), make(11, "2026-10-18T01:00:00+08:00", "free"),
  make(12, "2026-10-20T01:00:00+08:00", "enterprise"), make(13, "invalid"),
  { ...make(14, "2026-10-12T00:00:00+08:00"), type: "apikey" },
  { ...make(15, "2026-10-11T00:00:00+08:00"), platform: "anthropic" },
  make(16, "invalid"),
];
let incomplete = false;
let failId = null;
const puts = [];
const batches = [];
const remote = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url.startsWith("/api/v1/admin/accounts?")) return res.end(JSON.stringify({ data: { items: incomplete ? null : records, pages: 1, total: records.length } }));
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const account = records.find((row) => req.url === `/api/v1/admin/accounts/${row.id}`);
  if (req.method === "PUT" && account) {
    if (account.id === failId) { res.statusCode = 500; return res.end('{"error":"fixture priority failure"}'); }
    puts.push({ id: account.id, body }); Object.assign(account, body); return res.end(JSON.stringify({ data: account }));
  }
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") {
    batches.push(...body.accounts);
    for (const account of body.accounts) records.push({ ...account, id: records.length + 20, created_at: "2026-10-18T01:00:00+08:00" });
    return res.end(JSON.stringify({ success: body.accounts.length }));
  }
  res.end("[]");
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const slot = http.createServer(); await new Promise((resolve) => slot.listen(0, "127.0.0.1", resolve));
const port = slot.address().port; await new Promise((resolve) => slot.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
let headers;
let logs = "";
const config = {
  baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture-key", priority: 111,
  profiles: [
    { id: "default", name: "默认", priority: 111 },
    { id: "business", name: "Business", importDatePriority: { enabled: true, min: 2, max: 5 } },
    { id: "free", name: "Free", importDatePriority: { enabled: true, min: 10, max: 11 } },
  ], activeProfileId: "default", planTypeBindings: { business: "business", enterprise: "business", free: "free" },
};
async function start() {
  child = spawn(process.execPath, [process.env.DATE_PRIORITY_TEST_SERVER || path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, SUB2API_MONITOR_ENABLED: "0", LOCALAPPDATA: output }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
  for (let index = 0; index < 150; index++) { try { const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json(); headers = { "x-console-token": bootstrap.token, "content-type": "application/json" }; return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
  throw new Error(logs);
}
async function stop() { if (!child || child.exitCode !== null) return; const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
async function post(route, body, status = 200) { const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data; }
async function save() { return post("/api/sub2api/settings", { config }); }
async function refresh(expected = 200) { const response = await fetch(`${base}/api/sub2api/account-status?refresh=1`, { headers }); assert.equal(response.status, expected); return response.json(); }
const priorities = () => records.filter((account) => account.id <= 15).map((account) => account.priority);
try {
  const fallbackId = "33333333-3333-4333-8333-333333333333";
  await fs.mkdir(path.join(output, fallbackId));
  await fs.writeFile(path.join(output, fallbackId, "job-meta.json"), JSON.stringify({ email: "date-16@example.com", status: "failed", created_at: "2026-10-13T02:00:00+08:00" }));
  await start();
  const saved = await save();
  if (process.env.DATE_PRIORITY_PROBE === "1") {
    console.log(JSON.stringify({ input: "PlanType business, 13日两条、14日三条、15/16/17日各一条；范围2–5；free范围10–11；enterprise共用business方案", priorities: priorities(), rule: saved.profiles?.find((profile) => profile.id === "business")?.importDatePriority ?? null, sync: saved.datePrioritySync ?? null, onlyPriorityWrites: puts.every(({ body }) => Object.keys(body).join() === "priority") }));
  } else {
  assert.deepEqual(priorities(), [2, 2, 3, 3, 3, 4, 5, 5, 3, 10, 11, 5, 99, 99, 99]);
  assert.equal(records.find((row) => row.id === 12).priority, 5, "different PlanTypes sharing a profile must share date ranks");
  assert.equal(saved.datePrioritySync.updated, 13);
  assert.equal(records.find((row) => row.id === 16).priority, 2, "known local import date is the fallback for invalid pool dates");
  assert(puts.every(({ body }) => Object.keys(body).join() === "priority"), "date sync only writes priority");
  const savedProfile = saved.profiles.find((profile) => profile.id === "business");
  assert.deepEqual(savedProfile.importDatePriority, { enabled: true, min: 2, max: 5 });
  records[11].created_at = "2026-10-14T02:00:00+08:00";
  await refresh(); assert.equal(records[11].priority, 3, "same day across two PlanTypes in one profile shares priority");
  records[11].created_at = "2026-10-12T02:00:00+08:00";
  await refresh(); assert.equal(records[11].priority, 2); assert.equal(records[0].priority, 3, "an earlier day in another PlanType shifts the shared profile ranks");
  assert.equal(records[9].priority, 10, "a different profile remains independent");
  records[11].created_at = "2026-10-20T01:00:00+08:00";
  await refresh();
  assert.equal(records.find((account) => account.id === 13).priority, 99, "unknown remote date must not use discovery time");
  const beforeRepeat = puts.length; await refresh(); assert.equal(puts.length, beforeRepeat);
  await stop(); await start();
  const restored = await (await fetch(`${base}/api/sub2api/settings`, { headers })).json();
  assert.deepEqual(restored.profiles.find((profile) => profile.id === "business").importDatePriority, { enabled: true, min: 2, max: 5 });
  config.profiles[1].importDatePriority = { enabled: true, min: 4, max: 4 };
  await save(); assert(records.filter((row) => row.id < 10).every((row) => row.priority === 4)); assert.equal(records[9].priority, 10);
  config.profiles[1].importDatePriority = { enabled: false, min: 2, max: 5 };
  config.profiles[1].priority = 7;
  await save(); assert.equal(records[0].priority, 7, "turning the rule off restores an explicitly configured fixed priority");
  records[0].priority = 77; await refresh(); assert.equal(records[0].priority, 77, "disabled mode preserves manual priorities");
  for (const rule of [{ enabled: true, min: 5, max: 2 }, { enabled: true, min: -1, max: 5 }, { enabled: true, min: 2.5, max: 5 }, { enabled: true, min: 2, max: 10001 }, { enabled: "true", min: 2, max: 5 }]) {
    await post("/api/sub2api/settings", { config: { ...config, profiles: [{ id: "default", importDatePriority: rule }] } }, 400);
  }
  config.profiles[1].importDatePriority = { enabled: true, min: 2, max: 5 };
  failId = 1; const failed = await save(); assert.equal(failed.datePrioritySync.failed, 1); assert(failed.datePrioritySync.error);
  failId = null; await refresh(); assert.equal(records[0].priority, 2);
  incomplete = true; records[0].priority = 80; await refresh(500); assert.equal(records[0].priority, 80); incomplete = false; await refresh();
  records.push(make(20, "2026-10-12T00:00:00+08:00"));
  await refresh(); assert.equal(records.find((row) => row.id === 20).priority, 2); assert.equal(records[0].priority, 3); assert.equal(records[2].priority, 4);
  records[0].credentials.plan_type = "free"; records[0].extra.plan_type = "free";
  await refresh(); assert.equal(records[0].priority, 10); assert.equal(records[9].priority, 11);
  const localId = "11111111-1111-4111-8111-111111111111";
  const directory = path.join(output, localId); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ email: "new-local@example.com", status: "completed", created_at: "2026-10-18T02:00:00+08:00" }));
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ name: "new-local@example.com", platform: "openai", type: "oauth", credentials: { email: "new-local@example.com", plan_type: "business" } }] }));
  await stop(); await start(); await fetch(`${base}/api/jobs`, { headers });
  await post("/api/sub2api/upload", { ids: [localId], config }); assert.equal(batches.at(-1).priority, 5, "new upload must use capped date rank");
  console.log("PASS: profile-scoped date ranks shared across PlanTypes, same-day grouping, ascending dates, upper cap, Shanghai timezone, independent profile ranges, toggle off, validation, save/restart, write-only-priority, retry, incomplete listing, earlier-date insertion, PlanType transition, new upload");
  }
} finally { await stop(); await new Promise((resolve) => remote.close(resolve)); await fs.rm(output, { recursive: true, force: true }); }
