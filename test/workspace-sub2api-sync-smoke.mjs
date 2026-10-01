import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-workspace-sub2api-sync-"));
const jobId = crypto.randomUUID();
const organizationId = "f7f4cbea-48f8-4790-97f3-71ff6cbe0aa6";
const personalId = "9f527f90-aa3c-4844-b338-687815539aef";
const remoteId = 77;
const email = "workspace-sync@example.com";
const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const outputDir = path.join(outputRoot, jobId);
const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
const metadataPath = path.join(outputDir, "job-meta.json");
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({
  type: "sub2api-data",
  accounts: [{
    name: `oauth---${email}`,
    account_id: organizationId,
    plan_type: "self_serve_business_usage_based",
    credentials: {
      email,
      access_token: accessToken,
      refresh_token: "mock-refresh",
      chatgpt_account_id: organizationId,
      plan_type: "self_serve_business_usage_based",
    },
    extra: {
      email,
      account_id: organizationId,
      chatgpt_account_id: organizationId,
      plan_type: "self_serve_business_usage_based",
    },
  }],
}, null, 2)}\n`);
await fs.writeFile(metadataPath, `${JSON.stringify({
  version: 1,
  email,
  status: "completed",
  prompt: "授权完成，可以下载导入文件",
  result_saved: true,
  plan_type: "self_serve_business_usage_based",
  created_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  last_operation_type: "initial_authorization",
}, null, 2)}\n`);

const remoteAccount = {
  id: remoteId,
  name: `managed-${email}`,
  email,
  platform: "openai",
  type: "oauth",
  status: "active",
  plan_type: "self_serve_business_usage_based",
  schedulable: true,
  group_ids: [3],
  credentials: { email, chatgpt_account_id: organizationId, plan_type: "self_serve_business_usage_based", access_token: "old-token", usage_snapshot: "keep-me" },
  extra: { email, plan_type: "self_serve_business_usage_based", usage: { used: 7 } },
};
const duplicateRemoteAccount = {
  ...remoteAccount,
  id: 78,
  name: `legacy-${email}`,
  group_ids: [4],
  credentials: { ...remoteAccount.credentials, access_token: "old-token-duplicate", provider_field: "keep-duplicate" },
  extra: { ...remoteAccount.extra, usage: { used: 11 }, duplicate_marker: true },
};
const remoteAccounts = [remoteAccount, duplicateRemoteAccount];
const putRequests = [];
let batchRequests = 0;

const officialApi = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/backend-api/wham/accounts/check") {
    res.end(JSON.stringify({
      default_account_id: organizationId,
      accounts: [
        { id: organizationId, name: "RUITeam", structure: "workspace", plan_type: "self_serve_business_usage_based", can_access_with_session: true },
        { id: personalId, name: null, structure: "personal", plan_type: "free", can_access_with_session: true },
      ],
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

const sub2api = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url.startsWith("/api/v1/admin/accounts?")) {
    res.end(JSON.stringify({ data: { items: remoteAccounts, total: remoteAccounts.length, pages: 1 } }));
    return;
  }
  const updateMatch = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(req.url || "");
  if (req.method === "PUT" && updateMatch) {
    const body = JSON.parse(await readBody(req));
    putRequests.push({ id: Number(updateMatch[1]), body });
    const target = remoteAccounts.find((account) => account.id === Number(updateMatch[1]));
    Object.assign(target, body);
    res.end(JSON.stringify({ data: target }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") batchRequests += 1;
  res.end(JSON.stringify({ success: 1, data: [remoteAccount] }));
});

await listen(officialApi);
await listen(sub2api);
const officialBase = `http://127.0.0.1:${officialApi.address().port}`;
const sub2apiBase = `http://127.0.0.1:${sub2api.address().port}`;
const consolePort = await findAvailablePort();
const uploadConfig = {
  baseUrl: sub2apiBase,
  adminApiKey: "test-admin-key",
  groupIds: [9],
  profiles: [
    { id: "default", name: "默认", groupIds: [9], accountNameTemplate: "managed-{email}", codexFingerprintMode: "session", wsMode: "off" },
    { id: "free-plan", name: "Free", groupIds: [11], accountNameTemplate: "free-{email}", codexFingerprintMode: "off", wsMode: "off" },
  ],
  activeProfileId: "default",
  planTypeBindings: { free: "free-plan" },
};
const consoleProcess = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(consolePort)], {
  cwd: projectRoot,
  env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot, CHATGPT_BASE: officialBase, AUTH_BASE: officialBase, TOSUB2_SESSION_NATIVE_HTTP: "1", SUB2API_MONITOR_ENABLED: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
consoleProcess.stdout.setEncoding("utf8");
consoleProcess.stderr.setEncoding("utf8");
consoleProcess.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
consoleProcess.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });

