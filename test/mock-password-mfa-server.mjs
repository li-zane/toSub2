#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] || 4494);
const base = `http://127.0.0.1:${port}`;
const factorId = "0123456789abcdef0123456789abcdef";
const password = "local-test-password";
const totpSecret = "JBSWY3DPEHPK3PXP";
const replacementOldFactorId = "replace-old-factor";
const replacementNewFactorId = "replace-new-factor";
const replacementOldSecret = "GEZDGNBVGY3TQOJQ";
const replacementNewSecret = "MZXW6YTBON2GK3TB";
const organizationWorkspaceId = "workspace-organization";
const personalWorkspaceId = "workspace-personal";
let chatgptWorkspaceSelected = false;
let chatgptLoginComplete = false;
let workspaceSelectionCount = 0;
let selectedEmail = "mfa-test@example.com";
let totpEnabled = false;
let passwordVerifySentinelCount = 0;
let replacementTotpEnabled = true;
let replacementCurrentFactorId = replacementOldFactorId;
let replacementRequestLog = [];
let replacementSessionEmail = "";
let replacementEnrollFailureSent = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", base);
  const body = await readBody(req);

  if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("action") === "enable") {
    res.setHeader("set-cookie", [
      "__Secure-next-auth.session-token=mock-session; Path=/",
    ]);
    return sendText(res, 200, '<html><script>window.__INITIAL_STATE__={"accessToken":"mock-chatgpt-access-token-1234567890"}</script></html>', "text/html");
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.setHeader("set-cookie", [
      "__Host-next-auth.csrf-token=mock-csrf; Path=/",
      "__Secure-next-auth.session-token=mock-session; Path=/",
    ]);
    return sendText(res, 200, "ok");
  }
  if (req.method === "GET" && url.pathname === "/api/auth/providers") return sendJson(res, 200, {});
  if (req.method === "GET" && url.pathname === "/api/auth/csrf") return sendJson(res, 200, { csrfToken: "mock-csrf" });
  if (req.method === "GET" && url.pathname === "/__test/state") {
    return sendJson(res, 200, {
      chatgptLoginComplete,
      chatgptWorkspaceSelected,
      workspaceSelectionCount,
      passwordVerifySentinelCount,
      replacementTotpEnabled,
      replacementRequestLog,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/signin/openai") {
    chatgptWorkspaceSelected = false;
    chatgptLoginComplete = false;
    selectedEmail = url.searchParams.get("login_hint") || selectedEmail;
    if (isReplacementEmail() && selectedEmail !== replacementSessionEmail) {
      replacementTotpEnabled = true;
      replacementCurrentFactorId = replacementOldFactorId;
      replacementRequestLog = [];
      replacementSessionEmail = selectedEmail;
      replacementEnrollFailureSent = false;
    }
    const passwordMode = selectedEmail !== "email-mfa@example.com";
    return sendJson(res, 200, { url: `${base}/api/accounts/authorize?mode=${passwordMode ? "password" : "email"}` });
  }
  if (req.method === "GET" && url.pathname === "/api/accounts/authorize") {
    return redirect(res, `${base}${url.searchParams.get("mode") === "email" ? "/email-verification" : "/log-in/password"}`);
  }
  if (req.method === "GET" && ["/log-in/password", "/email-verification"].includes(url.pathname)) {
    return sendText(res, 200, `<html><title>${url.pathname === "/log-in/password" ? "Enter password" : "Check inbox"}</title></html>`, "text/html");
  }
  if (req.method === "POST" && url.pathname === "/backend-api/sentinel/req") {
    const payload = parseJson(body);
    if (payload.flow !== "password_verify" || typeof payload.id !== "string" || !payload.id) {
      return sendJson(res, 400, { error: { message: "invalid sentinel request" } });
    }
    passwordVerifySentinelCount += 1;
    return sendJson(res, 200, {
      token: "mock-password-verify-challenge",
      proofofwork: { required: false },
      turnstile: { required: false },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/password/verify") {
    const payload = parseJson(body);
    if (!hasPasswordVerifySentinel(req) || payload.password !== password || Object.keys(payload).length !== 1) {
      return sendJson(res, 401, { error: { message: "invalid password" } });
    }
    if (selectedEmail === "setup-totp@example.com") return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "external_url" } });
    return sendJson(res, 200, mfaPayload());
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/email-otp/validate") {
    const payload = parseJson(body);
    if (payload.code !== "123456" || Object.keys(payload).length !== 1) {
      return sendJson(res, 400, { error: { message: "invalid email code" } });
    }
    return sendJson(res, 200, mfaPayload());
  }
  if (req.method === "GET" && url.pathname === "/backend-api/accounts/mfa_info") {
    if (isReplacementEmail()) {
      recordReplacementRequest(req, "mfa_info");
      return sendJson(res, 200, replacementMfaInfo());
    }
    if (selectedEmail === "setup-totp@example.com" && totpEnabled) {
      return sendJson(res, 503, { error: { message: "simulated confirmation failure" } });
    }
    return sendJson(res, 200, {
      mfa_enabled: totpEnabled,
      mfa_enabled_v2: totpEnabled,
      factors: { totp: totpEnabled ? [{ id: "setup-factor", factor_type: "totp" }] : [], push_auth: null, passkeys: [], sms: [] },
    });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/mfa/enroll") {
    if (isReplacementEmail()) {
      const payload = parseJson(body);
      recordReplacementRequest(req, "enroll", payload);
      if (selectedEmail === "replace-totp-enroll-failure@example.com" && !replacementEnrollFailureSent) {
        replacementEnrollFailureSent = true;
        return sendJson(res, 503, { error: { message: "simulated replacement enrollment failure" } });
      }
      if (replacementTotpEnabled || payload.factor_type !== "totp") {
        return sendJson(res, 409, { error: { message: "replacement factor is still enabled" } });
      }
      return sendJson(res, 200, {
        secret: replacementNewSecret,
        session_id: "replace-enroll-session",
        factor: { id: replacementNewFactorId, factor_type: "totp", is_recovery: false },
      });
    }
    if (selectedEmail !== "setup-totp@example.com" || totpEnabled) return sendJson(res, 409, { error: { message: "already enabled" } });
    return sendJson(res, 200, {
      secret: "NB2W45DFOIZAQWER",
      session_id: "mock-enroll-session",
      factor: { id: "setup-factor", factor_type: "totp", is_recovery: false },
    });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
    const payload = parseJson(body);
    if (isReplacementEmail()) {
      recordReplacementRequest(req, "activate", payload);
      const acceptedCodes = [-1, 0, 1].map((offset) => generateTotp(replacementNewSecret, Date.now() + offset * 30_000));
      if (!acceptedCodes.includes(payload.code) || payload.factor_type !== "totp" || payload.session_id !== "replace-enroll-session") {
        return sendJson(res, 400, { error: { message: "invalid replacement setup code" } });
      }
      replacementTotpEnabled = true;
      replacementCurrentFactorId = replacementNewFactorId;
      return sendJson(res, 200, { success: true });
    }
    const acceptedCodes = [-1, 0, 1].map((offset) => generateTotp("NB2W45DFOIZAQWER", Date.now() + offset * 30_000));
    if (!acceptedCodes.includes(payload.code) || payload.factor_type !== "totp" || payload.session_id !== "mock-enroll-session") {
      return sendJson(res, 400, { error: { message: "invalid setup code" } });
    }
    totpEnabled = true;
    return sendJson(res, 200, { success: true });
  }
  if (req.method === "POST" && url.pathname === "/backend-api/accounts/mfa/user/disable_in_house") {
    const payload = parseJson(body);
    if (isReplacementEmail()) {
      recordReplacementRequest(req, "disable", payload);
      if (payload.factor_id !== replacementOldFactorId) {
        return sendJson(res, 400, { error: { message: "unexpected replacement factor" } });
      }
      replacementTotpEnabled = false;
      res.writeHead(204);
      res.end();
      return;
    }
    return sendJson(res, 404, { error: { message: "not found" } });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/mfa/issue_challenge") {
    const payload = parseJson(body);
    if (payload.type !== "totp" || payload.id !== factorId || payload.force_fresh_challenge !== false) {
      return sendJson(res, 400, { error: { message: "invalid challenge request" } });
    }
    return sendJson(res, 200, { "oai-client-auth-session": mfaSession() });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/mfa/verify") {
    const payload = parseJson(body);
    const loginSecret = isReplacementEmail() ? replacementOldSecret : totpSecret;
    const acceptedCodes = [-1, 0, 1].map((offset) => generateTotp(loginSecret, Date.now() + offset * 30_000));
    if (!hasPasswordVerifySentinel(req) || payload.type !== "totp" || payload.id !== factorId || !acceptedCodes.includes(payload.code)) {
      return sendJson(res, 400, { error: { message: "invalid totp" } });
    }
    if (selectedEmail === "skip-workspace@example.com") {
      return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "workspace" } });
    }
    return sendJson(res, 200, {
      continue_url: `${base}/workspace`,
      page: { type: "workspace" },
      "oai-client-auth-session": {
        workspaces: [
          { id: organizationWorkspaceId, kind: "organization" },
          { id: personalWorkspaceId, kind: "personal" },
        ],
      },
    });
  }
  if (req.method === "GET" && url.pathname === "/workspace") {
    return sendText(res, 200, "<html><title>Select workspace</title></html>", "text/html");
  }
  if (req.method === "GET" && url.pathname === "/web-callback") {
    chatgptLoginComplete = true;
    return redirect(res, `${base}/`);
  }
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    return redirect(res, `${base}${chatgptLoginComplete ? "/choose-an-account" : "/log-in"}`);
  }
  if (req.method === "GET" && url.pathname === "/log-in") {
    return sendText(res, 200, "<html><title>Log in</title></html>", "text/html");
  }
  if (req.method === "GET" && url.pathname === "/choose-an-account") {
    return sendText(res, 200, '<html><input name="session_id" value="us_1234567890abcdef"></html>', "text/html");
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/session/select") {
    if (selectedEmail === "direct-codex-callback@example.com") {
      return sendJson(res, 200, {
        continue_url: "http://localhost:1455/auth/callback?code=mock-code&state=mock-state",
        page: { type: "external_url" },
      });
    }
    return sendJson(res, 200, {
      "oai-client-auth-session": {
        workspaces: [
          { id: personalWorkspaceId, kind: "personal" },
          { id: organizationWorkspaceId, kind: "organization" },
        ],
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/workspace/select") {
    const payload = parseJson(body);
    if (!chatgptWorkspaceSelected && selectedEmail !== "skip-workspace@example.com") {
      if (payload.workspace_id !== organizationWorkspaceId) {
        return sendJson(res, 400, { error: { message: "unexpected ChatGPT workspace" } });
      }
      chatgptWorkspaceSelected = true;
      workspaceSelectionCount += 1;
      return sendJson(res, 200, { continue_url: `${base}/web-callback`, page: { type: "external_url" } });
    }
    if (payload.workspace_id !== organizationWorkspaceId) {
      return sendJson(res, 400, { error: { message: "unexpected Codex workspace" } });
    }
    workspaceSelectionCount += 1;
    return sendJson(res, 200, { continue_url: "http://localhost:1455/auth/callback?code=mock-code&state=mock-state" });
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    const idTokenPayload = Buffer.from(JSON.stringify({
      email: selectedEmail,
      sid: "mock-account-id",
      sub: "mock-user-id",
    })).toString("base64url");
    return sendJson(res, 200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      id_token: `e30.${idTokenPayload}.signature`,
    });
  }
  return sendJson(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`[ok] Mock password/MFA server: ${base}`));

function mfaPayload() {
  return {
    continue_url: `${base}/mfa-challenge/${factorId}`,
    page: { type: "mfa_challenge" },
    "oai-client-auth-session": mfaSession(),
  };
}

function isReplacementEmail() {
  return selectedEmail === "replace-totp@example.com"
    || selectedEmail === "replace-totp-enroll-failure@example.com";
}

function replacementMfaInfo() {
  return {
    mfa_enabled: replacementTotpEnabled,
    mfa_enabled_v2: replacementTotpEnabled,
    native_default_factor_id: replacementTotpEnabled ? replacementCurrentFactorId : null,
    factors: {
      totp: replacementTotpEnabled
        ? [{ id: replacementCurrentFactorId, factor_type: "totp", metadata: {} }]
        : [],
      push_auth: null,
      passkeys: [],
      sms: [],
    },
  };
}

function recordReplacementRequest(req, operation, payload = {}) {
  replacementRequestLog.push({
    email: selectedEmail,
    method: req.method,
    operation,
    factor_id: payload.factor_id || null,
    factor_type: payload.factor_type || null,
    session_id: payload.session_id || null,
  });
}

function mfaSession() {
  if (selectedEmail === "skip-workspace@example.com") {
    return {
      mfa_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
      mfa_challenge_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    };
  }
  return {
    mfa_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    mfa_challenge_factors: [{ factor_type: "totp", id: factorId, metadata: {} }],
    workspaces: [
      { id: organizationWorkspaceId, kind: "organization" },
      { id: personalWorkspaceId, kind: "personal" },
    ],
  };
}

function generateTotp(secret, timestamp) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1) & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, "0");
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function hasPasswordVerifySentinel(req) {
  const sentinel = parseJson(req.headers["openai-sentinel-token"]);
  return sentinel.flow === "password_verify"
    && sentinel.c === "mock-password-verify-challenge"
    && typeof sentinel.id === "string"
    && Boolean(sentinel.id);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
