import crypto from "node:crypto";
import fs from "node:fs/promises";

import {
  browserIdentityForTlsProfile,
  TlsFingerprintTransport,
} from "./tls-transport.mjs";

const DEFAULT_CHATGPT_BASE = "https://chatgpt.com";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// chrome142 is the last profile currently accepted by the bundled curl_cffi on x1;
// deployments can override it with TOSUB2_TLS_PROFILE after a profile probe.
const DEFAULT_TLS_PROFILE = "chrome142";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DEVICES = 500;
const MAX_USAGE_TEXT_LENGTH = 128;
const MAX_USAGE_WINDOW_SECONDS = 31_536_000;

/**
 * Read the official ChatGPT usage endpoint through the same OAuth transport
 * used by the session manager. Only the normalized public shape is returned.
 */
export async function fetchAccountUsage(job) {
  const result = await requestWithOAuth(job, "GET", "/wham/usage");
  return {
    ...normalizeAccountUsage(result.data),
    fetchedAt: new Date().toISOString(),
  };
}

export function normalizeAccountUsage(payload) {
  const source = isRecord(payload) ? payload : {};
  const rateLimit = firstRecord(source.rate_limit, source.rateLimit);
  const usage = firstRecord(source.usage, source.message_cap, source.messageCap);
  const primary = normalizeUsageWindow(
    firstRecord(rateLimit?.primary_window, rateLimit?.primaryWindow, usage?.primary_window, usage?.primaryWindow)
      || (hasUsageWindowFields(rateLimit) ? rateLimit : null)
      || (hasUsageWindowFields(usage) ? usage : null),
  );
  const secondary = normalizeUsageWindow(
    firstRecord(rateLimit?.secondary_window, rateLimit?.secondaryWindow, usage?.secondary_window, usage?.secondaryWindow),
  );
  const creditsSource = firstRecord(source.credits, source.credit_grant, source.creditGrant);
  const planType = normalizeUsageText(
    source.plan_type
      || source.planType
      || source.account?.plan_type
      || source.account?.planType,
  );
  return {
    planType: planType || null,
    allowed: firstBoolean(
      rateLimit?.allowed,
      rateLimit?.is_allowed,
      rateLimit?.isAllowed,
      source.allowed,
    ),
    limitReached: firstBoolean(
      rateLimit?.limit_reached,
      rateLimit?.limitReached,
      rateLimit?.is_quota_exceeded,
      rateLimit?.isQuotaExceeded,
      source.limit_reached,
      source.limitReached,
    ),
    primary,
    secondary,
    credits: normalizeUsageCredits(creditsSource),
  };
}

export async function listAccountSessions(job) {
  const result = await requestWithOAuth(job, "GET", "/accounts/sessions?include_trusted_devices=true");
  return {
    showSessionManager: result.data?.show_session_manager !== false,
    devices: normalizeSessionDevices(result.data),
    fetchedAt: new Date().toISOString(),
  };
}

export async function revokeAccountSession(job, input = {}) {
  const sessionId = normalizeIdentifier(input.sessionId);
  const deviceIdHash = normalizeIdentifier(input.deviceIdHash);
  if ((sessionId && deviceIdHash) || (!sessionId && !deviceIdHash)) {
    throw new Error("SESSION_TARGET_INVALID: 必须提供 sessionId 或 deviceIdHash 其中一个");
  }

  const listed = await listAccountSessions(job);
  const target = listed.devices.find((device) => (
    sessionId ? device.sessionId === sessionId : device.deviceIdHash === deviceIdHash
  ));
  if (!target) throw new Error("SESSION_TARGET_NOT_FOUND: 目标设备或会话已不存在，请刷新后重试");
  if (target.isCurrentDevice) throw new Error("SESSION_CURRENT_DEVICE: 当前设备请使用一键登出后再重新登录");
  if (deviceIdHash && !target.isTrustedDevice) {
    throw new Error("SESSION_TARGET_INVALID: 设备信任标识无效");
  }

  const endpoint = deviceIdHash ? "/accounts/trusted_devices/revoke" : "/accounts/sessions/revoke";
  const body = deviceIdHash ? { device_id_hash: deviceIdHash } : { session_id: sessionId };
  await requestWithOAuth(job, "POST", endpoint, body);
  return { ok: true, target: publicSessionDevice(target) };
}