try {
  const bootstrap = await waitForJson(`http://127.0.0.1:${consolePort}/api/bootstrap`);
  const headers = { "x-console-token": bootstrap.token, "content-type": "application/json" };
  const settings = await fetch(`http://127.0.0.1:${consolePort}/api/sub2api/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: uploadConfig }),
  });
  assert.equal(settings.status, 200, await settings.text());

  const switchResponse = await fetch(`http://127.0.0.1:${consolePort}/api/jobs/${jobId}/workspaces/switch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId: personalId }),
  });
  const switchText = await switchResponse.text();
  assert.equal(switchResponse.status, 200, `${switchText}\n${logs}`);
  const switched = JSON.parse(switchText);
  assert.equal(switched.sub2api.updated, 2);
  assert.deepEqual(switched.sub2api.accountIds, [String(remoteId), "78"]);
  assert.equal(switched.job.planType, "free");
  assert.equal(switched.job.sub2apiPlanType, "free");
  assert.equal(putRequests.length, 2);
  assert.deepEqual(putRequests.map((request) => request.id), [remoteId, 78]);
  for (const request of putRequests) {
    assert.equal(request.body.credentials.chatgpt_account_id, personalId);
    assert.equal(request.body.credentials.plan_type, "free");
    assert.equal(request.body.plan_type, "free");
    assert.equal(request.body.extra.plan_type, "free");
    assert.equal(request.body.credentials.refresh_token, "mock-refresh");
    assert.equal(request.body.credentials.access_token, accessToken);
    assert.equal(request.body.extra.workspace_id, personalId);
    assert.equal(request.body.extra.privacy_mode, "training_off");
    assert.equal(request.body.extra.codex_fingerprint_mode, "off");
    assert.equal(request.body.extra.openai_oauth_responses_websockets_v2_mode, "off");
    assert.deepEqual(request.body.group_ids, [11]);
    assert.equal(request.body.name, `free-${email}`);
  }
  assert.equal(putRequests.find((request) => request.id === remoteId).body.credentials.usage_snapshot, "keep-me");
  assert.deepEqual(putRequests.find((request) => request.id === remoteId).body.extra.usage, { used: 7 });
  assert.equal(putRequests.find((request) => request.id === 78).body.credentials.provider_field, "keep-duplicate");
  assert.deepEqual(putRequests.find((request) => request.id === 78).body.extra.usage, { used: 11 });

  const uploadResponse = await fetch(`http://127.0.0.1:${consolePort}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: [jobId], config: uploadConfig }),
  });
  const uploadText = await uploadResponse.text();
  assert.equal(uploadResponse.status, 200, uploadText);
  const uploaded = JSON.parse(uploadText);
  assert.equal(uploaded.created, 0);
  assert.equal(uploaded.updated, 2);
  assert.deepEqual(uploaded.updatedAccountIds, [String(remoteId), "78"]);
  assert.equal(putRequests.length, 4, "uploading after a workspace switch must update, not duplicate");
  assert.deepEqual(putRequests.slice(2).map((request) => request.id), [remoteId, 78]);
  assert.equal(putRequests[2].body.extra.privacy_mode, "training_off");
  assert.equal(putRequests[3].body.extra.privacy_mode, "training_off");
  assert.equal(batchRequests, 0, "workspace switching must update the existing record, not batch upload");
  console.log("workspace Sub2API in-place sync smoke passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  consoleProcess.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => consoleProcess.once("exit", resolve)), delay(2_000)]);
  await close(officialApi);
  await close(sub2api);
  await fs.rm(outputRoot, { recursive: true, force: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForJson(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = http.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
