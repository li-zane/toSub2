import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CookieJar, ProtocolClient, browserRequestContext, runCodexOauth, resumeCodexOauth,
  validateCodexCallback, exchangeOAuthCode, refreshOAuthToken,
  DEFAULT_CODEX_CLIENT_ID, DEFAULT_CODEX_REDIRECT_URI, CODEX_OAUTH_SCOPE,
} from "../src/protocol-login.mjs";
import { TlsFingerprintTransport } from "../src/tls-transport.mjs";

const workerTest = spawnSync(process.env.TOSUB2_PYTHON || (process.platform === "win32" ? "python" : "python3"),
  [fileURLToPath(new URL("./oauth-transport-worker.py", import.meta.url))],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
assert.equal(workerTest.status, 0, `${workerTest.error || ""}\n${workerTest.stdout}\n${workerTest.stderr}`);
process.stdout.write(workerTest.stdout);

const fallback = new TlsFingerprintTransport({ enabled: true, profile: "chrome146" });
fallback.send = async message => message.operation === "configure" ? { profile: "chrome146" }
  : { status: 200, headers: [], cookies: [], body: "", profile: "chrome142" };
await fallback.request("GET", "https://auth.openai.com/");
assert.equal(fallback.profile, "chrome142");
assert.equal(fallback.identityProfile, "chrome142");
assert.equal(fallback.configuredProfile, "chrome142");
await fallback.close();

const options = {
  authBase: "https://auth.openai.com",
  codexClientId: DEFAULT_CODEX_CLIENT_ID,
  codexRedirectUri: DEFAULT_CODEX_REDIRECT_URI,
};
assert.equal(DEFAULT_CODEX_REDIRECT_URI, "http://127.0.0.1:1455/auth/callback");
assert.equal(CODEX_OAUTH_SCOPE, "openid profile email offline_access api.connectors.read api.connectors.invoke");
const previousOriginator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
let authorizeUrl;
const authorizeClient = {
  async follow(url) {
    authorizeUrl = new URL(url);
    const callback = new URL(authorizeUrl.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", authorizeUrl.searchParams.get("state"));
    return { finalUrl: callback.href };
  },
};
try {
  const login = await runCodexOauth(authorizeClient, options);
  const firstState = login.state;
  assert.equal(authorizeUrl.searchParams.get("originator"), "codex_cli_rs");
  assert.equal(authorizeUrl.searchParams.get("scope"), CODEX_OAUTH_SCOPE);
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(authorizeUrl.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(authorizeUrl.searchParams.has("login_hint"), false);
  assert.equal(authorizeUrl.searchParams.get("code_challenge"), crypto.createHash("sha256").update(login.codeVerifier).digest("base64url"));
  assert.equal(validateCodexCallback(login.callbackUrl, { redirectUri: options.codexRedirectUri, expectedState: firstState }), "test-code");
  const scopedLogin = await runCodexOauth(authorizeClient, {
    ...options, codexOriginator: "test-client", allowedWorkspaceIds: ["one", "two"],
    currentWorkspaceId: "one", loginHint: "fixture@example.com", connection: "test-sso",
  });
  assert.notEqual(scopedLogin.state, firstState);
  assert.equal(authorizeUrl.searchParams.get("originator"), "test-client");
  assert.equal(authorizeUrl.searchParams.get("allowed_workspace_id"), "one,two");
  assert.equal(authorizeUrl.searchParams.get("current_workspace_id"), "one");
  assert.equal(authorizeUrl.searchParams.get("login_hint"), "fixture@example.com");
  assert.equal(authorizeUrl.searchParams.get("connection"), "test-sso");
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "environment-client";
  await runCodexOauth(authorizeClient, { ...options, codexOriginator: "argument-client" });
  assert.equal(authorizeUrl.searchParams.get("originator"), "environment-client");
} finally {
  if (previousOriginator === undefined) delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  else process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = previousOriginator;
}

const validation = { redirectUri: DEFAULT_CODEX_REDIRECT_URI, expectedState: "test-state" };
const callback = `${DEFAULT_CODEX_REDIRECT_URI}?code=ok&state=test-state`;
assert.throws(() => validateCodexCallback(callback.replace("test-state", "wrong"), validation), /OAUTH_STATE_MISMATCH/);
assert.throws(() => validateCodexCallback(`${callback}&state=test-state`, validation), /OAUTH_STATE_MISMATCH/);
assert.throws(() => validateCodexCallback(`${callback}&code=second`, validation), /OAUTH_CODE_MISSING/);
assert.throws(() => validateCodexCallback(callback.replace("127.0.0.1", "localhost"), validation), /OAUTH_CALLBACK_INVALID/);
assert.throws(() => validateCodexCallback(`${callback}#fragment`, validation), /OAUTH_CALLBACK_INVALID/);
assert.throws(() => validateCodexCallback(`${callback}&error=access_denied`, validation), /OAUTH_AUTHORIZATION_REJECTED/);
const resumed = await resumeCodexOauth({}, options, {
  stage: "callback_ready", oauth: { callbackUrl: callback.replace("127.0.0.1", "localhost"), state: "test-state", codeVerifier: "fixture-verifier" },
});
assert.equal(resumed.redirectUri, "http://localhost:1455/auth/callback");

const jar = new CookieJar();
jar.setFromResponse("https://auth.openai.com/api/login", new Headers({ "set-cookie": "host=one; Path=/api; Secure" }));
assert.equal(jar.headerFor("https://auth.openai.com/api/login"), "host=one");
assert.equal(jar.headerFor("https://sub.auth.openai.com/api/login"), "");
assert.equal(jar.headerFor("https://auth.openai.com/apix"), "");
assert.equal(jar.headerFor("http://auth.openai.com/api/login"), "");
jar.setFromResponse("https://auth.openai.com/", new Headers({ "set-cookie": "bad=one; Domain=unrelated.example" }));
assert.equal(jar.has("bad"), false);
const crossSite = browserRequestContext("https://auth.openai.com/oauth/authorize", { referer: "https://chatgpt.com/?code=private#private", navigation: true });
assert.equal(crossSite.referer, "https://chatgpt.com/");
assert.equal(crossSite["sec-fetch-site"], "cross-site");
assert.equal(crossSite["sec-fetch-mode"], "navigate");
assert.equal(browserRequestContext("https://auth.openai.com/api/accounts/session/select", { referer: "https://auth.openai.com/choose-an-account" })["sec-fetch-site"], "same-origin");
assert.equal(browserRequestContext("http://127.0.0.1/callback", { referer: "https://auth.openai.com/" }).referer, undefined);

const requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, method: req.method, headers: req.headers, body });
  res.setHeader("set-cookie", "web-session=private; Path=/");
  if (req.url === "/oauth/token") {
    const payload = req.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    if (payload.code === "redirect") { res.writeHead(302, { location: "/must-not-follow" }); res.end(); return; }
    if (payload.code === "challenge") { res.writeHead(403, { "cf-mitigated": "challenge" }); res.end('{"error":"denied"}'); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id" }));
    return;
  }
  res.end("ok");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const authBase = `http://127.0.0.1:${server.address().port}`;
const transport = new TlsFingerprintTransport({ enabled: true, profile: "chrome142" });
try {
  await transport.request("GET", `${authBase}/web`);
  for (const activeTransport of [transport, null]) {
    await exchangeOAuthCode({ authBase, clientId: options.codexClientId, code: "fixture-code", codeVerifier: "fixture-verifier", redirectUri: options.codexRedirectUri, transport: activeTransport });
    await refreshOAuthToken({ authBase, clientId: options.codexClientId, refreshToken: "fixture-refresh", transport: activeTransport });
    const [exchange, refresh] = requests.slice(-2);
    assert.match(exchange.headers["content-type"], /^application\/x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(exchange.body).get("grant_type"), "authorization_code");
    assert.equal(new URLSearchParams(exchange.body).get("redirect_uri"), options.codexRedirectUri);
    assert.match(refresh.headers["content-type"], /^application\/json/);
    assert.equal(JSON.parse(refresh.body).grant_type, "refresh_token");
    for (const request of [exchange, refresh]) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers["sec-ch-ua"], undefined);
      assert.equal(request.headers["sec-fetch-site"], undefined);
      assert.equal(request.headers.origin, undefined);
      assert.equal(request.headers.referer, undefined);
      assert.equal(request.headers["user-agent"], "toSub2");
    }
    const count = requests.length;
    await assert.rejects(exchangeOAuthCode({ authBase, clientId: options.codexClientId, code: "redirect", codeVerifier: "fixture", redirectUri: options.codexRedirectUri, transport: activeTransport }));
    assert.equal(requests.length, count + 1, "one-time token requests must not follow redirects");
    await assert.rejects(exchangeOAuthCode({ authBase, clientId: options.codexClientId, code: "challenge", codeVerifier: "fixture", redirectUri: options.codexRedirectUri, transport: activeTransport }), /HTTP 403/);
    assert.equal(requests.length, count + 2, "token requests must not retry challenge responses");
  }
  const protocol = new ProtocolClient({ transport });
  await protocol.follow(`${authBase}/document`);
  await protocol.getJson("POST", `${authBase}/oauth/token`, { json: { grant_type: "fixture" } });
  const navigation = requests.at(-2);
  const xhr = requests.at(-1);
  assert.equal(navigation.headers["sec-fetch-dest"], "document");
  assert.equal(navigation.headers["sec-fetch-site"], "none");
  assert.equal(xhr.headers["sec-fetch-mode"], "cors");
  assert.equal(xhr.headers.referer, `${authBase}/document`);
  assert.match(xhr.headers.cookie, /web-session=private/);
  console.log("OAuth parameter, callback and HTTP session tests passed");
} finally {
  await transport.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
