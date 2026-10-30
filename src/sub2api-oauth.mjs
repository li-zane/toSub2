import crypto from "node:crypto";

export function normalizeCodexAuthMode(value) {
  if (value === undefined) return "local";
  if (value !== "local" && value !== "sub2api") throw new Error("Codex 授权方式必须是 local 或 sub2api");
  return value;
}

function normalizeConfig(config) {
  if (!config?.baseUrl || !config?.adminApiKey) throw new Error("SUB2API_OAUTH_CONFIG: 请先保存 Sub2API 后端地址和管理员 API Key");
  const url = new URL(config.baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("SUB2API_OAUTH_CONFIG: Sub2API 后端地址格式错误");
  }
  const proxyId = config.proxyId == null ? null : Number(config.proxyId);
  if (proxyId !== null && (!Number.isSafeInteger(proxyId) || proxyId <= 0)) throw new Error("SUB2API_OAUTH_CONFIG: 代理 ID 格式错误");
  return { baseUrl: url.href.replace(/\/$/, ""), adminApiKey: String(config.adminApiKey), proxyId };
}

export function sub2ApiOAuthIdentity(config) {
  const normalized = normalizeConfig(config);
  return crypto.createHash("sha256").update(`${normalized.baseUrl}\0${normalized.adminApiKey}\0${normalized.proxyId ?? "direct"}`).digest("hex");
}

async function request(config, action, body) {
  const normalized = normalizeConfig(config);
  let response;
  try {
    response = await fetch(`${normalized.baseUrl}/api/v1/admin/openai/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": normalized.adminApiKey },
      body: JSON.stringify({ ...body, ...(normalized.proxyId ? { proxy_id: normalized.proxyId } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(`SUB2API_OAUTH_REQUEST: ${action} 请求失败或超时，请检查号池连接`);
  }
  // Do not include a response body, callback code, or administrator key in errors/logs.
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const reason = [failure?.reason, failure?.code, failure?.error?.code, failure?.error, failure?.message]
      .filter((value) => typeof value === "string").join(" ");
    if (action === "refresh-token" && [400, 401, 403, 502].includes(response.status)
      && /\b(invalid_grant|refresh_token_(expired|reused|invalidated))\b/i.test(reason)) {
      throw new Error("REFRESH_TOKEN_INVALID: Sub2API 刷新令牌已失效，请重新登录授权");
    }
    if (action === "exchange-code" && /\bOPENAI_OAUTH_SESSION_NOT_FOUND\b/.test(reason)) {
      throw new Error("SUB2API_OAUTH_SESSION: 号池授权会话已过期，请重新开始授权");
    }
    throw new Error(`SUB2API_OAUTH_${action === "exchange-code" ? "EXCHANGE" : "REQUEST"}: ${action} 返回 HTTP ${response.status}`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`SUB2API_OAUTH_RESPONSE: ${action} 响应不是 JSON`); }
  if (payload?.code !== undefined && payload.code !== 0 && payload.code !== 200) throw new Error(`SUB2API_OAUTH_RESPONSE: ${action} 返回失败状态`);
  return payload?.data ?? payload;
}

export async function generateSub2ApiOAuth(config, { authBase, expectedEmail } = {}) {
  const payload = await request(config, "generate-auth-url", {});
  if (!payload?.auth_url || !payload?.session_id || typeof payload.session_id !== "string") {
    throw new Error("SUB2API_OAUTH_RESPONSE: 缺少 auth_url 或 session_id");
  }
  const url = new URL(payload.auth_url);
  const base = new URL(authBase || "https://auth.openai.com");
  if (url.origin !== base.origin || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) {
    throw new Error("SUB2API_OAUTH_RESPONSE: 授权链接来源或路径错误");
  }
  const one = (name) => url.searchParams.getAll(name).length === 1 ? url.searchParams.get(name) : null;
  const state = one("state");
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const callback = new URL(redirectUri);
  if (!state || !clientId || !one("code_challenge") || one("code_challenge_method") !== "S256"
    || one("response_type") !== "code" || callback.protocol !== "http:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
    || callback.pathname !== "/auth/callback" || callback.username || callback.password || callback.search || callback.hash) {
    throw new Error("SUB2API_OAUTH_RESPONSE: 授权参数不完整或回调地址错误");
  }
  return { authUrl: url.href, provider: "sub2api", sub2ApiSessionId: payload.session_id, state, clientId, expectedEmail,
    redirectUri, sub2ApiBackend: sub2ApiOAuthIdentity(config), sub2ApiProxyId: normalizeConfig(config).proxyId };
}

export async function exchangeSub2ApiOAuth(config, oauth, code) {
  if (oauth.sub2ApiBackend !== sub2ApiOAuthIdentity(config)) throw new Error("SUB2API_OAUTH_SESSION: 后端或代理配置已变化，请重新开始授权");
  const tokens = await request(config, "exchange-code", { session_id: oauth.sub2ApiSessionId, code, state: oauth.state, redirect_uri: oauth.redirectUri });
  if (!tokens?.access_token || !tokens?.refresh_token) throw new Error("SUB2API_OAUTH_RESPONSE: 号池返回的 OAuth 凭据不完整");
  return tokens;
}

export async function refreshSub2ApiOAuth(config, refreshToken, clientId) {
  const tokens = await request(config, "refresh-token", { refresh_token: refreshToken, ...(clientId ? { client_id: clientId } : {}) });
  if (!tokens?.access_token) throw new Error("SUB2API_OAUTH_RESPONSE: 刷新响应缺少 access_token");
  return tokens;
}
