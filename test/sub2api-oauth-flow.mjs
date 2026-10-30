import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateSub2ApiOAuth, refreshSub2ApiOAuth, sub2ApiOAuthIdentity } from "../src/sub2api-oauth.mjs";
import { runCodexOauth, resumeCodexOauth, buildSub2apiOauthExport, refreshSub2apiOauthExport } from "../src/protocol-login.mjs";

const requests = [];
let generationMode = "valid";
let exchangeStatus = 200;
let exchangeFailure = null;
let refreshFailure = null;
let generation = 0;
const email = "remote-auth@example.com";
const key = "fixture-admin-secret";
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  requests.push({ path: req.url, key: req.headers["x-api-key"], body });
  if (req.headers["x-api-key"] !== key) return send(res, 403, {});
  if (req.url.endsWith("generate-auth-url")) {
    generation++;
    const query = new URLSearchParams({ client_id: "remote-client", redirect_uri: "http://localhost:1455/auth/callback",
      state: `remote-state-${generation}`, code_challenge: "server-owned-challenge", code_challenge_method: "S256", response_type: "code" });
    return send(res, 200, { code: 0, data: { auth_url: `${generationMode === "wrong-origin" ? "https://wrong.invalid" : "https://auth.openai.com"}/oauth/authorize?${query}`,
      ...(generationMode === "missing-session" ? {} : { session_id: `remote-session-${generation}` }) } });
  }
  if (req.url.endsWith("exchange-code")) {
    if (exchangeFailure) return send(res, 400, { reason: "OPENAI_OAUTH_SESSION_NOT_FOUND", message: key });
    if (exchangeStatus !== 200) return send(res, exchangeStatus, { message: `${key}: private-code` });
    assert.ok(body.session_id.startsWith("remote-session-"));
    assert.ok(body.state.startsWith("remote-state-"));
    assert.equal(body.code, "private-code");
    assert.equal(body.redirect_uri, "http://localhost:1455/auth/callback");
    assert.equal(Object.hasOwn(body, "code_verifier"), false);
    return send(res, 200, { code: 0, data: { access_token: "pool-issued-access", refresh_token: "pool-issued-refresh",
      email, client_id: "remote-client", chatgpt_account_id: "remote-account", chatgpt_user_id: "remote-user", expires_at: 1900000000, plan_type: "team" } });
  }
  if (req.url.endsWith("refresh-token")) {
    if (refreshFailure) return send(res, refreshFailure.status, refreshFailure.body);
    assert.equal(body.refresh_token, "pool-issued-refresh");
    assert.equal(body.client_id, "remote-client");
    return send(res, 200, { code: 0, data: { access_token: "pool-refreshed-access", refresh_token: "pool-rotated-refresh", email,
      chatgpt_account_id: "remote-account", plan_type: "team", expires_at: 1900001000 } });
  }
  return send(res, 404, {});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, adminApiKey: key, proxyId: 17 };
const options = { authBase: "https://auth.openai.com", codexRedirectUri: "http://127.0.0.1:1455/auth/callback",
  codexClientId: "local-client-must-not-be-used", codexAuthMode: "sub2api", sub2ApiOAuth: config, expectedEmail: email };
