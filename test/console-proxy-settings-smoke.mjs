import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = process.env.PROXY_TEST_SERVER || path.join(root, "src/console-server.mjs");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-proxy-settings-"));
const output = path.join(temp, "output");
const trace = path.join(temp, "trace.jsonl");
const mock = path.join(temp, "protocol.mjs");
const proxy = "http://fixture:secret@127.0.0.1:18080/";
const changedProxy = "http://fixture:secret@127.0.0.1:18081/";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const emails = ["auto@example.com", "blocked@example.com", "fallback@example.com"];
let child;
let logs = "";
let headers;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const remote = http.createServer((req, res) => {
  const items = [{ id: 91, platform: "openai", type: "oauth", status: "error", error_message: "HTTP 401", credentials: { email: emails[0] }, extra: { email: emails[0] }, group_ids: [] }];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: { items, pages: 1 } }));
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));

try {
  await fs.mkdir(output, { recursive: true });
  for (let i = 0; i < ids.length; i++) {
    const directory = path.join(output, ids[i]);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, accounts: [{ name: `oauth---${emails[i]}`, credentials: { email: emails[i] }, extra: { email: emails[i] } }] }));
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email: emails[i], status: "completed", result_saved: true, login_mode: "email_otp", mail_api_url: "http://127.0.0.1:1/otp", has_password: false, has_totp_key: false, last_auth_automated: true, last_auth_requirements: { emailOtp: true }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  }
  await fs.writeFile(mock, `import fs from 'node:fs/promises';
const email = process.argv[process.argv.indexOf('--email') + 1];
const proxy = process.env.CHATGPT_PROXY_URL || '';
await fs.appendFile(process.env.PROXY_TEST_TRACE, JSON.stringify({email, proxy}) + '\\n');
if (/^(blocked|fallback)@/.test(email) && proxy) {
  console.error('[proxy-risk-retry] PROXY_RISK_CONTROL: fixture proxy failed');
  process.exitCode = 1;
} else {
  console.log('[1/5] Mock login started');
  await new Promise(resolve => { const timer = setTimeout(resolve, 60000); process.once('SIGTERM', () => {clearTimeout(timer); resolve();}); });
}
`);
  await start();
  let response = await fetch(`${base}/api/account-proxy-settings`, { headers });
  if (response.status === 404 && process.env.PROXY_TEST_PROBE === "1") {
    console.log('proxy settings API=404; server settings have no global proxy or fallback switch');
  } else {
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, { proxyUrl: "", allowDirectFallback: false });
    assert.equal((await fetch(`${base}/api/account-proxy-settings`)).status, 403);
    assert.equal((await request("/api/account-proxy-settings", { proxyUrl: "invalid", allowDirectFallback: false })).status, 400);
    assert.equal((await request("/api/account-proxy-settings", { proxyUrl: proxy, allowDirectFallback: "false" })).status, 400);
    await save(proxy, false);
    const seedAccountProxy = await request("/api/jobs", { email: emails[0], proxyUrl: proxy });
    assert.equal(seedAccountProxy.status, 200);
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(Object.hasOwn(bootstrap.taskSettings, "proxyUrl"), false, "unauthenticated bootstrap must not expose proxy credentials");
    await stop();
    await start();
    assert.deepEqual((await (await fetch(`${base}/api/account-proxy-settings`, { headers })).json()).settings, { proxyUrl: proxy, allowDirectFallback: false });
    const created = await request("/api/jobs", { email: "new@example.com", proxyUrl: "" });
    assert.equal(created.status, 201);
    await waitFor(async () => (await records()).some(r => r.email === "new@example.com" && r.proxy === proxy));
    await request("/api/jobs/cancel-all", {});
    // The proxy saved after the job was restored must win for background repair.
    await save(changedProxy, false);
    response = await request("/api/sub2api/monitor", { enabled: true, config: { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture-key" } });
    assert.equal(response.status, 200, await response.text());
    response = await request("/api/sub2api/monitor/check", {});
    assert.equal(response.status, 200, await response.text());
    await waitFor(async () => (await records()).some(r => r.email === emails[0] && r.proxy === changedProxy));
    await request(`/api/jobs/${ids[0]}/cancel`, {});
    // Old clients still submitting an empty string cannot clear the saved proxy.
    await request(`/api/jobs/${ids[1]}/relogin`, { proxyUrl: "" });
    await waitFor(async () => (await job(ids[1])).lastError);
    assert.deepEqual((await records()).filter(r => r.email === emails[1]).map(r => r.proxy), [changedProxy]);
    await save(changedProxy, true);
    await request(`/api/jobs/${ids[2]}/relogin`, {});
    await waitFor(async () => (await records()).some(r => r.email === emails[2] && r.proxy === ""));
    assert.deepEqual((await records()).filter(r => r.email === emails[2]).map(r => r.proxy), [changedProxy, ""]);
    const disk = JSON.parse(await fs.readFile(path.join(output, "task-settings.json"), "utf8"));
    assert.equal(disk.proxyUrl, changedProxy, "temporary fallback must not erase saved proxy");
    assert.equal(disk.allowDirectFallback, true);
    console.log('proxy settings API=200; persistence=PASS; empty-client override blocked=PASS; automatic 401 repair uses saved global proxy=PASS; fallback OFF=proxy only; fallback ON=proxy then direct; saved proxy preserved=PASS');
    console.log('console proxy settings smoke passed');
  }
} catch (error) {
  error.message += `\nServer output:\n${logs}`;
  throw error;
} finally {
  await stop();
  await new Promise(resolve => remote.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}

async function request(route, body) { return fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); }
async function save(proxyUrl, allowDirectFallback) {
  const response = await request("/api/account-proxy-settings", { proxyUrl, allowDirectFallback });
  assert.equal(response.status, 200, await response.text());
}
async function records() { try { return (await fs.readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } }
async function job(id) { return (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs.find(job => job.id === id); }
async function waitFor(predicate) {
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for proxy behavior");
}
async function start() {
  child = spawn(process.execPath, [serverFile, "--port", String(port)], { cwd: root, windowsHide: true, env: { ...process.env, LOCALAPPDATA: path.join(temp, "local"), ONBOARDING_OUTPUT_ROOT: output, ONBOARDING_PROTOCOL_SCRIPT: mock, PROXY_TEST_TRACE: trace, TOSUB2_TLS_PROFILE: "chrome146", SUB2API_MONITOR_INTERVAL_MS: "600000" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { logs = `${logs}${data}`.slice(-15000); });
  child.stderr.on("data", data => { logs = `${logs}${data}`.slice(-15000); });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      if (!response.ok) return false;
      const bootstrap = await response.json();
      headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
      return true;
    } catch { return false; }
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