export async function revokeAllAccountSessions(job) {
  await requestWithOAuth(job, "POST", "/accounts/logout_all", {});
  return { ok: true };
}

export function normalizeSessionDevices(payload) {
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  return devices.slice(0, MAX_DEVICES).map((device, index) => normalizeSessionDevice(device, index)).filter(Boolean);
}

export function normalizeSessionDevice(device, index = 0) {
  if (!device || typeof device !== "object") return null;
  const sessionId = normalizeIdentifier(device.session_id);
  const deviceIdHash = normalizeIdentifier(device.hashed_device_id);
  const renderId = normalizeIdentifier(device.render_id);
  if (!sessionId && !deviceIdHash) return null;
  const appSessions = Array.isArray(device.app_sessions)
    ? device.app_sessions
      .map((item) => String(item?.client_name || "").trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  return {
    id: renderId || sessionId || deviceIdHash || `device-${index + 1}`,
    sessionId: sessionId || null,
    deviceIdHash: deviceIdHash || null,
    displayName: publicText(device.display_name, "未知设备"),
    description: publicText(device.human_readable_description, ""),
    platform: publicText(device.platform, ""),
    osVersion: publicText(device.os_version, ""),
    deviceModel: publicText(device.device_model, ""),
    isTrustedDevice: Boolean(device.is_trusted_device),
    isCurrentDevice: Boolean(device.is_current_device),
    canUntrust: Boolean(device.can_untrust),
    lastSignedInTimestamp: normalizeTimestamp(device.last_signed_in_timestamp_second),
    lastSignedInCity: publicText(device.last_signed_in_city, ""),
    lastSignedInRegionCode: publicText(device.last_signed_in_region_code, ""),
    lastSignedInCountry: publicText(device.last_signed_in_country, ""),
    appSessions,
  };
}

function publicSessionDevice(device) {
  return {
    id: device.id,
    displayName: device.displayName,
    isTrustedDevice: device.isTrustedDevice,
    isCurrentDevice: device.isCurrentDevice,
  };
}

async function requestWithOAuth(job, method, endpoint, jsonBody = undefined) {
  const bundle = await readOAuthBundle(job);
  const transport = process.env.NODE_ENV !== "production" && process.env.TOSUB2_SESSION_NATIVE_HTTP === "1"
    ? null
    : new TlsFingerprintTransport({
      enabled: true,
      profile: String(process.env.TOSUB2_TLS_PROFILE || DEFAULT_TLS_PROFILE).trim() || DEFAULT_TLS_PROFILE,
      maxProxySessionAttempts: process.env.CHATGPT_PROXY_MAX_ATTEMPTS || 10,
      sameProxyRiskRetryDelayMs: process.env.CHATGPT_SAME_PROXY_RISK_RETRY_DELAY_MS,
    });
  try {
    await configureTransport(transport, job, bundle.chatgptBase);
    let accessToken = await ensureAccessToken(bundle, transport);
    let response = await sendRequest(transport, bundle.chatgptBase, accessToken, method, endpoint, jsonBody, bundle.accountId);
    if (response.status === 401 && bundle.refreshToken) {
      accessToken = await refreshAccessToken(bundle, transport);
      response = await sendRequest(transport, bundle.chatgptBase, accessToken, method, endpoint, jsonBody, bundle.accountId);
    }
    const data = await parseResponse(response);
    if (!response.ok) throw providerError(response.status, data);
    return { data, status: response.status };
  } finally {
    if (transport) await transport.close();
  }
}

async function configureTransport(transport, job, chatgptBase) {
  if (!transport) return;
  const proxy = String(job?.proxyUrl || "").trim();
  if (proxy) {
    await transport.prepareProxy(proxy, `${chatgptBase}/`);
  } else {
    await transport.configure(null, { force: true });
  }
}

async function sendRequest(transport, chatgptBase, accessToken, method, endpoint, jsonBody, accountId = "") {
  const identity = browserIdentityForTlsProfile(transport?.identityProfile || transport?.profile || DEFAULT_TLS_PROFILE);
  const deviceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "accept-language": identity.acceptLanguage,
    "user-agent": identity.userAgent,
    origin: chatgptBase,
    referer: `${chatgptBase}/`,
    "oai-device-id": deviceId,
    "oai-session-id": sessionId,
    "x-requested-with": "XMLHttpRequest",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    priority: "u=1, i",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const options = {
    method,
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retryRiskControl: true,
  };
  if (jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(jsonBody);
  }
  return transport ? transport.fetch(`${chatgptBase}/backend-api${endpoint}`, options) : fetch(`${chatgptBase}/backend-api${endpoint}`, options);
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Provider returned a non-JSON response" };
  }
}

