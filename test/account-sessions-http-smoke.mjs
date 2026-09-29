import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-session-http-"));
const outputPath = path.join(root, "sub2api-import-oauth.json");
const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3_600 })).toString("base64url");
await fs.writeFile(outputPath, JSON.stringify({
  type: "sub2api-data",
  accounts: [{
    credentials: { access_token: `header.${tokenPayload}.signature`, refresh_token: "mock-refresh", chatgpt_account_id: "acct-test" },
    extra: { client_id: "mock-client" },
  }],
}));

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, accountId: req.headers["chatgpt-account-id"], body });
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url?.startsWith("/backend-api/accounts/sessions")) {
    res.end(JSON.stringify({ show_session_manager: true, devices: [
      { session_id: "us_current", render_id: "render-current", display_name: "Mac", is_current_device: true },
      { session_id: "us_remote", render_id: "render-remote", display_name: "Windows", is_current_device: false },
    ] }));
    return;
  }
  if (req.method === "POST" && req.url === "/backend-api/accounts/sessions/revoke") {
    assert.deepEqual(JSON.parse(body), { session_id: "us_remote" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/backend-api/accounts/logout_all") {
    assert.deepEqual(JSON.parse(body), {});
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/backend-api/wham/usage") {
    res.end(JSON.stringify({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 42.5,
          reset_after_seconds: 1_800,
          reset_at: 1_700_000_000,
        },
        secondary_window: {
          used_percent: 12,
          reset_after_seconds: 86_400,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.TOSUB2_SESSION_NATIVE_HTTP = "1";
process.env.CHATGPT_BASE = `http://127.0.0.1:${port}`;
process.env.AUTH_BASE = `http://127.0.0.1:${port}`;
const {
  fetchAccountUsage,
  listAccountSessions,
  normalizeAccountUsage,
  revokeAccountSession,
  revokeAllAccountSessions,
} = await import("../src/account-sessions.mjs");
const job = { outputPath, proxyUrl: null };

try {
  const listed = await listAccountSessions(job);
  assert.equal(listed.devices.length, 2);
  assert.equal(listed.devices[0].isCurrentDevice, true);
  assert.equal(listed.devices[1].sessionId, "us_remote");
  await revokeAccountSession(job, { sessionId: "us_remote" });
  await revokeAllAccountSessions(job);
  const usage = await fetchAccountUsage(job);
  assert.equal(usage.planType, "pro");
  assert.equal(usage.allowed, true);
  assert.equal(usage.limitReached, false);
  assert.equal(usage.primary.usedPercent, 42.5);
  assert.equal(usage.primary.resetAfterSeconds, 1_800);
  assert.equal(usage.primary.resetAt, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(usage.secondary.usedPercent, 12);
  assert.equal(usage.credits.balance, "12.5");
  assert.equal(Object.hasOwn(usage, "access_token"), false);
  assert.deepEqual(normalizeAccountUsage({}), {
    planType: null,
    allowed: null,
    limitReached: null,
    primary: null,
    secondary: null,
    credits: null,
  });
  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => request.authorization?.startsWith("Bearer header.")));
  assert.ok(requests.every((request) => request.accountId === "acct-test"));
  console.log("account session HTTP smoke passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
