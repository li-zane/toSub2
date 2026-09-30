import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-settings-migration-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const legacyConfig = {
  baseUrl: "https://legacy.example.test",
  adminApiKey: "migration-test-key",
  groupIds: [12, 13],
  proxyId: 0,
  concurrency: null,
  loadFactor: null,
  priority: null,
  accountNameTemplate: "{email}",
  modelWhitelist: ["gpt-5"],
  codexFingerprintMode: "session",
  wsMode: "ctx_pool",
};
await fs.writeFile(
  path.join(outputRoot, "sub2api-monitor.json"),
  `${JSON.stringify({ version: 1, enabled: false, config: legacyConfig, state: {} }, null, 2)}\n`,
  { mode: 0o600 },
);
await fs.writeFile(
  path.join(outputRoot, "plan-type-mapping.json"),
  `${JSON.stringify({ version: 1, mapping: { free: "Free Tier", self_serve_business_prolite: "Business Premium Custom" } }, null, 2)}\n`,
  { mode: 0o600 },
);

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: projectRoot,
  env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot },
  stdio: ["ignore", "ignore", "ignore"],
  windowsHide: true,
});

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const state = await fetch(`${baseUrl}/api/sub2api/settings`, {
    headers: { "x-console-token": bootstrap.token },
  }).then(async (response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  const persisted = JSON.parse(await fs.readFile(path.join(outputRoot, "sub2api-settings.json"), "utf8"));
  assert.equal(state.configured, true);
  assert.equal(state.hasAdminApiKey, true);
  assert.equal(state.config.baseUrl, legacyConfig.baseUrl);
  assert.deepEqual(state.config.groupIds, legacyConfig.groupIds);
  assert.equal(state.config.wsMode, legacyConfig.wsMode);
  assert.equal(state.config.accountNameTemplate, legacyConfig.accountNameTemplate);
  assert.equal(state.activeProfileId, "default");
  assert.equal(state.profiles.length, 1);
  assert.deepEqual(state.profiles[0].groupIds, legacyConfig.groupIds);
  assert.equal(Object.hasOwn(state.config, "adminApiKey"), false);
  assert.equal(persisted.config.adminApiKey, legacyConfig.adminApiKey);
  assert.equal(persisted.config.baseUrl, legacyConfig.baseUrl);
  assert.equal(persisted.config.wsMode, legacyConfig.wsMode);
  assert.equal(persisted.profiles.length, 1);
  assert.equal(persisted.profiles[0].proxyId, 0);
  const mapping = await fetch(`${baseUrl}/api/plan-type-mapping`, {
    headers: { "x-console-token": bootstrap.token },
  }).then(async (response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(mapping.configured, true);
  assert.equal(mapping.mapping.free, "Free Tier");
  assert.equal(mapping.mapping.self_serve_business_prolite, "Business Premium Custom");
  console.log("Sub2API settings migration smoke passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([onceExit(child), delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function onceExit(processHandle) {
  return new Promise((resolve) => processHandle.once("exit", resolve));
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const portNumber = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return portNumber;
}
