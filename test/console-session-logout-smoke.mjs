import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-logout-console-"));
const upstreamCalls = [];
const upstream = http.createServer(async (req, res) => {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  upstreamCalls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(body).toString() });
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
const accountId = "11111111-1111-4111-8111-111111111111";
const accountDir = path.join(outputRoot, accountId);
await fs.mkdir(accountDir);
await fs.writeFile(path.join(accountDir, "sub2api-import-oauth.json"), JSON.stringify({
  type: "sub2api-data",
  accounts: [{ name: "saved@example.test", credentials: {
    email: "saved@example.test", access_token: `header.${tokenPayload}.signature`,
    refresh_token: "mock-refresh", chatgpt_account_id: "acct-logout-test",
  } }],
}));
const portListener = http.createServer();
await new Promise((resolve) => portListener.listen(0, "127.0.0.1", resolve));
const port = portListener.address().port;
await new Promise((resolve) => portListener.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: outputRoot,
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test/mock-queue-protocol.mjs"),
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "credentials"),
    LOCALAPPDATA: path.join(outputRoot, "localappdata"),
    TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: upstreamUrl, AUTH_BASE: upstreamUrl,
  },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const exited = new Promise((resolve) => child.once("exit", resolve));
try {
  const bootstrap = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/bootstrap`);
    return response.ok ? response.json() : null;
  });
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const list = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  assert.equal(list.jobs.find((job) => job.id === accountId).canLogoutAllSessions, true);
  assert.equal(list.selection.find((job) => job.id === accountId).canLogoutAllSessions, true);
  const unauthorized = await fetch(`${baseUrl}/api/jobs/${accountId}/sessions/logout-all`, { method: "POST" });
  assert.equal(unauthorized.status, 403);
  const result = await fetch(`${baseUrl}/api/jobs/${accountId}/sessions/logout-all`, { method: "POST", headers });
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { ok: true });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].method, "POST");
  assert.equal(upstreamCalls[0].url, "/backend-api/accounts/logout_all");
  assert.equal(upstreamCalls[0].headers["chatgpt-account-id"], "acct-logout-test");
  assert.match(upstreamCalls[0].headers.authorization, /^Bearer header\./);
  assert.deepEqual(JSON.parse(upstreamCalls[0].body), {});
  const created = await (await fetch(`${baseUrl}/api/jobs`, { method: "POST", headers, body: JSON.stringify({ email: "running@example.test" }) })).json();
  assert.equal(created.job.canLogoutAllSessions, false);
  const runningResult = await fetch(`${baseUrl}/api/jobs/${created.job.id}/sessions/logout-all`, { method: "POST", headers });
  assert.equal(runningResult.status, 409, await runningResult.clone().text());
  assert.match((await runningResult.json()).error, /暂不能登出所有设备/);
  assert.equal(upstreamCalls.length, 1, "ineligible job reached upstream");
  console.log("console logout smoke passed: capabilities, selected index, authenticated POST, upstream request, running-account 409, no real account");
} catch (error) {
  error.message += `\nConsole logs:\n${logs}`;
  throw error;
} finally {
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitFor(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Console startup timed out");
}