const checkpoints = [];
const client = { async follow(url) {
  const auth = new URL(url);
  assert.equal(auth.searchParams.get("client_id"), "remote-client");
  assert.equal(auth.searchParams.get("code_challenge"), "server-owned-challenge");
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.set("code", "private-code"); callback.searchParams.set("state", auth.searchParams.get("state"));
  return { finalUrl: callback.href };
} };
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sub2api-oauth-"));
try {
  // Keep the existing local export's account-ID convention while adding remote metadata support.
  let localAccountId = "local-session-account";
  const localTransport = { async fetch() { return new Response(JSON.stringify({
    access_token: "local-access", refresh_token: "local-refresh", id_token: `header.${Buffer.from(JSON.stringify({
      sid: localAccountId, email: "local@example.com", sub: "local-subject",
      "https://api.openai.com/auth": { chatgpt_account_id: "local-claim-account", chatgpt_user_id: "local-claim-user", user_id: "local-user" },
    })).toString("base64url")}.signature`,
  }), { status: 200 }); } };
  const local = await buildSub2apiOauthExport({ authBase: options.authBase,
    callbackUrl: "http://localhost:1455/auth/callback?code=local-code&state=local-state",
    redirectUri: "http://localhost:1455/auth/callback", expectedState: "local-state",
    codeVerifier: "local-verifier", clientId: "local-client", transport: localTransport });
  assert.equal(local.account.credentials.chatgpt_account_id, "local-session-account");
  assert.equal(local.account.extra.chatgpt_user_id, "local-user");
  const localOutput = path.join(temp, "local.json");
  await fs.writeFile(localOutput, JSON.stringify(local.data));
  localAccountId = "local-refreshed-account";
  await refreshSub2apiOauthExport({ sourcePath: localOutput, targetPath: localOutput,
    authBase: options.authBase, transport: localTransport });
  assert.equal(JSON.parse(await fs.readFile(localOutput)).accounts[0].credentials.chatgpt_account_id, "local-refreshed-account");

  const oauth = await runCodexOauth(client, { ...options, saveCheckpoint: async (stage, state) => checkpoints.push({ stage, ...state }) });
  assert.equal(oauth.provider, "sub2api");
  assert.equal(oauth.codeVerifier, undefined);
  assert.equal(oauth.sub2ApiBackend, sub2ApiOAuthIdentity(config));
  assert.equal(checkpoints[0].stage, "callback_ready");
  assert.ok(!JSON.stringify(checkpoints).includes(key));
  const resumed = await resumeCodexOauth({}, options, { stage: "callback_ready", oauth });
  assert.equal(resumed.sub2ApiSessionId, oauth.sub2ApiSessionId);
  const exported = await buildSub2apiOauthExport({ authBase: options.authBase, callbackUrl: resumed.callbackUrl,
    redirectUri: resumed.redirectUri, expectedState: resumed.state, clientId: resumed.clientId, sub2ApiOAuth: config, oauth: resumed,
    transport: { fetch() { throw new Error("local token exchange must not run"); } } });
  assert.equal(exported.account.credentials.access_token, "pool-issued-access");
  assert.equal(exported.account.credentials.chatgpt_account_id, "remote-account");
  assert.equal(exported.account.credentials.client_id, "remote-client");
  assert.equal(exported.account.credentials.email, email);
  assert.equal(exported.account.extra.chatgpt_user_id, "remote-user");
  const output = path.join(temp, "sub2api.json");
  // A stale ID token must not override current metadata returned by the backend.
  exported.data.accounts[0].credentials.id_token = `header.${Buffer.from(JSON.stringify({
    email: "old@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "free", chatgpt_account_id: "stale-account" },
  })).toString("base64url")}.signature`;
  await fs.writeFile(output, JSON.stringify(exported.data));
  await refreshSub2apiOauthExport({ sourcePath: output, targetPath: output, sub2ApiOAuth: config });
  const refreshed = JSON.parse(await fs.readFile(output));
  assert.equal(refreshed.accounts[0].credentials.access_token, "pool-refreshed-access");
  assert.equal(refreshed.accounts[0].credentials.refresh_token, "pool-rotated-refresh");
  assert.equal(refreshed.accounts[0].credentials.chatgpt_account_id, "remote-account");
  assert.equal(refreshed.accounts[0].credentials.email, email);
  assert.equal(refreshed.accounts[0].credentials.plan_type, "team");
  assert.equal(refreshed.accounts[0].extra.plan_type, "team");
  assert.equal(refreshed.accounts[0].credentials.expires_at, 1900001000);
  await fs.writeFile(output, JSON.stringify(exported.data));
  const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/protocol-login.mjs", import.meta.url)),
    "--refresh-sub2api", output, "--sub2api-out", output], { env: { ...process.env,
    TOSUB2_CODEX_AUTH_MODE: "sub2api", TOSUB2_OAUTH_BASE_URL: config.baseUrl, TOSUB2_OAUTH_ADMIN_KEY: key,
    TOSUB2_OAUTH_PROXY_ID: "17", CHATGPT_PROXY_URL: "http://127.0.0.1:1", TOSUB2_TLS_PYTHON: "nonexistent-fixture-python" } });
  assert.match(cli.stdout, /Refreshed OAuth account/,
    "remote refresh must not prepare a local login proxy or TLS worker");
  const beforeRefreshFailure = await fs.readFile(output, "utf8");
  for (const failure of [
    { status: 400, body: { error: "invalid_grant", message: key }, invalid: true },
    { status: 401, body: { message: `bad admin key ${key}` }, invalid: false },
    { status: 503, body: { message: `upstream unavailable ${key}` }, invalid: false },
  ]) {
    refreshFailure = failure;
    await assert.rejects(refreshSub2ApiOAuth(config, "pool-issued-refresh", "remote-client"), (error) =>
      error.message.includes("REFRESH_TOKEN_INVALID") === failure.invalid && !error.message.includes(key));
    await assert.rejects(refreshSub2apiOauthExport({ sourcePath: output, targetPath: output, sub2ApiOAuth: config }));
    assert.equal(await fs.readFile(output, "utf8"), beforeRefreshFailure, "failed refresh must preserve the existing export");
  }
  refreshFailure = null;
  assert.ok(requests.every((request) => request.body.proxy_id === 17));
  assert.equal(requests.filter((request) => request.path.endsWith("exchange-code")).length, 1);

  exchangeStatus = 503;
  const failedAt = requests.length;
  await assert.rejects(buildSub2apiOauthExport({ callbackUrl: oauth.callbackUrl, redirectUri: oauth.redirectUri,
    expectedState: oauth.state, sub2ApiOAuth: config, oauth }), (error) => /HTTP 503/.test(error.message) && !error.message.includes(key) && !error.message.includes("private-code"));
  assert.equal(requests.length, failedAt + 1, "authorization code exchange must not be replayed");
  exchangeStatus = 200;
  exchangeFailure = true;
  await assert.rejects(buildSub2apiOauthExport({ callbackUrl: oauth.callbackUrl, redirectUri: oauth.redirectUri,
    expectedState: oauth.state, sub2ApiOAuth: config, oauth }), (error) =>
    /SUB2API_OAUTH_SESSION:.*已过期/.test(error.message) && !error.message.includes(key));
  exchangeFailure = null;
  await assert.rejects(buildSub2apiOauthExport({ callbackUrl: oauth.callbackUrl.replace(oauth.state, "wrong-state"),
    redirectUri: oauth.redirectUri, expectedState: oauth.state, sub2ApiOAuth: config, oauth }), /OAUTH_STATE_MISMATCH/);
  generationMode = "wrong-origin";
  await assert.rejects(generateSub2ApiOAuth(config, options), /来源或路径/);
  generationMode = "missing-session";
  await assert.rejects(generateSub2ApiOAuth(config, options), /session_id/);
  generationMode = "valid";
  const restarted = await resumeCodexOauth(client, options, { stage: "callback_ready", oauth: { ...oauth, provider: undefined, codeVerifier: "old-local-verifier" } });
  assert.equal(restarted.provider, "sub2api", "switching source must not reuse the other provider's PKCE state");
  console.log("Sub2API OAuth flow passed: remote URL, server PKCE, callback/resume, proxy identity, token export/refresh, fresh metadata, no local refresh probe, invalid-grant handling, source switch, fail-closed exchange");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
