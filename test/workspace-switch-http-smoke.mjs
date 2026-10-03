import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-workspace-http-"));
const accountId = crypto.randomUUID();
const organizationId = "f7f4cbea-48f8-4790-97f3-71ff6cbe0aa6";
const personalId = "9f527f90-aa3c-4844-b338-687815539aef";
const bannedWorkspaceId = "402-workspace";
const removedWorkspaceId = "removed-workspace";
const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const outputDir = path.join(outputRoot, accountId);
const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
const metadataPath = path.join(outputDir, "job-meta.json");

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({
  type: "sub2api-data",
  accounts: [{
    name: "oauth---workspace-smoke@example.com",
    account_id: organizationId,
    plan_type: "self_serve_business_usage_based",
    credentials: {
      email: "workspace-smoke@example.com",
      access_token: accessToken,
      refresh_token: "mock-refresh",
      chatgpt_account_id: organizationId,
      plan_type: "self_serve_business_usage_based",
    },
    extra: {
      email: "workspace-smoke@example.com",
      account_id: organizationId,
      chatgpt_account_id: organizationId,
      plan_type: "self_serve_business_usage_based",
    },
  }],
}, null, 2)}\n`);
await fs.writeFile(metadataPath, `${JSON.stringify({
  version: 1,
  email: "workspace-smoke@example.com",
  status: "completed",
  prompt: "授权完成，可以下载导入文件",
  result_saved: true,
  plan_type: "self_serve_business_usage_based",
  created_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  last_operation_type: "initial_authorization",
}, null, 2)}\n`);

const officialApi = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/backend-api/wham/accounts/check") {
    res.end(JSON.stringify({
      default_account_id: organizationId,
      accounts: [
        {
          id: organizationId,
          name: "RUITeam",
          structure: "workspace",
          plan_type: "self_serve_business_usage_based",
          account_user_role: "member",
          can_access_with_session: true,
        },
        {
          id: personalId,
          name: null,
          structure: "personal",
          plan_type: "free",
          can_access_with_session: true,
        },
        {
          id: removedWorkspaceId,
          name: "已移出空间",
          structure: "workspace",
          plan_type: "self_serve_business_usage_based",
          can_access_with_session: false,
          error: { code: "account_removed_from_workspace", message: "You were removed from this workspace" },
        },
        {
          id: bannedWorkspaceId,
          name: "封禁空间",
          structure: "workspace",
          plan_type: "self_serve_business_usage_based",
          can_access_with_session: false,
          status_code: 402,
          error_message: "Workspace is unavailable",
        },
      ],
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => officialApi.listen(0, "127.0.0.1", resolve));
const officialBase = `http://127.0.0.1:${officialApi.address().port}`;

const consolePort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${consolePort}`;
const consoleProcess = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host", "127.0.0.1",
  "--port", String(consolePort),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    CHATGPT_BASE: officialBase,
    AUTH_BASE: officialBase,
    TOSUB2_SESSION_NATIVE_HTTP: "1",
    SUB2API_MONITOR_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
consoleProcess.stdout.setEncoding("utf8");
consoleProcess.stderr.setEncoding("utf8");
consoleProcess.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
consoleProcess.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.equal(bootstrap.features.accountWorkspaces, true);
  const headers = { "x-console-token": bootstrap.token };
  const jobsResponse = await fetch(`${baseUrl}/api/jobs`, { headers });
  assert.equal(jobsResponse.status, 200);
  const jobs = await jobsResponse.json();
  const job = jobs.jobs.find((item) => item.id === accountId);
  assert.ok(job, "restored workspace smoke job should be visible");
  assert.equal(job.planType, "self_serve_business_usage_based");

  const listResponse = await fetch(`${baseUrl}/api/jobs/${accountId}/workspaces`, { headers });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.workspaces.currentWorkspaceId, organizationId);
  assert.deepEqual(listed.workspaces.workspaces.map((item) => item.id), [organizationId, personalId, removedWorkspaceId, bannedWorkspaceId]);
  assert.equal(listed.workspaces.workspaces[1].name, "个人账户");
  assert.equal(listed.workspaces.workspaces[1].planType, "free");
  assert.equal(listed.workspaces.workspaces[2].availabilityReason, "removed");
  assert.equal(listed.workspaces.workspaces[2].availabilityCode, "account_removed_from_workspace");
  assert.equal(listed.workspaces.workspaces[2].availabilityLabel, "已移出空间（account_removed_from_workspace）");
  assert.equal(listed.workspaces.workspaces[3].availabilityReason, "banned");
  assert.equal(listed.workspaces.workspaces[3].availabilityCode, "402");
  assert.equal(listed.workspaces.workspaces[3].availabilityLabel, "空间封禁（402）");

  const bannedSwitchResponse = await fetch(`${baseUrl}/api/jobs/${accountId}/workspaces/switch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: bannedWorkspaceId }),
  });
  const bannedSwitchText = await bannedSwitchResponse.text();
  assert.equal(bannedSwitchResponse.status, 409, bannedSwitchText);
  assert.match(bannedSwitchText, /空间封禁（402）/);

  const switchResponse = await fetch(`${baseUrl}/api/jobs/${accountId}/workspaces/switch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: personalId }),
  });
  const switchText = await switchResponse.text();
  assert.equal(switchResponse.status, 200, switchText);
  const switched = JSON.parse(switchText);
  assert.equal(switched.job.planType, "free");
  assert.equal(switched.job.lastOperationType, "workspace_switch");
  assert.equal(switched.workspaces.currentWorkspaceId, personalId);
  assert.equal(switched.workspaces.workspaces.find((item) => item.id === personalId).current, true);

  const afterSwitchListResponse = await fetch(`${baseUrl}/api/jobs/${accountId}/workspaces`, { headers });
  assert.equal(afterSwitchListResponse.status, 200);
  const afterSwitchList = await afterSwitchListResponse.json();
  assert.equal(afterSwitchList.workspaces.currentWorkspaceId, personalId);
  assert.equal(afterSwitchList.workspaces.workspaces.find((item) => item.id === organizationId).current, false);
  assert.equal(afterSwitchList.workspaces.workspaces.find((item) => item.id === personalId).current, true);

  const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const account = saved.accounts[0];
  assert.equal(account.account_id, personalId);
  assert.equal(account.plan_type, "free");
  assert.equal(account.credentials.account_id, personalId);
  assert.equal(account.credentials.chatgpt_account_id, personalId);
  assert.equal(account.credentials.plan_type, "free");
  assert.equal(account.extra.workspace_id, personalId);
  assert.equal(account.extra.workspace_structure, "personal");
  assert.equal(account.extra.plan_type, "free");
  assert.equal(account.credentials.access_token, accessToken);

  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(metadata.workspace_plan_type, "free");
  console.log("workspace switch HTTP smoke passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  consoleProcess.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => consoleProcess.once("exit", resolve)), delay(2_000)]);
  await new Promise((resolve) => officialApi.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
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
