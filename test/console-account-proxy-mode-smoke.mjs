import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-account-proxy-mode-"));
const output = path.join(temp, "output");
const port = await freePort();
const officialPort = await freePort();
const sub2Port = await freePort();
const base = `http://127.0.0.1:${port}`;
const sub2Url = `http://127.0.0.1:${sub2Port}`;
const accounts = [{
  id: 100,
  platform: "openai",
  type: "oauth",
  status: "active",
  proxy_id: 1,
  credentials: { email: "existing@example.com", access_token: "old" },
  extra: { email: "existing@example.com" },
}];
const accountUpdates = [];
const oauthRequests = [];
const protocolTrace = path.join(temp, "protocol-trace.jsonl");
const protocolWrapper = path.join(temp, "protocol-wrapper.mjs");
const failLogin = path.join(temp, "fail-login");
let rejectCredentialUpdates = false;
let consoleChild;
let consoleLogs = "";
let headers;

const proxies = [
  { id: 1, name: "Proxy A", protocol: "http", host: "proxy-a.invalid", port: 8080, username: "a", password: "secret-a", ip_address: "198.51.100.10", status: "active" },
  { id: 2, name: "Proxy A2", protocol: "http", host: "proxy-a2.invalid", port: 8080, username: "a2", password: "secret-a2", ip_address: "198.51.100.10", status: "active" },
  { id: 3, name: "Proxy B", protocol: "http", host: "proxy-b.invalid", port: 8080, username: "b", password: "secret-b", ip_address: "198.51.100.20", status: "active" },
];

const sub2 = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url || "/", sub2Url);
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/v1/admin/proxies/all") return send(res, 200, proxies);
  const proxyMatch = /^\/api\/v1\/admin\/proxies\/(\d+)$/.exec(url.pathname);
  if (proxyMatch) return send(res, 200, { data: proxies.find((proxy) => proxy.id === Number(proxyMatch[1])) });
  if (url.pathname.startsWith("/api/v1/admin/groups/all")) return send(res, 200, []);
  if (url.pathname === "/api/v1/admin/accounts" && req.method === "GET") {
    return send(res, 200, { data: { items: accounts, total: accounts.length, page: 1, page_size: 100, pages: 1 } });
  }
  if (url.pathname === "/api/v1/admin/accounts/batch" && req.method === "POST") {
    const payload = JSON.parse(body || "{}");
    payload.accounts.forEach((account, index) => accounts.push({ ...account, id: 200 + accounts.length + index }));
    return send(res, 200, { success: payload.accounts.length, failed: 0 });
  }
  const accountMatch = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (accountMatch && req.method === "PUT") {
    const id = Number(accountMatch[1]);
    const update = JSON.parse(body || "{}");
    if (rejectCredentialUpdates && update.credentials) return send(res, 503, { message: "fixture credential sync failure" });
    accountUpdates.push({ id, body: update });
    const index = accounts.findIndex((account) => account.id === id);
    if (index >= 0) accounts[index] = { ...accounts[index], ...update };
    return send(res, 200, { success: true });
  }
  return send(res, 404, { message: `Unknown Sub2API route ${req.method} ${url.pathname}` });
});

const official = http.createServer(async (req, res) => {
  const body = await readBody(req);
  oauthRequests.push({ method: req.method, path: req.url, body });
  res.setHeader("content-type", "application/json");
  if (req.url === "/oauth/token") {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    return send(res, 200, { access_token: `header.${payload}.signature`, refresh_token: "rotated-refresh" });
  }
  if (req.url === "/backend-api/accounts/logout_all") return send(res, 200, { ok: true });
  return send(res, 200, { ok: true });
});

