import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-console-oauth-mode-"));
const output = path.join(temp, "output");
const port = await freePort();
const officialPort = await freePort();
const poolPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const officialBase = `http://127.0.0.1:${officialPort}`;
const poolBase = `http://127.0.0.1:${poolPort}`;
const email = "add-phone-page@example.com";
const poolRequests = [];
const tokenRequests = [];
const accounts = [];
const sessions = new Map();
let sequence = 0;
let child;
let officialChild;
let headers;
let logs = "";
let failExchange = false;
let invalidRefresh = false;
const pool = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const url = new URL(req.url, poolBase);
  poolRequests.push({ path: url.pathname, method: req.method, body });
  if (url.pathname === "/api/v1/admin/openai/generate-auth-url") {
    const id = `pool-session-${++sequence}`;
    const state = `pool-state-${sequence}`;
    sessions.set(id, state);
    const query = new URLSearchParams({ client_id: "pool-client", state, code_challenge: "pool-owned-challenge",
      code_challenge_method: "S256", response_type: "code", redirect_uri: "http://localhost:1455/auth/callback" });
    return send(res, 200, { code: 0, data: { auth_url: `${officialBase}/oauth/authorize?${query}`, session_id: id } });
  }
  if (url.pathname === "/api/v1/admin/openai/exchange-code") {
    tokenRequests.push({ kind: "exchange", body });
    if (failExchange) return send(res, 503, { message: "private response must not appear in logs" });
    assert.equal(body.state, sessions.get(body.session_id));
    assert.equal(body.code, "mock-authorization-code");
    sessions.delete(body.session_id);
    return send(res, 200, { code: 0, data: tokens(`pool-access-${sequence}`, `pool-refresh-${sequence}`) });
  }
  if (url.pathname === "/api/v1/admin/openai/refresh-token") {
    tokenRequests.push({ kind: "refresh", body });
    assert.equal(body.client_id, "pool-client");
    if (invalidRefresh) return send(res, 400, { error: "invalid_grant" });
    return send(res, 200, { code: 0, data: tokens("pool-refreshed-access", "pool-refreshed-refresh") });
  }
  if (url.pathname === "/api/v1/admin/groups/all" || url.pathname === "/api/v1/admin/proxies/all") return send(res, 200, []);
  if (url.pathname === "/api/v1/admin/accounts" && req.method === "GET") return send(res, 200, { data: { items: accounts, total: accounts.length, pages: 1 } });
  if (url.pathname === "/api/v1/admin/accounts/batch") {
    body.accounts.forEach((account) => accounts.push({ ...account, id: 501, status: "active" }));
    return send(res, 200, { success: body.accounts.length, failed: 0 });
  }
  if (url.pathname === "/api/v1/admin/accounts/501" && req.method === "PUT") {
    accounts[0] = { ...accounts[0], ...body };
    return send(res, 200, { success: true });
  }
  return send(res, 404, { message: "unknown fixture route" });
});
try {
  await fs.mkdir(output, { recursive: true });
  await new Promise((resolve) => pool.listen(poolPort, "127.0.0.1", resolve));
  officialChild = spawn(process.execPath, [path.join(root, "test/mock-add-phone-page-server.mjs"), String(officialPort)], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await waitFor(async () => (await fetch(officialBase).catch(() => null))?.ok);
  await start();
  let response = await post("/api/task-settings", { codexAuthMode: "sub2api" });
  assert.equal(response.status, 409);
  response = await post("/api/sub2api/settings", { config: { baseUrl: poolBase, adminApiKey: "fixture-key", groupIds: [] } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  response = await post("/api/task-settings", { codexAuthMode: "sub2api", maxActiveJobs: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await stop(); await start();
  const settings = JSON.parse(await fs.readFile(path.join(output, "task-settings.json")));
  assert.equal(settings.codexAuthMode, "sub2api");
  response = await post("/api/jobs", { email });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const id = response.body.job.id;
  await authorize(id);
  let job = await jobFor(id);
  assert.equal(job.status, "completed");
  const file = path.join(output, id, "sub2api-import-oauth.json");
  const bundle = JSON.parse(await fs.readFile(file));
  assert.equal(bundle.accounts[0].credentials.access_token, "pool-access-1");
  assert.equal(bundle.accounts[0].credentials.chatgpt_account_id, "pool-account");
  assert.equal(tokenRequests.filter((request) => request.kind === "exchange").length, 1);
  assert.equal(JSON.stringify(await jobFor(id)).includes("fixture-key"), false);
  response = await post("/api/sub2api/upload", { ids: [id], config: { baseUrl: poolBase, adminApiKey: "fixture-key", groupIds: [] } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(accounts.length, 1);
  response = await post(`/api/jobs/${id}/regenerate`, {});
  assert.equal(response.status, 200);
  await waitFor(async () => { const current = await jobFor(id); return current.status === "completed" && !current.poolRefreshAction && current.attempt > job.attempt; });
  assert.equal(accounts[0].credentials.access_token, "pool-refreshed-access");
  assert.equal(tokenRequests.filter((request) => request.kind === "refresh").length, 1);
  job = await jobFor(id);
  response = await post(`/api/jobs/${id}/relogin`, {});
  assert.equal(response.status, 200);
  await authorize(id);
  await waitFor(async () => { const current = await jobFor(id); return current.status === "completed" && !current.poolRefreshAction && current.attempt > job.attempt; });
  assert.equal(accounts.length, 1, "reauthorization must update the existing pool account");
  assert.equal(accounts[0].credentials.access_token, "pool-access-2");

  invalidRefresh = true;
  job = await jobFor(id);
  response = await post(`/api/jobs/${id}/regenerate`, {});
  assert.equal(response.status, 200);
  await authorize(id);
  await waitFor(async () => { const current = await jobFor(id); return current.status === "completed" && !current.poolRefreshAction && current.attempt > job.attempt; });
  assert.equal(accounts[0].credentials.access_token, "pool-access-3", "expired remote refresh must restart remote authorization and update the same account");
  assert.equal(accounts.length, 1);
  invalidRefresh = false;

  // The selected provider must fail explicitly and preserve the previous local/pool export.
  failExchange = true;
  const before = await fs.readFile(file, "utf8");
  response = await post(`/api/jobs/${id}/relogin`, {});
  assert.equal(response.status, 200);
  await authorize(id, true);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal(accounts[0].credentials.access_token, "pool-access-3");
  assert.ok(!logs.includes("private response must not appear in logs"));
  assert.ok(!logs.includes("fixture-key"));
  console.log("console Sub2API auth mode passed: task setting/restart, real protocol login, remote credentials, refresh, invalid-grant reauthorization, relogin pool update, failed-exchange preservation");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stop();
  officialChild?.kill("SIGTERM");
  pool.closeAllConnections?.();
  await new Promise((resolve) => pool.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
function tokens(access, refresh) { return { access_token: access, refresh_token: refresh, email, chatgpt_account_id: "pool-account", chatgpt_user_id: "pool-user", client_id: "pool-client", expires_at: 1900000000, plan_type: "plus" }; }
async function authorize(id, failure = false) {
  await waitFor(async () => ["email_otp", "failed"].includes((await jobFor(id)).status));
  assert.equal((await jobFor(id)).status, "email_otp", JSON.stringify(await jobFor(id)));
  let response = await post(`/api/jobs/${id}/input`, { action: "email_otp", value: "123456" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await waitFor(async () => ["phone", "failed"].includes((await jobFor(id)).status));
  assert.equal((await jobFor(id)).status, "phone", JSON.stringify(await jobFor(id)));
  response = await post(`/api/jobs/${id}/input`, { action: "phone", value: "+60123456789" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await waitFor(async () => ["phone_otp", "failed"].includes((await jobFor(id)).status));
  assert.equal((await post(`/api/jobs/${id}/input`, { action: "phone_otp", value: "654321" })).status, 200);
  await waitFor(async () => ["completed", "failed"].includes((await jobFor(id)).status));
  if (failure) assert.equal((await jobFor(id)).status, "failed");
  else assert.equal((await jobFor(id)).status, "completed", JSON.stringify(await jobFor(id)));
}
async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, CHATGPT_BASE: officialBase, AUTH_BASE: officialBase,
      LOCALAPPDATA: path.join(temp, "local"), TOSUB2_TLS_PROFILE: "chrome142", NODE_ENV: "test",
      TOSUB2_TEST_SENTINEL_TOKEN: "mock-sentinel-challenge", TOSUB2_TEST_SENTINEL_SO_TOKEN: "mock-so-token" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20000); });
  await waitFor(async () => {
    const response = await fetch(`${base}/api/bootstrap`).catch(() => null);
    if (!response?.ok) return false;
    const data = await response.json(); headers = { "content-type": "application/json", "x-console-token": data.token }; return true;
  });
}
async function stop() { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exit = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; }
async function post(route, body) { const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function jobFor(id) { const response = await fetch(`${base}/api/jobs`, { headers }); return (await response.json()).jobs.find((job) => job.id === id); }
async function waitFor(predicate) { const end = Date.now() + 25000; while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 80)); } throw new Error("Timed out waiting for console OAuth state"); }
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function freePort() { return new Promise((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
