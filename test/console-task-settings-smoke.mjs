import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-task-settings-"));
const settingsPath = path.join(outputRoot, "task-settings.json");
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let headers;
let logs = "";

try {
  await start("");
  assert.equal((await readSettings()).maxActiveJobs, 4);
  assert.equal((await fetch(`${baseUrl}/api/task-settings`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/task-settings`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"maxActiveJobs":20}',
  })).status, 403);
  for (const value of [0, 21, 1.5, null, "", "4", true]) {
    assert.equal((await save(value)).status, 400, `reject invalid limit ${JSON.stringify(value)}`);
  }
  assert.equal((await readSettings()).maxActiveJobs, 4);

  const batch = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST", headers,
    body: JSON.stringify({ text: Array.from({ length: 6 }, (_, i) => `queue-${port}-${i}@example.com`).join("\n") }),
  });
  assert.equal(batch.status, 201);
  await waitForCounts(4, 2);
  assert.equal((await save(5)).status, 200);
  let page = await waitForCounts(5, 1);
  const activeIds = page.jobs.filter((job) => job.status === "email_otp").map((job) => job.id);
  assert.equal((await save(2)).status, 200);
  await waitForCounts(5, 1);
  for (const id of activeIds.slice(0, 3)) await cancel(id);
  await waitForCounts(2, 1);
  await cancel(activeIds[3]);
  await waitForCounts(2, 0);
  assert.equal((await fetch(`${baseUrl}/api/jobs/cancel-all`, { method: "POST", headers })).status, 200);
  await waitForCounts(0, 0);

  // A failed disk write must not apply an unpersisted limit, and a later save
  // must recover rather than inheriting the rejected write promise.
  await fs.rename(settingsPath, `${settingsPath}.backup`);
  await fs.mkdir(settingsPath);
  assert.equal((await save(8)).status, 500);
  assert.equal((await readSettings()).maxActiveJobs, 2);
  await fs.rmdir(settingsPath);
  await fs.rename(`${settingsPath}.backup`, settingsPath);
  assert.equal((await save(20)).status, 200);
  assert.equal((await readSettings()).maxActiveJobs, 20);
  assert.equal((await save(1)).status, 200);
  assert.equal((await readSettings()).maxActiveJobs, 1);
  await Promise.all([save(2), save(3), save(4)]);
  assert.equal((await readSettings()).maxActiveJobs, JSON.parse(await fs.readFile(settingsPath, "utf8")).maxActiveJobs);
  assert.equal((await save(3)).status, 200);
  await stop();
  await start("20");
  assert.equal((await readSettings()).maxActiveJobs, 3, "saved UI limit overrides environment on restart");
  assert.equal((await pageData()).taskSettings.maxActiveJobs, 3);
  console.log("console task settings smoke passed: validation, live queue limits, write recovery, persistence");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stop();
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function start(envLimit) {
  child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, ONBOARDING_OUTPUT_ROOT: outputRoot,
      ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-queue-protocol.mjs"),
      TOSUB2_MAX_ACTIVE_JOBS: envLimit, TOSUB2_TLS_PROFILE: "chrome142" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-15_000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-15_000); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) {
        const bootstrap = await response.json();
        assert.equal(bootstrap.features.taskSettings, true);
        headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
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

async function readSettings() { return (await (await fetch(`${baseUrl}/api/task-settings`, { headers })).json()).settings; }
async function pageData() { return (await fetch(`${baseUrl}/api/jobs`, { headers })).json(); }
function save(maxActiveJobs) { return fetch(`${baseUrl}/api/task-settings`, { method: "POST", headers, body: JSON.stringify({ maxActiveJobs }) }); }
async function cancel(id) { assert.equal((await fetch(`${baseUrl}/api/jobs/${id}/cancel`, { method: "POST", headers })).status, 200); }
async function waitForCounts(active, queued) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = await pageData();
    if (page.stats.active === active && page.stats.queued === queued
      && page.jobs.filter((job) => job.status === "email_otp").length === active) return page;
    await delay(50);
  }
  throw new Error(`queue did not reach active=${active}, queued=${queued}`);
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close((error) => error ? reject(error) : resolve(port)); });
  });
}