try {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(protocolWrapper, `import fs from "node:fs/promises";
await fs.appendFile(${JSON.stringify(protocolTrace)}, JSON.stringify({ args: process.argv.slice(2), proxy: process.env.CHATGPT_PROXY_URL, fixed: process.env.CHATGPT_PROXY_FIXED, authMode: process.env.TOSUB2_CODEX_AUTH_MODE, oauthBase: process.env.TOSUB2_OAUTH_BASE_URL, oauthProxyId: process.env.TOSUB2_OAUTH_PROXY_ID }) + "\\n");
if (await fs.stat(${JSON.stringify(failLogin)}).then(() => true, () => false)) {
  console.log("[proxy-risk-retry] PROXY_CONNECTION_RETRY: fixture fixed proxy failed");
  await new Promise(resolve => setTimeout(resolve, 300));
  process.exitCode = 1;
} else { await import(${JSON.stringify(new URL("./mock-protocol-login.mjs", import.meta.url).href)}); }
`);
  await listen(sub2, sub2Port);
  await listen(official, officialPort);
  await startConsole();

  let response = await post("/api/sub2api/settings", {
    config: { baseUrl: sub2Url, adminApiKey: "fixture-key", groupIds: [] },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  response = await post("/api/task-settings", { accountProxyMode: "sub2api" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.settings.accountProxyMode, "sub2api");
  response = await post("/api/task-settings", { codexAuthMode: "sub2api" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.settings.codexAuthMode, "sub2api");

  const created = await post("/api/jobs/batch", {
    text: "new-a@example.com\nnew-b@example.com",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const newJobs = created.body.jobs;
  await waitFor(async () => (await page()).jobs.filter((job) => newJobs.some((createdJob) => createdJob.id === job.id && job.status === "completed")).length === 2);
  assert.deepEqual(newJobs.map((job) => job.assignedProxyId).sort(), [2, 3], "new accounts should balance by exit IP rather than proxy ID");
  let traces = await readTrace();
  for (const job of newJobs) {
    const trace = traces.find((item) => item.args.includes(job.email));
    assert.equal(new URL(trace.proxy).hostname, proxies.find((proxy) => proxy.id === job.assignedProxyId).host);
    assert.equal(trace.fixed, "1", "login must use the exact assigned proxy without rotation or direct fallback");
    assert.equal(trace.authMode, "sub2api");
    assert.equal(trace.oauthBase, sub2Url);
    assert.equal(Number(trace.oauthProxyId), job.assignedProxyId);
  }

  response = await post("/api/sub2api/upload", {
    ids: newJobs.map((job) => job.id),
    config: { baseUrl: sub2Url, adminApiKey: "fixture-key", groupIds: [] },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const uploaded = new Map(accounts.filter((account) => ["new-a@example.com", "new-b@example.com"].includes(account.credentials?.email)).map((account) => [account.credentials.email, account.proxy_id]));
  assert.equal(uploaded.size, 2);
  assert.deepEqual([...uploaded.values()].sort(), [2, 3], "pool credentials should preserve each account's assigned proxy");
  const proxyOptions = await post("/api/sub2api/options", { config: { baseUrl: sub2Url, adminApiKey: "fixture-key", groupIds: [] } });
  assert.deepEqual(proxyOptions.body.proxies.map((proxy) => proxy.accountCount), [2, 2, 1],
    "distribution counts should aggregate accounts by shared exit IP");

  const target = newJobs.find((job) => job.email === "new-a@example.com");
  const originalProxyId = target.assignedProxyId;
  response = await post("/api/jobs/switch-proxy-batch", { ids: [target.id] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.started, 1);
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current?.status === "completed" && current.assignedProxyId !== originalProxyId && current.poolRefreshAction === null;
  });
  const updatedJob = (await page()).jobs.find((job) => job.id === target.id);
  assert.equal(updatedJob.lastOperationType, "relogin");
  assert.notEqual(accounts.find((account) => account.credentials?.email === target.email).proxy_id, originalProxyId);
  assert.ok(accountUpdates.some((item) => item.id === accounts.find((account) => account.credentials?.email === target.email).id
    && item.body.proxy_id === updatedJob.assignedProxyId), "proxy change and refreshed credentials must be written to the pool");
  assert.ok(oauthRequests.some((item) => item.path === "/backend-api/accounts/logout_all"), "switch IP should revoke all sessions first");

  const accountId = accounts.find((account) => account.credentials?.email === target.email).id;
  const oldUpdateCount = accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length;
  response = await post(`/api/jobs/${target.id}/regenerate`, {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current?.status === "completed" && current.attempt > updatedJob.attempt && current.poolRefreshAction === null;
  });
  const latestAccount = accounts.find((account) => account.id === accountId);
  assert.match(latestAccount.credentials.access_token, /^refreshed-access-/, "reauthorization should refresh Sub2API credentials");
  assert.equal(accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length, oldUpdateCount + 1);

  let before = (await page()).jobs.find((job) => job.id === target.id);
  response = await post(`/api/jobs/${target.id}/relogin`, {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current.status === "completed" && current.attempt > before.attempt && !current.poolRefreshAction;
  });
  assert.equal(accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length, oldUpdateCount + 2,
    "ordinary relogin must synchronize pool credentials exactly once");

  // A failed login must never publish credentials left over from an older run.
  await fs.writeFile(failLogin, "1");
  before = (await page()).jobs.find((job) => job.id === target.id);
  const traceCountBeforeFailure = (await readTrace()).length;
  response = await post(`/api/jobs/${target.id}/relogin`, {});
  assert.equal(response.status, 200);
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current.status === "completed" && current.attempt > before.attempt && current.poolRefreshError;
  });
  await delay(250);
  assert.equal(accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length, oldUpdateCount + 2);
  assert.equal((await readTrace()).length, traceCountBeforeFailure + 1, "fixed mode must not rotate/retry on another IP");
  await fs.unlink(failLogin);
  response = await post("/api/jobs/reauthorize-batch", { ids: [target.id] });
  assert.equal(response.status, 200);
  await waitFor(async () => !(await page()).jobs.find((job) => job.id === target.id).poolRefreshAction);

  // A completed authorization is persisted before a pool outage; restart retries only the upload.
  rejectCredentialUpdates = true;
  response = await post("/api/jobs/relogin-batch", { ids: [target.id] });
  assert.equal(response.status, 200);
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current.status === "completed" && current.poolRefreshReady && current.poolRefreshError;
  });
  await stopConsole();
  const traceCountBeforeRetry = (await readTrace()).length;
  rejectCredentialUpdates = false;
  await startConsole();
  await waitFor(async () => !(await page()).jobs.find((job) => job.id === target.id).poolRefreshAction);
  assert.equal((await readTrace()).length, traceCountBeforeRetry, "sync retry must not log in again");

  // Switching global mode and back must restore the saved account proxy URL.
  response = await post("/api/task-settings", { accountProxyMode: "global" });
  assert.equal(response.status, 200);
  response = await post("/api/task-settings", { accountProxyMode: "sub2api" });
  assert.equal(response.status, 200);

  response = await post("/api/task-settings", { accountProxyCooldownMinutes: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.settings.accountProxyCooldownMinutes, 1);
  response = await post("/api/jobs/cooldown-batch", { ids: [target.id] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.started, 1);
  assert.equal(response.body.cooldownMinutes, 1);
  assert.equal(response.body.jobs[0].assignedProxyId, updatedJob.assignedProxyId, "cooldown must keep its assigned IP");
  assert.ok(response.body.jobs[0].poolRefreshDueAt);
  const cooling = response.body.jobs[0];
  const coolingTraceCount = (await readTrace()).length;
  const coolingUpdates = accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length;
  await delay(300);
  assert.equal((await readTrace()).length, coolingTraceCount, "cooldown must not log in before its due time");
  await stopConsole();
  const metadataPath = path.join(output, target.id, "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(metadata.pool_refresh_action, "cooldown");
  assert.equal(metadata.pool_refresh_ready, false);
  // Move only the persisted deadline to exercise the restart/expiry path without a minute-long sleep.
  metadata.pool_refresh_due_at = new Date(Date.now() - 1_000).toISOString();
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await startConsole();
  await waitFor(async () => {
    const current = (await page()).jobs.find((job) => job.id === target.id);
    return current.status === "completed" && current.attempt > cooling.attempt && !current.poolRefreshAction;
  });
  assert.equal((await page()).jobs.find((job) => job.id === target.id).assignedProxyId, cooling.assignedProxyId);
  assert.equal(accountUpdates.filter((item) => item.id === accountId && item.body.credentials).length, coolingUpdates + 1);
  traces = await readTrace();
  assert.equal(traces.length, coolingTraceCount + 1, "expired cooldown must start exactly one login");
  assert.equal(new URL(traces.at(-1).proxy).hostname, proxies.find((proxy) => proxy.id === cooling.assignedProxyId).host);
  assert.equal(traces.at(-1).fixed, "1");

  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => post("/api/jobs", { email: `concurrent-${index}@example.com` })));
  concurrent.forEach((result) => assert.equal(result.status, 201, JSON.stringify(result.body)));
  const counts = new Map();
  for (const account of accounts) {
    const ip = proxies.find((proxy) => proxy.id === account.proxy_id)?.ip_address;
    if (ip) counts.set(ip, (counts.get(ip) || 0) + 1);
  }
  for (const result of concurrent) {
    const ip = proxies.find((proxy) => proxy.id === result.body.job.assignedProxyId).ip_address;
    counts.set(ip, (counts.get(ip) || 0) + 1);
  }
  assert.ok(Math.abs([...counts.values()][0] - [...counts.values()][1]) <= 1, "parallel imports must reserve balanced assignments");
  await waitFor(async () => (await page()).jobs.filter((job) => job.email.startsWith("concurrent-") && job.status === "completed").length === 8);

  const setting = JSON.parse(await fs.readFile(path.join(output, "task-settings.json"), "utf8"));
  assert.equal(setting.accountProxyCooldownMinutes, 1);
  assert.equal(setting.accountProxyMode, "sub2api", "proxy distribution mode should persist in global task settings");
  assert.equal(setting.codexAuthMode, "sub2api");
  assert.equal(traces.at(-1).authMode, "sub2api", "authorization source must persist after restart");

  // Remote OAuth must also pin a matching global proxy, even when direct fallback is enabled.
  await fs.writeFile(failLogin, "1");
  const globalProxy = `http://b:secret-b@${proxies[2].host}:${proxies[2].port}`;
  response = await post("/api/account-proxy-settings", { proxyUrl: globalProxy, allowDirectFallback: true, mode: "global" });
  assert.equal(response.status, 200);
  const pinned = await post("/api/jobs", { email: "global-pinned@example.com" });
  assert.equal(pinned.status, 201);
  await waitFor(async () => (await page()).jobs.find((job) => job.id === pinned.body.job.id)?.status === "failed");
  const pinnedTraces = (await readTrace()).filter((item) => item.args.includes("global-pinned@example.com"));
  assert.equal(pinnedTraces.length, 1, "remote OAuth must not rotate or fall back from its pinned global proxy");
  assert.equal(pinnedTraces[0].fixed, "1");
  assert.equal(pinnedTraces[0].oauthProxyId, "3");
  assert.equal(new URL(pinnedTraces[0].proxy).hostname, proxies[2].host);
  await fs.unlink(failLogin);
  console.log("console account proxy mode smoke passed: exit-IP balancing, concurrent imports, fixed login route, IP switch, logout, reauthorization, failed-login freshness, sync retry, cooldown expiry and restart recovery");
} catch (error) {
  error.message += `\nConsole output:\n${consoleLogs}`;
  throw error;
} finally {
  await stopConsole();
  await close(sub2);
  await close(official);
  await fs.rm(temp, { recursive: true, force: true });
}

async function startConsole() {
  const port = Number(new URL(base).port);
  consoleChild = spawn(process.execPath, [path.join(root, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      ONBOARDING_OUTPUT_ROOT: output,
      ONBOARDING_PROTOCOL_SCRIPT: protocolWrapper,
      CHATGPT_BASE: `http://127.0.0.1:${officialPort}`,
      AUTH_BASE: `http://127.0.0.1:${officialPort}`,
      TOSUB2_SESSION_NATIVE_HTTP: "1",
      TOSUB2_TLS_PROFILE: "chrome142",
      LOCALAPPDATA: path.join(temp, "local"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  consoleChild.stdout.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
  consoleChild.stderr.on("data", (chunk) => { consoleLogs = `${consoleLogs}${chunk}`.slice(-20_000); });
  await waitFor(async () => {
    const response = await fetch(`${base}/api/bootstrap`).catch(() => null);
    if (!response?.ok) return false;
    const data = await response.json();
    headers = { "content-type": "application/json", "x-console-token": data.token };
    return true;
  });
}

async function stopConsole() {
  if (!consoleChild || consoleChild.exitCode !== null) return;
  const exited = new Promise((resolve) => consoleChild.once("exit", resolve));
  consoleChild.kill("SIGTERM");
  await Promise.race([exited, delay(4_000)]);
  if (consoleChild.exitCode === null) {
    consoleChild.kill("SIGKILL");
    await exited;
  }
}

async function post(route, body) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function page() {
  const response = await fetch(`${base}/api/jobs`, { headers });
  return response.json();
}

async function readTrace() {
  return (await fs.readFile(protocolTrace, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(75);
  }
  throw new Error("Timed out waiting for account proxy behavior");
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