function providerError(status, data) {
  const raw = data?.error?.message || data?.message || data?.error || `HTTP ${status}`;
  const message = String(raw)
    .replace(/[\r\n]+/g, " ")
    .replace(/(bearer\s+|access_token\s*[=:]\s*|refresh_token\s*[=:]\s*)[^\s,}]+/gi, "$1<redacted>")
    .slice(0, 240);
  return new Error(`SESSION_PROVIDER_ERROR: HTTP ${status}: ${message}`);
}

async function readOAuthBundle(job) {
  if (!job?.outputPath) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 账号没有授权文件");
  let data;
  try {
    data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
  } catch {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 无法读取账号授权文件");
  }
  const account = Array.isArray(data?.accounts) ? data.accounts[0] : null;
  const credentials = account?.credentials;
  if (!credentials || typeof credentials !== "object") {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 授权文件缺少 OAuth 凭据");
  }
  const accessToken = String(credentials.access_token || "").trim();
  const refreshToken = String(credentials.refresh_token || "").trim();
  if (!accessToken && !refreshToken) {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 授权文件缺少访问令牌");
  }
  return {
    data,
    account,
    credentials,
    accessToken,
    refreshToken,
    clientId: String(account?.extra?.client_id || process.env.TOSUB2_CODEX_CLIENT_ID || DEFAULT_CODEX_CLIENT_ID).trim(),
    accountId: normalizeIdentifier(
      credentials.chatgpt_account_id
        || credentials.account_id
        || account?.chatgpt_account_id
        || account?.account_id
        || account?.extra?.chatgpt_account_id
        || account?.extra?.account_id,
    ),
    chatgptBase: String(process.env.CHATGPT_BASE || DEFAULT_CHATGPT_BASE).replace(/\/$/, ""),
    authBase: String(process.env.AUTH_BASE || DEFAULT_AUTH_BASE).replace(/\/$/, ""),
    outputPath: job.outputPath,
  };
}

async function ensureAccessToken(bundle, transport) {
  if (bundle.accessToken && tokenExpiresAfter(bundle.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
    return bundle.accessToken;
  }
  if (!bundle.refreshToken) throw new Error("SESSION_TOKEN_EXPIRED: 访问令牌已过期且没有刷新令牌");
  return refreshAccessToken(bundle, transport);
}

async function refreshAccessToken(bundle, transport) {
  const identity = browserIdentityForTlsProfile(transport?.identityProfile || transport?.profile || DEFAULT_TLS_PROFILE);
  const response = transport
    ? await transport.fetch(`${bundle.authBase}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": identity.userAgent,
        "accept-language": identity.acceptLanguage,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: bundle.clientId,
        refresh_token: bundle.refreshToken,
      }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryRiskControl: true,
    })
    : await fetch(`${bundle.authBase}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": identity.userAgent,
      "accept-language": identity.acceptLanguage,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: bundle.clientId,
      refresh_token: bundle.refreshToken,
    }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    });
  const data = await parseResponse(response);
  if (!response.ok || !data?.access_token) {
    throw new Error(`SESSION_TOKEN_REFRESH_FAILED: OAuth 刷新失败（HTTP ${response.status}）`);
  }
  bundle.credentials.access_token = String(data.access_token);
  if (data.refresh_token) bundle.credentials.refresh_token = String(data.refresh_token);
  if (data.id_token) bundle.credentials.id_token = String(data.id_token);
  await writeOAuthBundle(bundle);
  bundle.accessToken = bundle.credentials.access_token;
  bundle.refreshToken = bundle.credentials.refresh_token || bundle.refreshToken;
  return bundle.accessToken;
}

