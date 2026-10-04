import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-task-auto-actions-"));
const settingsPath = path.join(outputRoot, "task-settings.json");
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let headers;

try {
  await start();
  const bootstrap = await get("/api/bootstrap");
  assert.deepEqual(bootstrap.taskSettings.autoActions, {});
  assert.deepEqual(bootstrap.taskSettings.autoActionOptions.map((item) => item.value), [
    "upload",
    "rotate-logout-reauthorize-upload",
  ]);

  const saved = await request("/api/task-settings", {
    method: "POST",
    body: {
      maxActiveJobs: 6,
      autoActions: {
        self_serve_business_prolite: ["upload", "rotate-logout-reauthorize-upload"],
        ignored: ["unknown-action"],
      },
    },
  });
  assert.equal(saved.status, 400);
  assert.deepEqual((await get("/api/task-settings")).settings.autoActions, {});

  const valid = await request("/api/task-settings", {
    method: "POST",
    body: {
      maxActiveJobs: 6,
      autoActions: {
        self_serve_business_prolite: ["upload", "rotate-logout-reauthorize-upload"],
        SELF_SERVE_PRO: ["upload"],
      },
    },
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.settings.autoActions, {
    self_serve_business_prolite: ["upload", "rotate-logout-reauthorize-upload"],
    SELF_SERVE_PRO: ["upload"],
  });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), {
    version: 2,
    maxActiveJobs: 6,
    autoActions: {
      self_serve_business_prolite: ["upload", "rotate-logout-reauthorize-upload"],
      SELF_SERVE_PRO: ["upload"],
    },
  });
  await stop();
  await start();
  assert.deepEqual((await get("/api/task-settings")).settings.autoActions, {
    self_serve_business_prolite: ["upload", "rotate-logout-reauthorize-upload"],
    SELF_SERVE_PRO: ["upload"],
  });
  console.log("console task auto-actions smoke passed: validation, file persistence, restart recovery");
} finally {
  await stop();
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function start() {
  child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot, ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-queue-protocol.mjs"), TOSUB2_MAX_ACTIVE_JOBS: "4", TOSUB2_TLS_PROFILE: "chrome142" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) {
        const data = await response.json();
        headers = { "content-type": "application/json", "x-console-token": data.token };
        return;
      }
    } catch {}
    await delay(50);
  }
  throw new Error("server startup timed out");
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(4_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  return response.json();
}

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method,
    headers,
    body: JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: available } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(available));
    });
  });
}
