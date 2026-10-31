import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-plan-proxy-"));
const output = path.join(temp, "output");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const tracePath = path.join(temp, "trace.jsonl");
const wrapper = path.join(temp, "protocol.mjs");
const dynamic = "http://user-sid-12345678-t-20:fixture@dynamic.invalid:8080";
const accounts = [{ id: 1, platform: "openai", type: "oauth", status: "active", proxy_id: 1, credentials: { email: "existing@example.test", plan_type: "plus" } }];
const proxies = [
  { id: 1, name: "A", protocol: "http", host: "a.invalid", port: 8080, ip_address: "198.51.100.10", status: "active" },
  { id: 2, name: "A2", protocol: "http", host: "a2.invalid", port: 8080, ip_address: "198.51.100.10", status: "active" },
  { id: 3, name: "B", protocol: "http", host: "b.invalid", port: 8080, ip_address: "198.51.100.20", status: "active" },
];
const requests = [];
let proxiesAvailable = true;
const remote = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const url = new URL(req.url, "http://fixture");
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/v1/admin/proxies/all") return send(res, proxiesAvailable ? proxies : []);
  if (url.pathname.startsWith("/api/v1/admin/proxies/")) return send(res, { data: proxies.find((item) => item.id === Number(url.pathname.split("/").at(-1))) });
  if (url.pathname === "/api/v1/admin/groups/all") return send(res, []);
  if (url.pathname === "/api/v1/admin/accounts" && req.method === "GET") return send(res, { data: { items: accounts, total: accounts.length, pages: 1 } });
  if (url.pathname === "/api/v1/admin/accounts/batch") {
    for (const account of body.accounts) accounts.push({ ...account, id: 100 + accounts.length });
    return send(res, { success: body.accounts.length, failed: 0 });
  }
  if (/\/api\/v1\/admin\/accounts\/\d+$/.test(url.pathname)) {
    const account = accounts.find((item) => item.id === Number(url.pathname.split("/").at(-1)));
    if (account) Object.assign(account, body);
    return send(res, { success: true });
  }
  return send(res, {});
});
let child;
let headers;
let logs = "";
let poolBase;
const profiles = [
  { id: "default", name: "Balanced", proxyId: "balanced" },
  { id: "free", name: "Direct", proxyId: "direct" },
  { id: "pro", name: "Pinned", proxyId: "3" },
  { id: "keep", name: "Keep", proxyId: "" },
];
try {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(wrapper, `import fs from "node:fs/promises";
const email = process.argv[process.argv.indexOf("--email") + 1];
const output = process.argv[process.argv.indexOf("--sub2api-out") + 1];
await fs.appendFile(${JSON.stringify(tracePath)}, JSON.stringify({ phase: "login", email, proxy: process.env.CHATGPT_PROXY_URL, fixed: process.env.CHATGPT_PROXY_FIXED }) + "\\n");
console.log("[1/5] Start ChatGPT web login");
console.log("Email OTP (r=resend, q=quit):");
process.stdin.resume();
await new Promise(resolve => process.stdin.once("data", resolve));
const planType = email.startsWith("free") ? "free" : email.startsWith("pro") ? "pro" : email.startsWith("keep") ? "keep" : "plus";
const route = await new Promise((resolve, reject) => {
  process.once("message", message => message.error ? reject(new Error(message.error)) : resolve(message.route));
  process.send({ type: "codex-proxy-request", id: "fixture", planType, workspaceId: "workspace-personal" });
});
await fs.appendFile(${JSON.stringify(tracePath)}, JSON.stringify({ phase: "codex", email, route }) + "\\n");
await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, plan_type: planType, access_token: "fixture", refresh_token: "fixture" }, extra: { email, plan_type: planType } }] }));
console.log("[ok] Saved sub2api import: " + output);
process.disconnect(); process.stdin.destroy();
`);
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  poolBase = `http://127.0.0.1:${remote.address().port}`;
  await start();
  assert.equal((await post("/api/task-settings", { accountProxyMode: "plan" })).status, 409);
  await settings();
  assert.equal((await post("/api/task-settings", { accountProxyMode: "plan", codexAuthMode: "sub2api" })).status, 200);
  const unconfigured = (await post("/api/jobs", { email: "unconfigured@example.test" })).body.job;
  await waitFor(async () => (await job(unconfigured.id)).status === "failed");
  assert.match((await job(unconfigured.id)).lastError, /动态代理/);
  assert.equal((await post("/api/account-proxy-settings", { mode: "plan", proxyUrl: dynamic, allowDirectFallback: false })).status, 200);
  const imported = await post("/api/jobs/batch", { text: "plus-a@example.test\nplus-b@example.test\nfree-a@example.test\npro-a@example.test" });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const ids = imported.body.jobs.map((item) => item.id);
  await waitFor(async () => (await jobs()).filter((item) => ids.includes(item.id) && item.status === "email_otp").length === 4);
  for (const id of ids) assert.equal((await job(id)).assignedProxyId, null, "do not bind before web PlanType discovery");
  assert.equal((await post("/api/task-settings", { accountProxyMode: "global" })).status, 409, "active login prevents mode change");
  await Promise.all(ids.map((id) => post(`/api/jobs/${id}/input`, { action: "email_otp", value: "123456" })));
  await waitFor(async () => (await jobs()).filter((item) => ids.includes(item.id) && item.status === "completed").length === 4);
  let traces = await trace();
  const login = traces.filter((item) => item.phase === "login");
  assert.equal(login.length, 4);
  assert(login.every((item) => item.proxy === new URL(dynamic).href && item.fixed === "0"), `all web logins use dynamic proxy with rotation enabled: ${JSON.stringify(login)}`);
  const routes = traces.filter((item) => item.phase === "codex");
  assert.deepEqual(routes.filter((item) => item.email.startsWith("plus")).map((item) => item.route.sub2ApiOAuth.proxyId).sort(), [2, 3]);
  assert.equal(routes.find((item) => item.email.startsWith("free")).route.proxyUrl, null);
  assert.equal(routes.find((item) => item.email.startsWith("pro")).route.sub2ApiOAuth.proxyId, 3);
  assert(routes.every((item) => item.route.proxyUrl !== dynamic));
  const upload = await post("/api/sub2api/upload", { ids, config: { baseUrl: poolBase, adminApiKey: "fixture-key", proxyId: "balanced" } });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  const created = accounts.filter((item) => ids.some((id) => imported.body.jobs.find((job) => job.id === id).email === item.credentials.email));
  assert.equal(created.length, 4);
  assert.equal(created.find((item) => item.credentials.email.startsWith("free")).proxy_id, 0);
  assert.equal(created.find((item) => item.credentials.email.startsWith("pro")).proxy_id, 3);
  assert(!JSON.stringify(requests).includes('"proxy_id":"balanced"'), "toSub2 marker never reaches Sub2API");
  let page = await jobs();
  assert.deepEqual(page.find((item) => item.email === "plus-a@example.test").boundIps, [proxies.find((proxy) => proxy.id === page.find((item) => item.email === "plus-a@example.test").assignedProxyId).ip_address]);
  assert.equal(JSON.stringify(page).includes("fixture-key"), false);
  const free = page.find((item) => item.email === "free-a@example.test");
  assert.equal(free.canSwitchProxy, false);
  assert.equal(free.boundProxyStatus, "direct");
  const switchResult = await post("/api/jobs/switch-proxy-batch", { ids: [free.id] });
  assert.equal(switchResult.body.started, 0);
  const preservedId = page.find((item) => item.email === "plus-a@example.test").assignedProxyId;
  await stop(); await start();
  const saved = JSON.parse(await fs.readFile(path.join(output, "task-settings.json")));
  assert.equal(saved.accountProxyMode, "plan");
  assert.equal((await job(ids[0])).assignedProxyId, preservedId);
  assert.equal((await (await fetch(`${base}/api/sub2api/settings`, { headers })).json()).profiles.find((item) => item.id === "default").proxyId, "balanced");
  assert.equal((await post("/api/jobs/relogin-batch", { ids: [ids[0]] })).status, 200);
  await waitFor(async () => (await job(ids[0])).status === "email_otp");
  await post(`/api/jobs/${ids[0]}/input`, { action: "email_otp", value: "123456" });
  await waitFor(async () => (await job(ids[0])).status === "completed" && !(await job(ids[0])).poolRefreshAction);
  assert.equal((await job(ids[0])).assignedProxyId, preservedId, "relogin retains balanced binding");
  assert.equal(accounts.length, 5, "relogin updates existing account");
  const keepResponse = await post("/api/jobs", { email: "keep-a@example.test" });
  const keepId = keepResponse.body.job.id;
  await waitFor(async () => (await job(keepId)).status === "email_otp");
  await post(`/api/jobs/${keepId}/input`, { action: "email_otp", value: "123456" });
  await waitFor(async () => (await job(keepId)).status === "completed");
  assert.equal((await job(keepId)).boundProxyStatus, "direct", "local account with selected no-proxy route displays direct");
  traces = await trace();
  assert.equal(traces.findLast((item) => item.email === "keep-a@example.test" && item.phase === "codex").route.proxyUrl, null, "new keep-original plan does not auto-balance");
  profiles[0].proxyId = "direct";
  await settings();
  profiles[0].proxyId = "balanced";
  proxiesAvailable = false;
  const unavailable = await settings();
  assert(unavailable.body.profileSync.failed > 0, "unavailable proxy assignment is reported as a per-account sync failure");
  proxiesAvailable = true;
  profiles[0].proxyId = "direct";
  await settings();
  profiles[0].proxyId = "balanced";
  await settings();
  console.log("PASS: phased dynamic web login, late PlanType routing, concurrent exit-IP balancing, direct/pinned/original plans, numeric pool writes, bound IPs, restart/relogin persistence and plan-only switch eligibility");
  if (process.argv.includes("--serve")) {
    const fixture = { url: base, output, temp };
    await fs.writeFile(path.join(root, "tmp/plan-proxy-20261031/browser-fixture.json"), JSON.stringify(fixture));
    console.log(`UI_FIXTURE=${base}`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) {
  error.message += `\n${logs}`;
  throw error;
} finally {
  await stop();
  remote.closeAllConnections();
  await new Promise((resolve) => remote.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
async function settings() { const response = await post("/api/sub2api/settings", { config: { baseUrl: poolBase, adminApiKey: "fixture-key", groupIds: [], proxyId: "balanced" }, profiles, activeProfileId: "default", planTypeBindings: { plus: "default", free: "free", pro: "pro", keep: "keep" } }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response; }
async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, ONBOARDING_PROTOCOL_SCRIPT: wrapper, LOCALAPPDATA: path.join(temp, "local"), TOSUB2_TLS_PROFILE: "chrome142", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
  await waitFor(async () => { const response = await fetch(`${base}/api/bootstrap`).catch(() => null); if (!response?.ok) return false; headers = { "content-type": "application/json", "x-console-token": (await response.json()).token }; return true; });
}
async function stop() { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
async function post(route, body) { const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function jobs() { return (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs; }
async function job(id) { return (await jobs()).find((item) => item.id === id); }
async function trace() { return (await fs.readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
async function waitFor(predicate) { const deadline = Date.now() + 25000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 80)); } throw new Error("Timed out waiting for phased proxy behavior"); }
function send(res, body) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function freePort() { return new Promise((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