async function writeOAuthBundle(bundle) {
  const tempPath = `${bundle.outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(bundle.data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, bundle.outputPath);
}

function tokenExpiresAfter(token, seconds) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(claims.exp) > Math.floor(Date.now() / 1000) + seconds;
  } catch {
    return false;
  }
}

function normalizeIdentifier(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= MAX_IDENTIFIER_LENGTH ? text : "";
}

function publicText(value, fallback = "") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.length <= 256 ? text : text.slice(0, 256);
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeUsageWindow(source) {
  if (!isRecord(source)) return null;
  const usedPercent = normalizeUsagePercent(
    firstNumber(source.used_percent, source.usedPercent, source.percent, source.percentage),
  );
  const used = normalizeUsageNumber(firstNumber(source.used, source.used_count, source.usedCount));
  const limit = normalizeUsageNumber(firstNumber(source.limit, source.max, source.total));
  const remaining = normalizeUsageNumber(firstNumber(source.remaining, source.remaining_count, source.remainingCount));
  const limitWindowSeconds = normalizeUsageSeconds(
    firstNumber(source.limit_window_seconds, source.limitWindowSeconds, source.window_seconds, source.windowSeconds),
  );
  const resetAfterSeconds = normalizeUsageSeconds(
    firstNumber(source.reset_after_seconds, source.resetAfterSeconds, source.reset_after, source.resetAfter),
  );
  const resetAt = normalizeUsageDate(source.reset_at ?? source.resetAt);
  if ([usedPercent, used, limit, remaining, limitWindowSeconds, resetAfterSeconds, resetAt].every((value) => value === null)) {
    return null;
  }
  return {
    usedPercent,
    used,
    limit,
    remaining,
    limitWindowSeconds,
    resetAfterSeconds,
    resetAt,
  };
}

function normalizeUsageCredits(source) {
  if (!isRecord(source)) return null;
  const balance = source.balance ?? source.remaining ?? source.amount;
  const normalizedBalance = balance === null || balance === undefined
    ? null
    : normalizeUsageText(balance);
  const hasCredits = firstBoolean(source.has_credits, source.hasCredits);
  const unlimited = firstBoolean(source.unlimited, source.is_unlimited, source.isUnlimited);
  const overageLimitReached = firstBoolean(source.overage_limit_reached, source.overageLimitReached);
  if (normalizedBalance === null && hasCredits === null && unlimited === null && overageLimitReached === null) return null;
  return { balance: normalizedBalance, hasCredits, unlimited, overageLimitReached };
}

function hasUsageWindowFields(source) {
  if (!isRecord(source)) return false;
  return [
    "used_percent",
    "usedPercent",
    "percent",
    "used",
    "limit",
    "remaining",
    "reset_at",
    "resetAt",
    "reset_after_seconds",
    "resetAfterSeconds",
  ].some((key) => source[key] !== undefined && source[key] !== null);
}

function firstRecord(...values) {
  return values.find((value) => isRecord(value)) || null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeUsageNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function normalizeUsagePercent(value) {
  const number = normalizeUsageNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function normalizeUsageSeconds(value) {
  const number = normalizeUsageNumber(value);
  return number === null || number < 0 || number > MAX_USAGE_WINDOW_SECONDS ? null : number;
}

function normalizeUsageDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number <= 0) return null;
  const date = Number.isFinite(number)
    ? new Date(number > 1_000_000_000_000 ? number : number * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUsageText(value) {
  const text = String(value ?? "").trim();
  return text && text.length <= MAX_USAGE_TEXT_LENGTH ? text : text.slice(0, MAX_USAGE_TEXT_LENGTH);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
