import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-credentials-smoke-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host", "127.0.0.1",
  "--port", String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    LOCALAPPDATA: path.join(outputRoot, "localappdata"),
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "credentials"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
server.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.equal(typeof bootstrap.token, "string");
  assert.equal(bootstrap.features.credentialDetails, true);
  assert.equal(bootstrap.features.totpReplace, true);
  assert.equal(bootstrap.features.sub2apiPipeline, true);
  assert.equal(bootstrap.features.accountUsage, true);
  const headers = {
    "content-type": "application/json",
    "x-console-token": bootstrap.token,
  };
  const password = "Smoke-Pass-123!";
  const firstTotp = "JBSWY3DPEHPK3PXP";
  const secondTotp = "MZXW6YTBON2GK3TB";
  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "credential-smoke@example.com",
      password,
      totpSecret: firstTotp,
      proxyUrl: "socks5h://user:secret@proxy.example:5000",
    }),
  });
  const createdText = await createdResponse.text();
  assert.equal(createdResponse.status, 201, createdText);
  const created = JSON.parse(createdText);
  const jobId = created.job.id;
  const completed = await waitForJob(headers, jobId, (job) => job.status === "completed");
  assert.equal(completed.planType, "plus");
  assert.equal(completed.proxyConfigured, true);
  assert.equal(completed.canReplaceTotp, true);
  assert.equal(completed.totpRotationIncomplete, false);
  assert.equal(Object.hasOwn(completed, "password"), false);
  assert.equal(Object.hasOwn(completed, "totpSecret"), false);
  assert.equal(Object.hasOwn(completed, "access_token"), false);

  const credentialsResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/credentials`, { headers });
  assert.equal(credentialsResponse.status, 200);
  const credentials = await credentialsResponse.json();
  assert.deepEqual(Object.keys(credentials.credentials).sort(), ["email", "hasPassword", "hasSub2apiJson", "hasTotpKey", "password", "passwordAvailable", "persisted", "sub2apiJson", "totpSecret", "totpSecretAvailable"].sort());
  assert.equal(credentials.credentials.email, "credential-smoke@example.com");
  assert.equal(credentials.credentials.password, password);
  assert.equal(credentials.credentials.totpSecret, firstTotp);
  assert.equal(credentials.credentials.passwordAvailable, true);
  assert.equal(credentials.credentials.totpSecretAvailable, true);
  assert.equal(credentials.credentials.hasSub2apiJson, true);
  assert.match(credentials.credentials.sub2apiJson, /"type": "sub2api-data"/);
  assert.match(credentials.credentials.sub2apiJson, /credential-smoke@example\.com/);

  const updateResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/credentials`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ totpSecret: secondTotp }),
  });
  const updateText = await updateResponse.text();
  assert.equal(updateResponse.status, 200, updateText);
  const updated = JSON.parse(updateText);
  assert.equal(updated.credentials.password, password);
  assert.equal(updated.credentials.totpSecret, secondTotp);
  assert.equal(updated.job.canReplaceTotp, true);

  const invalidUpdate = await fetch(`${baseUrl}/api/jobs/${jobId}/credentials`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ totpSecret: "not-base32" }),
  });
  assert.equal(invalidUpdate.status, 400);

  const replaceResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/replace-2fa`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const replaceText = await replaceResponse.text();
  assert.equal(replaceResponse.status, 200, replaceText);
  const replaced = await waitForJob(headers, jobId, (job) => (
    job.status === "completed"
      && job.lastOperationType === "replace_2fa"
      && job.totpSecret === undefined
      && job.hasTotpKey
  ));
  assert.equal(replaced.canReplaceTotp, true);
  assert.equal(replaced.proxyConfigured, true);
  const afterReplace = await fetch(`${baseUrl}/api/jobs/${jobId}/credentials`, { headers });
  assert.equal(afterReplace.status, 200);
  const afterReplaceBody = await afterReplace.json();
  assert.equal(afterReplaceBody.credentials.password, password);
  assert.equal(afterReplaceBody.credentials.totpSecret, "MZXW6YTBON2GK3TB");
  assert.equal(afterReplaceBody.credentials.hasSub2apiJson, true);
  const logsResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/logs`, { headers });
  const jobLogs = await logsResponse.json();
  assert.doesNotMatch(jobLogs.logs, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(jobLogs.logs, new RegExp(secondTotp));
  assert.doesNotMatch(jobLogs.logs, /proxy\.example/);
  console.log("console credential and 2FA replacement smoke tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(2_000)]);
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

async function waitForJob(headers, id, predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const data = await response.json();
    const job = data.jobs.find((item) => item.id === id);
    if (job && predicate(job)) return job;
    await delay(100);
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
