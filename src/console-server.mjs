#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createCredentialStore } from "./credential-store.mjs";
import {
  listAccountSessions,
  revokeAccountSession,
  revokeAllAccountSessions,
  listAccountWorkspaces,
  switchAccountWorkspace,
} from "./account-sessions.mjs";
import {
  fetchMailboxOtpCandidates,
  filterMailboxOtpCandidatesByRequestTime,
  validateMailApiUrl,
} from "./mail-otp.mjs";
import { createSmsProvider, publicSmsProviderDefinitions } from "./sms-providers.mjs";
import { DirectTlsProfileProbe, proxySupportsSessionRotation } from "./tls-transport.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const DEFAULT_MAX_ACTIVE_JOBS = 4;
const MAX_ACTIVE_JOBS_LIMIT = 20;
const DEFAULT_TLS_PROFILE = "chrome146";
const MAX_BATCH_JOBS = 500;
const MAX_PROXY_RISK_RETRIES = 10;
const MAX_PROXY_CONNECTION_FAILURES = 20;
const PROXY_CONNECTION_RETRY_BASE_MS = Math.max(1, Number(process.env.PROXY_CONNECTION_RETRY_BASE_MS || 1_000));
const PROXY_CONNECTION_RETRY_MAX_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS = readDurationEnv("SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS", 15_000, 1_000);
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const TOTP_SETUP_RESULT_FILENAME = "totp-setup-result.json";
const PASSWORD_ADD_RESULT_FILENAME = "password-add-result.json";
const SUB2API_SETTINGS_FILENAME = "sub2api-settings.json";
const SUB2API_MONITOR_FILENAME = "sub2api-monitor.json";
const PLAN_TYPE_MAPPING_FILENAME = "plan-type-mapping.json";
const TASK_SETTINGS_FILENAME = "task-settings.json";
const SUB2API_WS_MODES = new Set(["off", "ctx_pool", "passthrough", "http_bridge"]);
// Profile proxy value meaning "explicitly no proxy".
const SUB2API_PROXY_DIRECT = "direct";
const SUB2API_PROFILE_FIELDS = [
  "groupIds",
  "proxyId",
  "concurrency",
  "loadFactor",
  "priority",
  "accountNameTemplate",
  "modelWhitelist",
  "codexFingerprintMode",
  "wsMode",
];
const SUB2API_TARGET_GROUP_PLATFORMS = ["openai", "composite"];
const SUB2API_ACCOUNT_NAME_TEMPLATE_KEYS = new Set([
  "email",
  "planType",
  "plan_type",
  "accountId",
  "account_id",
  "id",
  "name",
]);
const SUB2API_MONITOR_INTERVAL_MS = readDurationEnv("SUB2API_MONITOR_INTERVAL_MS", 5 * 60_000, 1_000);
const SUB2API_AUTO_REPAIR_COOLDOWN_MS = readDurationEnv("SUB2API_AUTO_REPAIR_COOLDOWN_MS", 5 * 60_000, 0);
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_MAIL_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_MAIL_REQUEST_HEADERS = 64;
const FORBIDDEN_MAIL_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SMS_POLL_INTERVAL_MS = Number(process.env.SMS_POLL_INTERVAL_MS || process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const SMS_POLL_TIMEOUT_MS = Number(process.env.SMS_POLL_TIMEOUT_MS || process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const SUB2API_MONITOR_PATH = path.join(OUTPUT_ROOT, SUB2API_MONITOR_FILENAME);
const SUB2API_SETTINGS_PATH = path.join(OUTPUT_ROOT, SUB2API_SETTINGS_FILENAME);
const PLAN_TYPE_MAPPING_PATH = path.join(OUTPUT_ROOT, PLAN_TYPE_MAPPING_FILENAME);
const TASK_SETTINGS_PATH = path.join(OUTPUT_ROOT, TASK_SETTINGS_FILENAME);
const credentialStore = createCredentialStore();
const consoleToken = crypto.randomBytes(24).toString("base64url");
const jobs = new Map();
const customSmsPoolPositions = new Map();
const emailJobLocks = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;
let maxActiveJobs = initialMaxActiveJobs();
let taskSettingsWritePromise = Promise.resolve();
let shutdownPromise = null;
let sub2ApiSettingsConfig = null;
let sub2ApiMonitorConfig = null;
// Upload profiles share the global Sub2API connection and monitor switch.
// The selected profile only carries account-pool/upload behavior.
let sub2ApiProfiles = new Map();
let sub2ApiPlanTypeBindings = {};
let sub2ApiActiveProfileId = "default";
let planTypeLabelMapping = {};
let planTypeLabelMappingConfigured = false;
let sub2ApiMonitorTimer = null;
let sub2ApiMonitorPromise = null;
let sub2ApiAccountStatusPromise = null;
let sub2ApiAccountStatusCache = {
  backend: null,
  fetchedAt: null,
  accounts: new Map(),
};
let mailRequestConfig = { method: "GET", url: null, headers: {} };
const sub2ApiRequestControllers = new Set();
const sub2ApiRequestPromises = new Set();
const sub2ApiAutoRepairPromises = new Set();
const directTlsProfileProbe = new DirectTlsProfileProbe({
  explicitProfile: process.env.TOSUB2_TLS_PROFILE,
  validationUrl: `${String(process.env.CHATGPT_BASE || "https://chatgpt.com").replace(/\/$/, "")}/`,
});
const sub2ApiMonitorState = {
  running: false,
  lastCheckAt: null,
  nextCheckAt: null,
  lastError: null,
  lastResult: null,
  planTypes: Object.create(null),
  planTypesBackend: null,
};

const hostArg = process.argv.find((item) => item.startsWith("--host="));
const hostIndex = process.argv.indexOf("--host");
const requestedHost = String(
  hostArg?.slice("--host=".length)
    || (hostIndex >= 0 ? process.argv[hostIndex + 1] : "")
    || process.env.ONBOARDING_HOST
    || DEFAULT_HOST,
).trim();
const portArg = process.argv.find((item) => item.startsWith("--port="));
const portIndex = process.argv.indexOf("--port");
const requestedPort = Number(
  portArg?.slice("--port=".length) || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || DEFAULT_PORT,
);
const hmrPort = requestedPort <= 45_535 ? requestedPort + 20_000 : requestedPort - 20_000;

if (!requestedHost || requestedHost.startsWith("--")) {
  throw new Error("--host must be a valid hostname or IP address");
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
await loadTaskSettings();
await loadPlanTypeLabelMapping();
await loadSub2ApiSettingsConfiguration();
await loadSub2ApiMonitorConfiguration();
await syncCompletedOutputs(true);
scheduleQueuedJobs();
scheduleSub2ApiMonitor();

const vite = await createViteServer({
  root: WEB_ROOT,
  configFile: false,
  cacheDir: path.join(OUTPUT_ROOT, ".vite"),
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});

const server = http.createServer(async (req, res) => {
  try {
    enforceUtf8ContentType(res);
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${requestedHost}:${requestedPort}`}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type") {
      value = addUtf8Charset(value);
    }
    return setHeader.call(this, name, value);
  };
}

function addUtf8Charset(value) {
  if (typeof value !== "string" || /;\s*charset=/i.test(value)) return value;
  if (/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i.test(value)) {
    return `${value}; charset=utf-8`;
  }
  return value;
}

server.listen(requestedPort, requestedHost, () => {
  const urls = getConsoleUrls(requestedHost, requestedPort);
  console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
  for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
  console.log(`[info] Output directory: ${OUTPUT_ROOT}`);
  if (isWildcardHost(requestedHost)) {
    console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");
  } else {
    console.log("[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
});

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function getConsoleUrls(host, port) {
  if (!isWildcardHost(host)) return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [
    `http://127.0.0.1:${port}`,
    ...[...new Set(addresses)].map((address) => `http://${address}:${port}`),
  ];
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      token: consoleToken,
      taskSettings: publicTaskSettings(),
      features: {
        retry: true,
        regenerate: true,
        phoneContext: true,
        batchDownload: true,
        bulkActions: true,
        pagination: true,
        uniqueEmail: true,
        smsProviders: publicSmsProviderDefinitions(),
        queue: true,
        taskSettings: true,
        sourceExport: true,
        cancelAll: true,
        sub2apiUpload: true,
        sub2apiPipeline: true,
        sub2apiMonitor: true,
        tlsFingerprint: true,
        totpSetup: true,
        credentialDetails: true,
        totpReplace: true,
        passwordAdd: true,
        forceRelogin: true,
        accountSessions: true,
        accountWorkspaces: true,
        accountUsage: true,
        sub2apiAccountStatus: true,
        sub2apiAccountToggle: true,
        sub2apiAccountPriority: true,
      },
    });
    return;
  }

  if (req.headers["x-console-token"] !== consoleToken) {
    sendJson(res, 403, { error: "Invalid console token" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/task-settings") {
    sendJson(res, 200, { settings: publicTaskSettings() });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/task-settings") {
    const body = await readJson(req);
    const settings = await saveTaskSettings(body?.maxActiveJobs);
    sendJson(res, 200, { settings });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    const requestedPage = Math.max(1, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, null, normalizeJobFilters({
      planType: requestUrl.searchParams.get("planType"),
      sub2apiPool: requestUrl.searchParams.get("sub2apiPool"),
      sub2apiEnabled: requestUrl.searchParams.get("sub2apiEnabled"),
    }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/query") {
    const body = await readJson(req);
    const requestedPage = Math.max(1, Number.parseInt(body.page || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, normalizeEmailFilter(body.emails), normalizeJobFilters(body));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mail-request-config") {
    const body = await readJson(req);
    mailRequestConfig = normalizeMailRequestConfig(body.config);
    sendJson(res, 200, {
      config: {
        method: mailRequestConfig.method,
        urlConfigured: Boolean(mailRequestConfig.url),
        headerCount: Object.keys(mailRequestConfig.headers).length,
      },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    if (!isEmail(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address" });
      return;
    }
    const hasCredentialUpdate = ["password", "mailApiUrl", "mailRequestBody", "totpSecret"].some((key) => Object.hasOwn(body, key));
    const credentials = normalizeLoginCredentials(body);
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const proxyUrl = hasProxyUpdate ? normalizeProxyUrl(body.proxyUrl) : null;
    const result = await withEmailJobLock(email, async () => {
      const existing = findJobByEmail(email);
      if (existing) {
        if (hasCredentialUpdate) await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate });
        else if (hasProxyUpdate) await updateJobProxy(existing, proxyUrl);
        return { job: existing, created: false, updated: hasCredentialUpdate || hasProxyUpdate };
      }
      return { job: await startJob(email, credentials, proxyUrl), created: true, updated: false };
    });
    sendJson(res, result.created ? 201 : 200, { ...result, job: publicJob(result.job) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text, mailRequestConfig);
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) {
        await updateJobCredentials(existing, entry, { proxyUrl, hasProxyUpdate: true });
        return { job: existing, updated: true };
      }
      return { job: await startJob(entry.email, entry, proxyUrl), updated: false };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated).length,
      updated: results.filter((item) => item.updated).length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/download-batch") {
    const body = await readJson(req);
    await downloadBatchResult(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/export-source") {
    const body = await readJson(req);
    await exportSourceAccounts(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/delete-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    sendJson(res, 200, { deleted: emails.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/reauthorize-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const unsupported = selected.find(
      (job) => !["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    );
    if (unsupported) throw httpError(409, `${unsupported.email} 当前仍在进行中，不能重新授权`);
    await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (job.status === "completed") await regenerateJob(job, body);
      else await retryJob(job, body);
    })));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/relogin-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canForceRelogin(job)) return null;
      await forceReloginJob(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能重新登录");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/setup-2fa-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canSetupTotp(job)) return null;
      await startTotpSetup(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号都不能设置 2FA");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/add-password-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canAddPassword(job)) return null;
      await startPasswordAdd(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能添加密码");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/groups") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    sendJson(res, 200, {
      groups: await listSub2ApiTargetGroups(config),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/options") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const [groupPayload, proxyPayload] = await Promise.all([
      listSub2ApiTargetGroups(config),
      requestSub2Api(config, "/api/v1/admin/proxies/all"),
    ]);
    const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
    sendJson(res, 200, {
      groups: groupPayload,
      proxies: proxies
        .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)))
        .map((proxy) => ({
          id: Number(proxy.id),
          name: String(proxy.name || `代理 ${proxy.id}`),
          protocol: String(proxy.protocol || ""),
          host: String(proxy.host || ""),
          port: Number(proxy.port || 0),
          ipAddress: String(proxy.ip_address || ""),
          status: String(proxy.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/upload") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const requestProfileState = normalizeSub2ApiProfileState(body.config, config);
    const selected = resolveSelectedJobs(body.ids);
    const downloadable = selected.filter((job) => job.resultSaved);
    if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");
    const payload = await buildSub2ApiUploadPayload(downloadable);
    const idempotencyKey = `tosub2-upload-${crypto.randomUUID()}`;

    const accountsByProfile = new Map();
    for (const account of payload.accounts) {
      const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(config, account, requestProfileState));
      const { proxy_key: _proxyKey, ...accountData } = account;
      const credentials = { ...(account.credentials || {}) };
      const extra = buildSub2ApiAccountExtra(account.extra, accountConfig);
      const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, account);
      if (accountConfig.modelWhitelist.length) {
        credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
      }
      const prepared = {
        ...accountData,
        ...(accountName ? { name: accountName } : {}),
        credentials,
        extra,
        status: "active",
        schedulable: true,
        group_ids: accountConfig.groupIds.length ? accountConfig.groupIds : (account.group_ids || []),
        ...sub2ApiProxyFields(accountConfig),
        ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
        ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
        ...(accountConfig.priority !== null ? { priority: accountConfig.priority } : {}),
      };
      const profileId = accountConfig.profileId || "default";
      if (!accountsByProfile.has(profileId)) accountsByProfile.set(profileId, { config: accountConfig, accounts: [] });
      accountsByProfile.get(profileId).accounts.push(prepared);
    }
    const results = [];
    let profileBatchIndex = 0;
    let createdCount = 0;
    let updatedCount = 0;
    const updatedAccountIds = [];
    for (const { config: accountConfig, accounts } of accountsByProfile.values()) {
      // Resolve the current pool before uploading. A workspace switch changes
      // the OAuth account id but not the email, so an existing record must be
      // updated by its remote id instead of being sent through batch import.
      // Refuse to fall back to batch when the listing is incomplete; that is
      // the only way to guarantee this upload cannot create a duplicate.
      const listing = await listSub2ApiAccounts(accountConfig, { withMeta: true });
      if (!listing.complete) throw new Error("Sub2API 账号列表不完整，已停止上传以避免创建重复账号");
      const accountsToCreate = [];
      for (const account of accounts) {
        const email = sub2ApiAccountEmail(account);
        const matches = email
          ? listing.accounts.filter((remoteAccount) => sub2ApiAccountEmail(remoteAccount) === email)
          : [];
        if (!matches.length) {
          accountsToCreate.push(account);
          continue;
        }
        for (const remoteAccount of matches) {
          const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
          if (!accountId) continue;
          const accountUpdate = buildSub2ApiAccountUpdate(account, accountConfig, remoteAccount);
          await requestSub2Api(accountConfig, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
            method: "PUT",
            body: JSON.stringify(accountUpdate),
          });
          updatedCount += 1;
          updatedAccountIds.push(accountId);
        }
      }
      if (accountsToCreate.length) {
        createdCount += accountsToCreate.length;
        results.push(await requestSub2Api(accountConfig, "/api/v1/admin/accounts/batch", {
          method: "POST",
          headers: { "Idempotency-Key": `${idempotencyKey}-${profileBatchIndex++}` },
          body: JSON.stringify({ accounts: accountsToCreate }),
        }));
      }
    }
    const result = results.length === 1 ? results[0] : results;
    invalidateSub2ApiAccountStatusCache();

    sendJson(res, 200, {
      selected: selected.length,
      uploaded: downloadable.length,
      skipped: selected.length - downloadable.length,
      created: createdCount,
      updated: updatedCount,
      updatedAccountIds,
      groupIds: config.groupIds,
      result,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/account-status") {
    const forceRefresh = requestUrl.searchParams.get("refresh") === "1";
    const state = await loadSub2ApiAccountStatus({ forceRefresh });
    sendJson(res, 200, publicSub2ApiAccountStatusState(state));
    return;
  }

  const sub2ApiSchedulableMatch = /^\/api\/sub2api\/accounts\/([a-f0-9-]+)\/schedulable$/.exec(requestUrl.pathname);
  if (req.method === "POST" && sub2ApiSchedulableMatch) {
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean") throw httpError(400, "启用状态必须是布尔值");
    const job = jobs.get(sub2ApiSchedulableMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Login flow not found" });
      return;
    }
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const state = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const entry = state.accounts.get(job.email.toLowerCase());
    if (!entry?.accountIds?.length) throw httpError(409, `${job.email} 尚未加入 Sub2API 号池`);
    await Promise.all(entry.accountIds.map((accountId) => requestSub2Api(
      config,
      `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/schedulable`,
      {
        method: "POST",
        body: JSON.stringify({ schedulable: body.enabled }),
      },
    )));
    const nextEntry = {
      ...entry,
      enabled: body.enabled,
      fetchedAt: new Date().toISOString(),
    };
    state.accounts.set(job.email.toLowerCase(), nextEntry);
    state.fetchedAt = new Date().toISOString();
    sendJson(res, 200, { status: publicSub2ApiAccountStatusEntry(nextEntry) });
    return;
  }

  const sub2ApiPriorityMatch = /^\/api\/sub2api\/accounts\/([a-f0-9-]+)\/priority$/.exec(requestUrl.pathname);
  if ((req.method === "POST" || req.method === "PUT") && sub2ApiPriorityMatch) {
    const body = await readJson(req);
    const priority = parseOptionalSub2ApiInteger(body?.priority, "优先级", 0, 10000);
    if (priority === null) throw httpError(400, "优先级必须是 0 到 10000 的整数");
    const job = jobs.get(sub2ApiPriorityMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Login flow not found" });
      return;
    }
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const state = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const entry = state.accounts.get(job.email.toLowerCase());
    const accountIds = [...new Set(entry?.accountIds || [])];
    if (!accountIds.length) throw httpError(409, `${job.email} 尚未加入 Sub2API 号池`);
    try {
      await Promise.all(accountIds.map((accountId) => requestSub2Api(
        config,
        `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ priority }),
        },
      )));
    } finally {
      invalidateSub2ApiAccountStatusCache();
    }
    const refreshedState = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const refreshedEntry = refreshedState.accounts.get(job.email.toLowerCase()) || {
      ...(entry || {}),
      email: job.email.toLowerCase(),
      accountIds,
      priority,
      fetchedAt: new Date().toISOString(),
    };
    sendJson(res, 200, {
      updated: accountIds.length,
      priority,
      status: publicSub2ApiAccountStatusEntry(refreshedEntry),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/settings") {
    sendJson(res, 200, publicSub2ApiSettingsState());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/plan-type-mapping") {
    sendJson(res, 200, {
      configured: planTypeLabelMappingConfigured,
      mapping: { ...planTypeLabelMapping },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan-type-mapping") {
    const body = await readJson(req);
    const mapping = normalizePlanTypeLabelMapping(body.mapping);
    await persistPlanTypeLabelMapping(mapping);
    planTypeLabelMapping = mapping;
    planTypeLabelMappingConfigured = true;
    sendJson(res, 200, {
      configured: true,
      mapping: { ...planTypeLabelMapping },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/settings") {
    const body = await readJson(req);
    const previousProfileState = snapshotSub2ApiProfileState();
    const config = applySub2ApiSettingsBody(body);
    const profileSyncTargets = diffSub2ApiProfileSyncTargets(previousProfileState, snapshotSub2ApiProfileState());
    sub2ApiProxyStateCache.clear();
    if (sub2ApiMonitorConfig) {
      sub2ApiMonitorConfig = { ...config, enabled: sub2ApiMonitorConfig.enabled === true };
      await persistSub2ApiMonitorConfiguration();
    }
    invalidateSub2ApiAccountStatusCache();
    await persistSub2ApiSettingsConfiguration();
    const profileSync = await syncSub2ApiProfileChanges(config, profileSyncTargets, snapshotSub2ApiProfileState());
    sendJson(res, 200, { ...publicSub2ApiSettingsState(), profileSync });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/monitor") {
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor") {
    const body = await readJson(req);
    const previousProfileState = snapshotSub2ApiProfileState();
    const config = applySub2ApiSettingsBody(body);
    const profileSyncTargets = diffSub2ApiProfileSyncTargets(previousProfileState, snapshotSub2ApiProfileState());
    sub2ApiProxyStateCache.clear();
    invalidateSub2ApiAccountStatusCache();
    await persistSub2ApiSettingsConfiguration();
    sub2ApiMonitorConfig = { ...config, enabled: body.enabled === true };
    sub2ApiMonitorState.lastError = null;
    await persistSub2ApiMonitorConfiguration();
    scheduleSub2ApiMonitor();
    const profileSync = await syncSub2ApiProfileChanges(config, profileSyncTargets, snapshotSub2ApiProfileState());
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), profileSync });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor/check") {
    if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "请先启用 Sub2API 号池监控");
    const result = await runSub2ApiMonitor("manual");
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), result });
    return;
  }

  const providerOptionsMatch = /^\/api\/sms-providers\/([a-z0-9_-]+)\/options$/.exec(requestUrl.pathname);
  if (req.method === "POST" && providerOptionsMatch) {
    const body = await readJson(req);
    let smsClient;
    try {
      smsClient = createSmsProvider(providerOptionsMatch[1], body.config, {
        lubanApiBase: process.env.LUBAN_SMS_API_BASE,
        smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      });
      if (!smsClient.listNumberOptions) throw httpError(400, "该接码平台不支持价格查询");
      const options = await smsClient.listNumberOptions();
      sendJson(res, 200, { providerId: smsClient.id, options });
    } catch (error) {
      if (error?.status) throw error;
      throw httpError(502, safeSmsProviderError(error, body.config?.apiKey));
    }
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|relogin|setup-2fa|replace-2fa|add-password|credentials|usage|logs|download|sms-number|luban-number|sessions(?:\/(?:logout|logout-all))?|workspaces(?:\/switch)?))?$/.exec(requestUrl.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "Login flow not found" });
    return;
  }

  const action = match[2];
  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, { id: job.id, logs: job.logs });
    return;
  }
  if (req.method === "GET" && action === "credentials") {
    await reloadMissingJobCredentials(job);
    sendJson(res, 200, { credentials: await publicCredentialDetails(job) });
    return;
  }
  if (req.method === "GET" && action === "sessions") {
    try {
      sendJson(res, 200, { sessions: await listAccountSessions(job) });
    } catch (error) {
      throw sessionApiError(error);
    }
    return;
  }
  if (req.method === "GET" && action === "workspaces") {
    if (!job.resultSaved) throw httpError(409, "账号授权尚未完成，暂时无法读取工作空间");
    try {
      sendJson(res, 200, { workspaces: await listAccountWorkspaces(job) });
    } catch (error) {
      throw sessionApiError(error);
    }
    return;
  }
  if (req.method === "POST" && action === "workspaces/switch") {
    const body = await readJson(req);
    const workspaceId = normalizeSub2ApiAccountId(body?.workspaceId);
    if (!workspaceId) throw httpError(400, "工作空间 ID 无效");
    await withEmailJobLock(job.email, async () => {
      if (!job.resultSaved || !canForceRelogin(job)) {
        throw httpError(409, "当前账号不能切换工作空间，请等待当前操作完成");
      }
      const available = await listAccountWorkspaces(job);
      const target = available.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target || target.canAccess === false || target.deactivated) {
        throw httpError(409, "该工作空间当前不可用或已失去授权");
      }
      const result = await switchAccountWorkspace(job, workspaceId);
      job.workspacePlanType = result.planType || target.planType || null;
      recordJobOperation(job, "workspace_switch");
      job.prompt = `已切换到 ${target.name || target.id}`;
      touch(job);
      await saveJobMetadata(job);
      // A workspace switch changes the OAuth account identity and PlanType in
      // the local import file. If this account already exists in Sub2API,
      // update those existing records in place so a later upload cannot create
      // a second account for the same email and leave the pool out of sync.
      let sub2api = null;
      try {
        sub2api = await synchronizeSub2ApiWorkspaceAccount(job);
        if (sub2api?.updated) {
          appendJobLog(job, `[workspace] 已同步更新 Sub2API 号池中的 ${sub2api.updated} 条账号记录。\n`);
          touch(job);
          await saveJobMetadata(job);
        }
        // Refresh the status snapshot before returning the job so the UI
        // immediately shows the preserved remote id and new PlanType. This is
        // also needed when no matching remote row exists, otherwise an older
        // cached pool entry could survive the workspace switch response.
        if (sub2api?.configured) {
          try {
            await loadSub2ApiAccountStatus({ forceRefresh: true });
          } catch (error) {
            sub2api.statusRefreshError = String(error?.message || error).slice(0, 500);
          }
        }
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        sub2api = { configured: true, matched: 0, updated: 0, accountIds: [], error: message };
        appendJobLog(job, `[workspace] 工作空间已切换，但同步 Sub2API 号池失败：${message}\n`);
        touch(job);
        await saveJobMetadata(job);
      }
      sendJson(res, 200, { job: publicJob(job), workspaces: result, sub2api });
      return;
    });
    return;
  }
  if (req.method === "GET" && action === "usage") {
    if (!job.resultSaved) throw httpError(409, "账号授权尚未完成，暂时没有可读取的 Sub2API 用量");
    try {
      const usage = await getAccountUsage(job, requestUrl.searchParams.get("refresh") === "1");
      sendJson(res, 200, { usage });
    } catch (error) {
      throw accountUsageApiError(error);
    }
    return;
  }
  if (req.method === "GET" && action === "download") {
    await downloadResult(res, job);
    return;
  }
  if (req.method === "POST" && ["sms-number", "luban-number"].includes(action)) {
    const body = await readJson(req);
    const providerId = action === "luban-number" ? "luban" : body.providerId;
    const config = action === "luban-number"
      ? { apiKey: body.apiKey, serviceId: body.serviceId }
      : body.config;
    await withEmailJobLock(job.email, () => acquireSmsNumber(job, providerId, config));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    await withEmailJobLock(job.email, () => cancelJob(job));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => retryJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => regenerateJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "relogin") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => forceReloginJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "setup-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "sessions/logout") {
    const body = await readJson(req);
    let result;
    try {
      result = await withEmailJobLock(job.email, () => revokeAccountSession(job, body));
    } catch (error) {
      throw sessionApiError(error);
    }
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && action === "sessions/logout-all") {
    let result;
    try {
      result = await withEmailJobLock(job.email, () => revokeAllAccountSessions(job));
    } catch (error) {
      throw sessionApiError(error);
    }
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && action === "replace-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, { ...body, replaceExisting: true }));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "PUT" && action === "credentials") {
    const body = await readJson(req);
    let persisted = false;
    await withEmailJobLock(job.email, async () => {
      persisted = await updateStoredCredentialFields(job, body);
    });
    sendJson(res, 200, { credentials: await publicCredentialDetails(job, persisted), job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "add-password") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startPasswordAdd(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "input") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => submitJobInput(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function sendJobsPage(res, requestedPage, emailFilter = null, filters = {}) {
  await syncCompletedOutputs();
  if (filters.planType || filters.sub2apiPool || filters.sub2apiEnabled) {
    try {
      await loadSub2ApiAccountStatus();
    } catch (error) {
      if (filters.sub2apiPool || filters.sub2apiEnabled) throw error;
    }
  }
  const allJobs = listUniqueJobs();
  const emailSet = emailFilter?.length ? new Set(emailFilter) : null;
  const visibleJobs = allJobs.filter((job) => {
    if (emailSet && !emailSet.has(job.email.toLowerCase())) return false;
    return matchesJobFilters(job, filters);
  });
  const total = visibleJobs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * PAGE_SIZE;
  sendJson(res, 200, {
    jobs: visibleJobs.slice(start, start + PAGE_SIZE).map(publicJob),
    selection: visibleJobs.map(publicSelectionJob),
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages, totalAll: allJobs.length },
    filter: {
      active: Boolean(emailSet || filters.planType || filters.sub2apiPool || filters.sub2apiEnabled),
      requested: emailFilter?.length || 0,
      matched: total,
      planType: filters.planType || "",
      sub2apiPool: filters.sub2apiPool || "",
      sub2apiEnabled: filters.sub2apiEnabled || "",
    },
    filterOptions: {
      planTypes: [...new Set(allJobs.map((job) => getJobPlanType(job)).filter(Boolean))].sort(),
    },
    stats: {
      active: allJobs.filter(occupiesActiveSlot).length,
      queued: allJobs.filter((job) => job.status === "queued").length,
      completed: allJobs.filter((job) => job.status === "completed").length,
    },
    taskSettings: publicTaskSettings(),
  });
}

function normalizeJobFilters(value) {
  const source = value && typeof value === "object" ? value : {};
  const planTypeValue = String(source.planType || "").trim();
  const sub2apiPoolValue = String(source.sub2apiPool || "").trim().toLowerCase();
  const sub2apiEnabledValue = String(source.sub2apiEnabled || "").trim().toLowerCase();
  const allowedPoolValues = new Set(["added", "not_added", "unknown"]);
  const allowedEnabledValues = new Set(["enabled", "disabled", "unknown"]);
  return {
    planType: planTypeValue || null,
    sub2apiPool: allowedPoolValues.has(sub2apiPoolValue) ? sub2apiPoolValue : null,
    sub2apiEnabled: allowedEnabledValues.has(sub2apiEnabledValue) ? sub2apiEnabledValue : null,
  };
}

function matchesJobFilters(job, filters) {
  if (filters.planType) {
    const actualPlanType = getJobPlanType(job) || "__unknown__";
    if (actualPlanType !== filters.planType) return false;
  }
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  if (filters.sub2apiPool === "added" && sub2ApiStatus.inPool !== true) return false;
  if (filters.sub2apiPool === "not_added" && sub2ApiStatus.inPool !== false) return false;
  if (filters.sub2apiPool === "unknown" && sub2ApiStatus.inPool !== null) return false;
  if (filters.sub2apiEnabled === "enabled" && sub2ApiStatus.enabled !== true) return false;
  if (filters.sub2apiEnabled === "disabled" && sub2ApiStatus.enabled !== false) return false;
  if (filters.sub2apiEnabled === "unknown" && sub2ApiStatus.enabled !== null) return false;
  return true;
}

function normalizeEmailFilter(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请至少输入一个筛选邮箱");
  if (value.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多筛选 ${MAX_BATCH_JOBS} 个邮箱`);
  const unique = new Set();
  value.forEach((item, index) => {
    const email = String(item || "").trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 个筛选邮箱格式错误`);
    unique.add(email);
  });
  return [...unique];
}

async function startJob(email, credentials = {}, proxyUrl = null) {
  const { loginMode, mailApiUrl, mailRequestBody, password, totpSecret } = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, { password, totpSecret, proxyUrl });
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
  const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
  const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
  await fs.mkdir(outputDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const job = {
    id,
    email,
    status: "queued",
    prompt: "已加入任务队列",
    createdAt,
    updatedAt: createdAt,
    lastOperationAt: createdAt,
    lastOperationType: "initial_authorization",
    completedAt: null,
    outputPath,
    checkpointPath,
    totpResultPath,
    passwordAddResultPath,
    logs: "",
    lastError: null,
    child: null,
    parserTail: "",
    resultSaved: false,
    planType: null,
    loginMode,
    password,
    totpSecret,
    hasPasswordCredential: Boolean(password),
    hasTotpCredential: Boolean(totpSecret),
    proxyUrl,
    mailApiUrl,
    mailRequestBody,
    mailSeenCandidateKeys: new Set(),
    mailCandidateCounts: new Map(),
    mailStatus: mailApiUrl ? "baseline" : "manual",
    mailApiError: null,
    mailPollRunning: false,
    mailPollToken: null,
    mailOtpRequestedAt: null,
    currentPhone: null,
    phoneError: null,
    restartRequired: false,
    attempt: 1,
    runId: null,
    runMode: null,
    queuedMode: "full",
    queuedAt: new Date().toISOString(),
    queuedStartPrompt: "正在建立登录会话",
    directTlsFallbackAttempted: false,
    fallbackInProgress: false,
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpSetupReplaceExisting: false,
    totpRotationRemoteDisabled: false,
    totpRotationStage: null,
    totpRotationIncomplete: false,
    totpSetupResumesAuthorization: false,
    passwordAddError: null,
    passwordAddedAt: null,
    pendingNewPassword: null,
    passwordAddResumesAuthorization: false,
    loginCheckpointAvailable: false,
    totpKnownEnabled: false,
    totpSetupAttempt: 0,
    totpResultLoading: false,
    proxyRiskRetryCount: 0,
    proxyConnectionFailureCount: 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    queueRunId: null,
    startedAt: null,
    lastAuthAutomated: false,
    lastAuthAutomationReason: "尚未完成可验证的全自动登录",
    lastAuthAutomatedAt: null,
    lastAuthRequirements: null,
    authAutomationAttempt: null,
    autoRepairBlocked: false,
    autoRepairBlockedReason: null,
    autoRepairBlockedAt: null,
    autoRepairLastAttemptAt: null,
    autoRepairLastSuccessAt: null,
    autoRepairLastError: null,
    autoRepairPendingAccountIds: [],
    autoRepairPendingBackend: null,
    autoRepairOperation: null,
    ...newSmsState(),
  };
  beginAuthorizationAutomationAttempt(job, "initial");
  jobs.set(id, job);
  await saveJobMetadata(job);
  scheduleQueuedJobs();
  return job;
}

function scheduleQueuedJobs() {
  if (shuttingDown || queueSchedulingPaused) return;
  let availableSlots = maxActiveJobs - [...jobs.values()].filter(occupiesActiveSlot).length;
  if (availableSlots <= 0) return;
  const queuedJobs = [...jobs.values()]
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
  for (const job of queuedJobs.slice(0, availableSlots)) {
    const mode = job.queuedMode || "full";
    const queueRunId = crypto.randomUUID();
    job.queueRunId = queueRunId;
    job.status = mode === "refresh"
      ? "refreshing"
      : mode === "totp_setup"
        ? "totp_starting"
        : mode === "password_add"
          ? "password_add_starting"
          : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : mode === "totp_setup"
        ? "正在重新验证账号并准备设置 2FA"
        : mode === "password_add"
          ? "正在重新验证账号并准备添加密码"
          : "正在建立登录会话");
    job.queuedAt = null;
    job.startedAt = new Date().toISOString();
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode, queueRunId);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
}

async function prepareAndLaunchJob(job, mode, queueRunId) {
  try {
    if (["full", "totp_setup", "password_add"].includes(mode) && job.mailApiUrl) await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    launchJob(job, { mode });
  } catch (error) {
    if (mode === "totp_setup") {
      await restoreTotpSetupFailure(job, `准备 2FA 设置失败：${error.message}`);
    } else if (mode === "password_add") {
      restorePasswordAddFailure(job, `准备添加密码失败：${error.message}`);
    } else {
      failJob(job, `准备登录任务失败：${error.message}`);
    }
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
  job.queueRunId = null;
  job.status = "queued";
  job.prompt = "已加入任务队列";
  job.queuedMode = mode;
  job.queuedAt = new Date().toISOString();
  job.queuedStartPrompt = startPrompt;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function launchJob(job, options = {}) {
  const mode = options.mode || "full";
  if (mode === "full" && !job.authAutomationAttempt) {
    beginAuthorizationAutomationAttempt(job, "login");
  }
  const runId = crypto.randomUUID();
  job.runId = runId;
  job.runMode = mode;
  job.mailOtpRequestedAt = null;
  const args = mode === "refresh"
    ? [
        PROTOCOL_SCRIPT,
        "--refresh-sub2api",
        job.outputPath,
        "--sub2api-out",
        job.outputPath,
        "--verbose",
      ]
    : mode === "totp_setup"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          job.totpSetupReplaceExisting ? "--replace-totp" : "--setup-totp",
          "--totp-result",
          job.totpResultPath,
          ...(job.totpSetupResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : mode === "password_add"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--add-password",
          "--password-add-result",
          job.passwordAddResultPath,
          ...(job.passwordAddResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : [
        PROTOCOL_SCRIPT,
        "--email",
        job.email,
        "--output-mode",
        "sub2api",
        "--sub2api-out",
        job.outputPath,
        "--checkpoint",
        job.checkpointPath,
        "--resume-checkpoint",
        job.checkpointPath,
        "--verbose",
      ];
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      CHATGPT_LOGIN_PASSWORD: job.password || "",
      CHATGPT_TOTP_SECRET: job.totpSecret || "",
      CHATGPT_NEW_PASSWORD: mode === "password_add" ? job.pendingNewPassword || "" : "",
      CHATGPT_PROXY_URL: job.proxyUrl || "",
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(0, MAX_PROXY_RISK_RETRIES - (job.proxyRiskRetryCount || 0))),
      TOSUB2_TLS_PROFILE:
        String(process.env.TOSUB2_TLS_PROFILE || "").trim()
        || (!job.proxyUrl ? String(options.tlsProfile || DEFAULT_TLS_PROFILE) : ""),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;

  child.stdout.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    void withEmailJobLock(job.email, async () => {
      if (job.runId !== runId) return;
      if (mode === "totp_setup") await restoreTotpSetupFailure(job, `无法启动 2FA 设置进程：${error.message}`);
      else if (mode === "password_add") restorePasswordAddFailure(job, `无法启动添加密码进程：${error.message}`);
      else failJob(job, `无法启动登录进程：${error.message}`);
    });
  });
  child.on("close", (code, signal) => {
    void withEmailJobLock(job.email, () => handleChildClose(job, { code, signal, mode, runId }))
      .catch((error) => {
        void handleChildCloseFailure(job, mode, runId, error);
      });
  });
}

async function handleChildClose(job, { code, signal, mode, runId }) {
  if (job.runId !== runId) return;
  stopMailPolling(job);
  job.child = null;
  if (mode === "totp_setup") {
    await finishTotpSetup(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (mode === "password_add") {
    await finishPasswordAdd(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (["canceled", "reauth_required"].includes(job.status)) {
    await finishSub2ApiAutoRepairFailure(job);
    scheduleQueuedJobs();
    return;
  }
  if (code === 0 && job.resultSaved && (await fileExists(job.outputPath))) {
    job.planType = await readPlanTypeFromOutput(job.outputPath);
    if (mode === "full") completeAuthorizationAutomationAttempt(job);
    job.loginCheckpointAvailable = false;
    job.status = "completed";
    job.prompt = "授权完成，可以下载导入文件";
    job.completedAt = new Date().toISOString();
    touch(job);
    await saveJobMetadata(job);
    await finishSub2ApiAutoRepairSuccess(job);
    scheduleQueuedJobs();
    return;
  }
  if (job.status !== "failed") {
    if (await fileExists(job.checkpointPath)) {
      markResumeAvailable(job, signal ? `登录进程被 ${signal} 终止` : "登录流程中断");
    } else {
      failJob(job, signal ? `登录进程被 ${signal} 终止` : `登录进程退出，代码 ${code ?? "未知"}`);
    }
  }
  await finishSub2ApiAutoRepairFailure(job);
  scheduleQueuedJobs();
}

function handleChildCloseFailure(job, mode, runId, error) {
  if (job.runId !== runId && !(["totp_setup", "password_add"].includes(mode) && job.runId === null)) return;
  const message = `收尾处理失败：${error.message}`;
  if (mode === "totp_setup") {
    const replacingTotp = Boolean(job.totpSetupReplaceExisting);
    if (replacingTotp) job.totpRotationIncomplete = true;
    job.status = "completed";
    job.prompt = replacingTotp && job.totpRotationRemoteDisabled
      ? "原 2FA 状态可能已关闭，新 2FA 尚未激活；可以重试更换流程"
      : "原授权文件仍然可用，2FA 密钥尚未完成安全保存";
    job.totpSetupError = replacingTotp && job.totpRotationRemoteDisabled
      ? `${message}；远端 2FA 状态可能已关闭，结果文件已保留`
      : `${message}；已保留 2FA 结果文件，请重试保存`;
    job.totpRotationStage = replacingTotp ? (job.totpRotationStage || "failed") : null;
    job.totpSetupReplaceExisting = false;
    job.runMode = null;
    job.runId = null;
  } else if (mode === "password_add") {
    restorePasswordAddFailure(job, message);
  } else {
    failJob(job, message);
  }
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function retryJob(job, options = {}) {
  if (!["failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    const persisted = await saveStoredLoginCredentials(job.email, job);
  }
  const resumingCheckpoint = job.status === "resume_available"
    || (retryingSecurityCheck && await fileExists(job.checkpointPath));
  stopMailPolling(job);
  if (resumingCheckpoint) stopSmsPolling(job);
  else releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.smsNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  clearAutoRepairBlock(job);
  job.autoRepairOperation = null;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  beginAuthorizationAutomationAttempt(job, "manual_retry");
  recordJobOperation(job, resumingCheckpoint ? "resume" : "reauthorize");
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

async function regenerateJob(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseSmsNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  recordJobOperation(job, "reauthorize");
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

async function forceReloginJob(job, options = {}, context = {}) {
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  await reloadMissingJobCredentials(job);
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  await Promise.all([
    removePrivateFile(job.checkpointPath),
    removePrivateFile(job.totpResultPath),
  ]);
  job.loginCheckpointAvailable = false;
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  job.attempt += 1;
  if (!context.autoRepair) {
    clearAutoRepairBlock(job);
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
  }
  job.autoRepairOperation = context.autoRepair || null;
  if (context.autoRepair) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [...new Set(context.autoRepair.accountIds || [])];
    job.autoRepairPendingBackend = context.autoRepair.backend || null;
  }
  beginAuthorizationAutomationAttempt(job, context.autoRepair ? "sub2api_monitor" : "manual_relogin");
  recordJobOperation(job, context.autoRepair ? "automatic_relogin" : "relogin");
  appendJobLog(job, `\n[relogin] 第 ${job.attempt} 次授权：跳过刷新令牌并强制重新登录。\n`);
  if (job.hasTotpCredential && !job.totpSecret) {
    appendJobLog(job, "[mfa] 本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。\n");
  }
  enqueueJob(job, "full", "正在强制重新登录并完成授权");
}

async function reloadMissingJobCredentials(job) {
  if (
    (job.password || !job.hasPasswordCredential)
    && (job.totpSecret || !job.hasTotpCredential)
    && job.proxyUrl
  ) return;
  const stored = await loadStoredLoginCredentials(job.email);
  job.password ||= stored.password;
  job.totpSecret ||= stored.totpSecret;
  job.proxyUrl ||= stored.proxyUrl;
  if (job.password) job.hasPasswordCredential = true;
  if (job.totpSecret) job.hasTotpCredential = true;
  if (stored.password || stored.totpSecret || stored.proxyUrl) {
    await saveStoredLoginCredentials(job.email, job);
  }
}

async function startTotpSetup(job, options = {}) {
  const replaceExisting = Boolean(options.replaceExisting);
  await reloadMissingJobCredentials(job);
  if (replaceExisting) {
    if (!canReplaceTotp(job)) {
      throw httpError(409, "只能为已完成授权且已知启用 2FA 的账号更换 2FA");
    }
  } else {
    if (!canSetupTotp(job)) {
      throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未设置 2FA 的账号设置 2FA");
    }
    if (job.totpSecret || job.hasTotpCredential) {
      throw httpError(409, "该账号已经保存了 2FA 密钥，无需重复设置");
    }
    if (job.totpKnownEnabled) {
      throw httpError(409, "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建");
    }
  }
  const resumeAuthorization = replaceExisting ? false : !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  const resumeDisabledRotation = replaceExisting
    && await hasIncompleteRemoteTotpRotation(job.totpResultPath, job.totpRotationRemoteDisabled);
  if (!resumeDisabledRotation) await removePrivateFile(job.totpResultPath);
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.totpSetupReplaceExisting = replaceExisting;
  job.totpRotationRemoteDisabled = resumeDisabledRotation;
  job.totpRotationStage = resumeDisabledRotation ? "disabled" : (replaceExisting ? "starting" : null);
  job.totpRotationIncomplete = replaceExisting;
  job.totpSetupAttempt = (job.totpSetupAttempt || 0) + 1;
  job.totpSetupResumesAuthorization = resumeAuthorization;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, replaceExisting ? "replace_2fa" : "setup_2fa");
  appendJobLog(
    job,
    replaceExisting
      ? `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 更换；原授权文件保持不变，失败时可能需要重新启用 2FA。\n`
      : `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 设置，原授权文件保持不变。\n`,
  );
  enqueueJob(job, "totp_setup", replaceExisting ? "正在重新验证账号并更换 2FA" : "正在重新验证账号并准备设置 2FA");
}

async function hasIncompleteRemoteTotpRotation(resultPath, metadataFlag = false) {
  if (metadataFlag) return fileExists(resultPath);
  try {
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    return result?.version === 1
      && result?.operation === "replace_totp"
      && result?.activation_succeeded !== true
      && (result?.remote_disabled === true || result?.stage === "disabling");
  } catch {
    return false;
  }
}

async function startPasswordAdd(job, options = {}) {
  if (!canAddPassword(job)) {
    throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未保存密码的账号添加密码");
  }
  const resumeAuthorization = !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  await removePrivateFile(job.passwordAddResultPath);
  job.pendingNewPassword = generateStrongPassword();
  job.passwordAddResumesAuthorization = resumeAuthorization;
  job.passwordAddError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, "add_password");
  appendJobLog(job, "\n[password-add] 开始为无密码账号添加密码，新密码不会写入协议日志。\n");
  enqueueJob(job, "password_add", "正在重新验证账号并准备添加密码");
}

function generateStrongPassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#%_";
  const all = `${lower}${upper}${digits}${symbols}`;
  const chars = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];
  while (chars.length < 18) chars.push(all[crypto.randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join("");
}

async function finishPasswordAdd(job, code, signal) {
  let result = null;
  try {
    result = JSON.parse(await fs.readFile(job.passwordAddResultPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") job.passwordAddError = `添加密码结果无法读取：${error.message}`;
  }

  if (
    result?.version === 1
    && String(result.email || "").toLowerCase() === job.email.toLowerCase()
    && typeof result.password === "string"
    && result.password === job.pendingNewPassword
  ) {
    job.password = result.password;
    job.hasPasswordCredential = true;
    job.loginMode = "password";
    job.passwordAddedAt = result.added_at || new Date().toISOString();
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.passwordAddError = persisted
      ? null
      : "当前系统不支持持久凭据存储，新密码仅在本次服务运行期间可用";
    job.prompt = persisted
      ? job.passwordAddResumesAuthorization
        ? "密码添加成功，可以继续未完成的 Codex 授权"
        : "密码添加成功，账号原始信息已经更新"
      : "密码添加成功，但新密码未能持久保存";
    appendJobLog(job, persisted
      ? "[password-add] 密码添加成功，新密码已安全保存，未写入协议日志。\n"
      : "[password-add] 密码添加成功，但当前系统不支持持久保存新密码。\n");
    if (persisted) await removePrivateFile(job.passwordAddResultPath);
  } else {
    job.prompt = job.passwordAddResumesAuthorization
      ? "本次添加密码未完成，原登录检查点仍可继续"
      : "原授权文件仍可使用，本次添加密码未完成";
    job.passwordAddError ||= signal
      ? `添加密码进程被 ${signal} 终止`
      : `添加密码进程退出，代码 ${code ?? "未知"}`;
    await removePrivateFile(job.passwordAddResultPath);
  }

  job.status = job.passwordAddResumesAuthorization ? "resume_available" : "completed";
  job.lastError = job.passwordAddResumesAuthorization
    ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  touch(job);
  await saveJobMetadata(job);
}

function restorePasswordAddFailure(job, message) {
  const resumeAuthorization = Boolean(job.passwordAddResumesAuthorization);
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = resumeAuthorization
    ? "本次添加密码未完成，原登录检查点仍可继续"
    : "原授权文件仍可使用，本次添加密码未完成";
  job.passwordAddError = message;
  job.lastError = resumeAuthorization ? "点击继续流程可恢复 Codex 授权" : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void removePrivateFile(job.passwordAddResultPath).catch(() => {});
  void saveJobMetadata(job).catch(() => {});
}

async function loadTotpSetupResult(job) {
  const data = JSON.parse(await fs.readFile(job.totpResultPath, "utf8"));
  if (data?.version !== 1) throw new Error("2FA 设置结果文件格式不正确");
  job.totpSetupReplaceExisting = data?.operation === "replace_totp";
  job.totpRotationRemoteDisabled = Boolean(data?.remote_disabled);
  job.totpRotationStage = typeof data?.stage === "string" ? data.stage : null;
  job.totpRotationIncomplete = data?.operation === "replace_totp" && data?.activation_succeeded !== true;
  if (data.already_enabled) {
    job.totpKnownEnabled = true;
    job.totpSetupSecret = null;
    job.totpSetupUri = null;
    return data;
  }
  const secret = normalizeTotpSecret(data.secret);
  const uri = String(data.otpauth_uri || "");
  if (!uri.startsWith("otpauth://totp/")) throw new Error("2FA 设置地址格式不正确");
  job.totpSetupSecret = secret;
  job.totpSetupUri = uri;
  if (data.activation_mode === "automatic") {
    if (job.status !== "totp_setup_otp") setStage(job, "working", "2FA 密钥已生成，正在自动激活");
  } else {
    setStage(job, "totp_setup_otp", "密钥已生成，请添加到验证器后输入当前 6 位验证码");
  }
  return data;
}

async function finishTotpSetup(job, code, signal) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  let result = null;
  try {
    result = await loadTotpSetupResult(job);
  } catch (error) {
    if (error?.code !== "ENOENT" && !job.totpSetupError) job.totpSetupError = error.message;
  }

  const activationSucceeded = result?.activation_succeeded === true;
  const replacingTotp = Boolean(job.totpSetupReplaceExisting || result?.operation === "replace_totp");
  let removeResult = false;
  if (code === 0 && result?.already_enabled) {
    job.totpKnownEnabled = true;
    job.prompt = "账号已经启用 2FA，但服务端不会返回原始密钥";
    job.totpSetupError = "如需自动登录，请重新导入这个账号原有的 2FA 密钥";
    removeResult = true;
  } else if ((code === 0 || activationSucceeded) && result?.secret) {
    const secret = normalizeTotpSecret(result.secret);
    job.totpSecret = secret;
    job.hasTotpCredential = true;
    job.totpKnownEnabled = true;
    job.totpRotationRemoteDisabled = false;
    job.totpRotationStage = result?.confirmation_succeeded === false ? "confirmation_failed" : "confirmed";
    job.totpRotationIncomplete = false;
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.prompt = activationSucceeded && code !== 0
      ? "2FA 已激活并保存，但最终状态确认未完成"
      : resumeAuthorization
        ? "2FA 已设置并安全保存，可以继续未完成的 Codex 授权"
        : "2FA 已设置并安全保存，可以继续下载或重新授权";
    job.totpSetupError = !persisted
      ? "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录"
      : activationSucceeded && code !== 0
      ? "激活接口已返回成功，但后续确认请求失败；密钥已保留"
      : null;
    appendJobLog(job, persisted
      ? (replacingTotp
        ? "[2fa] 2FA 更换成功，新密钥已写入系统凭据存储，未写入协议日志。\n"
        : "[2fa] 2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。\n")
      : (replacingTotp
        ? "[2fa] 2FA 更换成功，但当前系统不支持持久凭据存储；新密钥已保留在私有结果文件中。\n"
        : "[2fa] 2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。\n"));
    removeResult = persisted;
  } else {
    const remoteDisabled = Boolean(job.totpRotationRemoteDisabled || result?.remote_disabled);
    job.totpRotationRemoteDisabled = replacingTotp && remoteDisabled;
    job.totpRotationStage = result?.stage || (replacingTotp ? "failed" : null);
    job.totpRotationIncomplete = replacingTotp;
    job.totpKnownEnabled = replacingTotp ? !remoteDisabled : job.totpKnownEnabled;
    job.prompt = replacingTotp && remoteDisabled
      ? "原 2FA 状态可能已关闭，新 2FA 尚未激活；可以重试更换流程"
      : resumeAuthorization
        ? "本次 2FA 设置未完成，原登录检查点仍可继续"
        : "授权文件仍然可用，本次 2FA 设置未完成";
    job.totpSetupError ||= replacingTotp && remoteDisabled
      ? "远端 2FA 状态可能已关闭，结果文件已保留；请重试以完成新密钥激活"
      : signal
        ? `2FA 设置进程被 ${signal} 终止`
        : `2FA 设置进程退出，代码 ${code ?? "未知"}`;
  }

  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.lastError = resumeAuthorization
    ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupReplaceExisting = false;
  job.totpSetupResumesAuthorization = false;
  if (removeResult || (!replacingTotp && (!result?.secret || result?.activation_succeeded === false))) {
    await removePrivateFile(job.totpResultPath);
  }
  touch(job);
  await saveJobMetadata(job);
}

async function removePrivateFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreTotpSetupFailure(job, message) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  const replacingTotp = Boolean(job.totpSetupReplaceExisting);
  // Keep the remote-disabled flag conservative. The protocol persists the
  // disable state before enrollment, and re-checks mfa_info when a retry
  // resumes from the durable result file.
  if (replacingTotp) job.totpRotationIncomplete = true;
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = replacingTotp && job.totpRotationRemoteDisabled
    ? "原 2FA 已关闭，新 2FA 尚未激活；可以重试更换流程"
    : resumeAuthorization
    ? "本次 2FA 设置未完成，原登录检查点仍可继续"
    : "授权文件仍然可用，本次 2FA 设置未完成";
  job.totpSetupError = replacingTotp && job.totpRotationRemoteDisabled
    ? `${message}；远端 2FA 状态可能已关闭，结果文件已保留`
    : message;
  job.totpRotationStage = replacingTotp ? (job.totpRotationStage || "failed") : null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupReplaceExisting = false;
  job.totpSetupResumesAuthorization = false;
  job.lastError = resumeAuthorization ? "点击继续流程可恢复 Codex 授权" : null;
  job.runMode = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  if (!replacingTotp) void removePrivateFile(job.totpResultPath).catch(() => {});
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.status = "starting";
  job.prompt = "已有授权状态已过期，正在重新进行邮箱登录";
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  beginAuthorizationAutomationAttempt(job, "refresh_fallback");
  appendJobLog(job, "[refresh] 刷新令牌已失效，自动回退到邮箱验证码登录。\n");
  job.fallbackInProgress = false;
  if (job.status !== "canceled") {
    enqueueJob(job, "full", "刷新令牌已失效，正在重新登录并授权");
  }
  touch(job);
}

function consumeOutput(job, rawText) {
  const proxyAttemptScan = `${job.proxyAttemptParserTail || ""}${rawText}`;
  job.proxyAttemptParserTail = proxyAttemptScan.slice(-160);
  let proxyAttemptNotices = "";
  for (const match of proxyAttemptScan.matchAll(/\[proxy-session-attempt\]\s+([a-f0-9-]{36})/gi)) {
    const attemptId = match[1].toLowerCase();
    if (job.proxySessionAttemptIds.has(attemptId)) continue;
    job.proxySessionAttemptIds.add(attemptId);
    job.proxyRiskRetryCount = Math.min(MAX_PROXY_RISK_RETRIES, (job.proxyRiskRetryCount || 0) + 1);
    job.proxyConnectionFailureCount = 0;
    proxyAttemptNotices += `[proxy] 正在检测第 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个新代理会话。\n`;
    void saveJobMetadata(job).catch(() => {});
  }
  const text = `${proxyAttemptNotices}${sanitizeLog(rawText)}`
    .replace(/^\[proxy-session-attempt\][^\r\n]*(?:\r?\n)?/gim, "");
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  if (scan.includes("[3/5] Password login page reached.")) {
    markAuthorizationRequirement(job, "password");
    if (job.password) markAuthorizationAutomatic(job, "password");
  }
  if (scan.includes("[3/5] Email OTP page reached.")) {
    markAuthorizationRequirement(job, "emailOtp");
  }
  const mailRequestMarkers = [...scan.matchAll(/\[email-otp-requested-at\]\s+(\S+)/g)];
  const latestMailRequestAt = Date.parse(mailRequestMarkers.at(-1)?.[1] || "");
  if (Number.isFinite(latestMailRequestAt)) job.mailOtpRequestedAt = latestMailRequestAt;
  if (scan.includes("[checkpoint] Saved verified email login state.")
    || scan.includes("[checkpoint] Updated verified login state after adding the password.")
    || scan.includes("[checkpoint] Updated verified login state after setting 2FA.")) {
    job.loginCheckpointAvailable = true;
  }

  if (scan.includes("[proxy-risk-retry]")) {
    void restartAfterProxyRisk(job, {
      connectionFailure: scan.includes("PROXY_CONNECTION_RETRY"),
    }).catch((error) => {
      finishProxyRiskRetries(job, `自动更换代理会话失败：${error.message}`);
    });
    return;
  }

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-setup-ready]") && !job.totpResultLoading && !job.totpSetupSecret) {
    job.totpResultLoading = true;
    setStage(job, "working", "2FA 密钥已经生成，正在安全读取");
    void loadTotpSetupResult(job)
      .catch((error) => {
        job.totpSetupError = `无法读取 2FA 密钥：${error.message}`;
        job.child?.kill("SIGTERM");
        touch(job);
      })
      .finally(() => {
        job.totpResultLoading = false;
      });
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-already-enabled]")) {
    job.totpKnownEnabled = true;
    setStage(job, "working", "账号已经启用 2FA，正在收尾");
  }

  if (job.runMode === "totp_setup" && scan.includes("[ok] 2FA setup activated")) {
    setStage(job, "working", "2FA 已激活，正在安全保存密钥");
  }

  if (scan.includes("[security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "本次登录需要浏览器安全校验，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码需要浏览器安全校验，请稍后重试或更换代理 IP";
      touch(job);
      return;
    }
    requireBrowserSecurityCheck(job);
    return;
  }

  if (scan.includes("[profile-security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "账号资料校验未通过，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "账号资料校验未通过，密码尚未添加";
      touch(job);
      return;
    }
    requireProfileSecurityCheck(job);
    return;
  }

  if (scan.includes("ACCOUNT_PROFILE_REQUIRED")) {
    failAccountProfileRequired(job);
    return;
  }

  const sessionErrorLines = [...scan.matchAll(/^\[error\]\s*([^\r\n]+)/gim)];
  const latestSessionError = sessionErrorLines.at(-1)?.[1] || "";
  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["'](?:invalid_state|invalid_auth_step)["']|Invalid authorization step/i.test(latestSessionError)) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "设置 2FA 时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    setStage(job, "starting", "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码");
  }

  if (scan.includes("Email OTP (r=resend, q=quit):")) {
    markAuthorizationRequirement(job, "emailOtp");
    const rejected = scan.includes("[email-otp-rejected]");
    setStage(
      job,
      "email_otp",
      rejected
        ? "邮箱验证码错误，请重新输入或重新发送"
        : job.mailApiUrl
          ? "正在等待收码接口返回新验证码，也可以手动输入"
          : "请输入邮箱验证码",
    );
    if (job.mailApiUrl) void beginMailPolling(job);
  }
  if (scan.includes("Password (q=quit):")) {
    markAuthorizationRequirement(job, "password");
    stopMailPolling(job);
    setStage(job, "password", "请输入账号密码");
  }
  if (scan.includes("2FA setup OTP (6 digits, q=quit):")) {
    setStage(job, "totp_setup_otp", "请将密钥添加到验证器后输入当前 6 位验证码");
  }
  const mfaReachedIndex = scan.lastIndexOf("[mfa] TOTP 2FA challenge reached.");
  const mfaPromptIndex = scan.lastIndexOf("2FA OTP (6 digits, q=quit):");
  if (mfaReachedIndex > mfaPromptIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  } else if (mfaPromptIndex > mfaReachedIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  if (scan.includes("[mfa] Generated a 6-digit code from the configured 2FA key.")) {
    markAuthorizationAutomatic(job, "mfa");
  }
  const phoneNumberPromptIndex = scan.lastIndexOf("Phone number, E.164 format");
  const phoneOtpPromptIndex = scan.lastIndexOf("Phone OTP (r=resend, p=change phone, q=quit):");
  if (phoneNumberPromptIndex > phoneOtpPromptIndex) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  } else if (phoneOtpPromptIndex > phoneNumberPromptIndex) {
    if (job.smsStatus !== "error") job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.smsOrderId && job.smsNumber === job.currentPhone) void beginSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    if (job.smsOrderId && job.smsNumber === job.currentPhone) {
      releaseSmsNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    const validationMessage = validationFailures.at(-1)[1];
    job.phoneError = friendlyPhoneOtpError(validationMessage);
    stopSmsPolling(job);
    if (job.smsStatus === "submitted") {
      job.smsStatus = "error";
      job.smsError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
    if (shouldChangePhoneAfterOtpFailure(validationMessage)) {
      job.smsError = job.phoneError;
      appendJobLog(job, "[sms] 当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。\n");
      void submitJobInput(job, { action: "change_phone", value: "" }, {
        preservePhoneError: true,
      }).catch((error) => {
        failJob(job, `无法自动返回换号步骤：${error.message}`);
      });
      touch(job);
      return;
    }
  }
  if (scan.includes("[ok] Phone OTP validated")) {
    completeSmsNumber(job);
  }
  if (scan.includes("[5/5] Select workspace") || scan.includes("[6/6] Convert OAuth callback")) {
    setStage(job, "finalizing", "正在完成授权并生成文件");
  }
  if (scan.includes("[4/5] Existing workspace/session selected")) {
    setStage(job, "finalizing", "账号已绑定手机号，正在继续授权");
  }
  if (scan.includes("[ok] Saved sub2api import:")) {
    job.resultSaved = true;
    setStage(job, "finalizing", "导入文件已生成，正在收尾");
  }
  if (scan.includes("[ok] Account password added and saved securely")) {
    setStage(job, "finalizing", "密码已添加，正在安全保存新密码");
  }
  const errorMatches = [...scan.matchAll(/\[error\]\s*([^\r\n]+)/g)];
  if (errorMatches.length) {
    const errorMessage = extractResponseMessage(errorMatches.at(-1)[1]);
    if (job.runMode === "totp_setup") {
      job.totpSetupError = errorMessage;
    } else if (job.runMode === "password_add") {
      job.passwordAddError = errorMessage;
    } else {
      failJob(job, errorMessage);
    }
  }
  touch(job);
}

async function restartAfterProxyRisk(job, options = {}) {
  if (job.proxyRiskRestarting || isTerminalStatus(job.status)) return;
  job.proxyRiskRestarting = true;
  const mode = job.runMode || job.queuedMode || "full";
  try {
    if (!job.proxyUrl) {
      if (job.directTlsFallbackAttempted) {
        finishProxyRiskRetries(job, "Cloudflare 安全校验未能完成，直连 TLS 指纹筛选已经使用过，请稍后重试");
        return;
      }
      job.directTlsFallbackAttempted = true;
      const fallbackProfile = await directTlsProfileProbe.resolve();
      appendJobLog(job, `[tls] Cloudflare 求解未完成，正在启用直连 TLS 指纹筛选兜底（${fallbackProfile}）。\n`);
    } else if (!proxySupportsSessionRotation(job.proxyUrl)) {
      finishProxyRiskRetries(
        job,
        "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试",
      );
      return;
    }
    if ((job.proxyRiskRetryCount || 0) >= MAX_PROXY_RISK_RETRIES) {
      finishProxyRiskRetries(job, `代理会话已自动更换 ${MAX_PROXY_RISK_RETRIES} 次，仍然触发安全校验`);
      return;
    }
    if (options.connectionFailure) {
      job.proxyConnectionFailureCount = (job.proxyConnectionFailureCount || 0) + 1;
      if (job.proxyConnectionFailureCount >= MAX_PROXY_CONNECTION_FAILURES) {
        finishProxyRiskRetries(
          job,
          `代理连接连续失败 ${MAX_PROXY_CONNECTION_FAILURES} 次，已停止自动重试`,
        );
        return;
      }
    }

    stopMailPolling(job);
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.queueRunId = null;
    job.runId = crypto.randomUUID();
    const restartRunId = job.runId;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (mode === "full") await removePrivateFile(job.checkpointPath);
    job.parserTail = "";
    job.lastError = null;
    job.currentPhone = null;
    job.phoneError = null;
    job.securityCheckRequired = false;
    job.restartRequired = false;
    appendJobLog(
      job,
      options.connectionFailure
        ? `[proxy] 代理连接失败，HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}；连接失败 ${job.proxyConnectionFailureCount}/${MAX_PROXY_CONNECTION_FAILURES}。\n`
        : `[proxy] 登录阶段触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话，正在继续更换。\n`,
    );
    if (options.connectionFailure) {
      const retryDelay = Math.min(
        PROXY_CONNECTION_RETRY_MAX_MS,
        PROXY_CONNECTION_RETRY_BASE_MS * (2 ** Math.min(job.proxyConnectionFailureCount - 1, 4)),
      );
      job.status = "starting";
      job.prompt = `代理连接失败，${Math.ceil(retryDelay / 1_000)} 秒后更换会话`;
      touch(job);
      await saveJobMetadata(job);
      await delay(retryDelay);
      if (job.runId !== restartRunId || isTerminalStatus(job.status)) return;
    }
    job.proxyRiskRestarting = false;
    enqueueJob(
      job,
      mode,
      options.connectionFailure
        ? `代理连接失败，正在更换会话；HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}`
        : `代理触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话`,
    );
  } finally {
    job.proxyRiskRestarting = false;
  }
}

function finishProxyRiskRetries(job, message) {
  job.proxyRiskRestarting = false;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    restoreTotpSetupFailure(job, message);
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    restorePasswordAddFailure(job, message);
    scheduleQueuedJobs();
    return;
  }
  if (job.resultSaved) {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，自动更换代理未能完成本次操作";
    job.lastError = message;
    job.runMode = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    scheduleQueuedJobs();
    return;
  }
  failJob(job, message);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "reauth_required";
  job.prompt = "登录状态已失效，需要重新授权";
  job.lastError = message;
  job.phoneError = null;
  job.restartRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireBrowserSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireProfileSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号资料创建需要安全校验";
  job.lastError = "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function failAccountProfileRequired(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号注册资料未完成";
  job.lastError = "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。";
  job.phoneError = null;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopSmsPolling(job);
  job.status = "resume_available";
  job.prompt = "邮箱登录检查点仍然有效，可以继续手机号绑定";
  job.lastError = `${reason}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码`;
  job.child = null;
  job.currentPhone = null;
  job.loginCheckpointAvailable = true;
  touch(job);
}

function friendlyPhoneError(message) {
  const text = String(message || "");
  if (/suspicious behavior/i.test(text)) return "该手机号触发了风控，请更换手机号或稍后重试";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "短信发送过于频繁，请稍后重试或更换手机号";
  if (/already|used|unsupported|invalid phone/i.test(text)) return "该手机号不可用或已被使用，请更换手机号";
  return "短信验证码发送失败，请更换手机号后重试";
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function friendlyPhoneOtpError(message) {
  const text = String(message || "");
  if (/phone_recently_used|phone number was recently used/i.test(text)) {
    return "该手机号近期已被使用，已停止重复提交，请更换手机号";
  }
  if (/phone_number_in_use|phone number already in use/i.test(text)) {
    return "该手机号已绑定其他账号，请更换手机号";
  }
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) {
    return "验证次数过多，已停止自动提交，请稍后更换手机号";
  }
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

function shouldChangePhoneAfterOtpFailure(message) {
  return /phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|too many|rate.?limit|HTTP 429/i
    .test(String(message || ""));
}

function acquireCustomSmsEntry(entries) {
  const poolKey = crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("base64url");
  const nextIndex = customSmsPoolPositions.get(poolKey) || 0;
  if (nextIndex >= entries.length) return null;
  customSmsPoolPositions.set(poolKey, nextIndex + 1);
  return entries[nextIndex];
}

async function acquireSmsNumber(job, providerId, config) {
  requireStage(job, "phone");
  if (job.smsStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  let smsClient;
  try {
    smsClient = createSmsProvider(providerId, config, {
      lubanApiBase: process.env.LUBAN_SMS_API_BASE,
      smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      acquireCustomSmsEntry,
    });
  } catch (error) {
    throw httpError(400, safeSmsProviderError(error, config?.apiKey));
  }

  releaseSmsNumber(job, "idle");
  job.smsClient = smsClient;
  job.smsProviderId = smsClient.id;
  job.smsProviderName = smsClient.name;
  job.smsServiceLabel = smsClient.serviceLabel;
  job.smsStatus = "requesting";
  job.smsError = null;
  touch(job);

  let order;
  try {
    order = await smsClient.getNumber();
    if (job.status !== "phone" || !job.child) {
      void smsClient.release(order.requestId).catch(() => {});
      throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
    }
    job.smsOrderId = order.requestId;
    job.smsNumber = order.number;
    job.smsStatus = "number_acquired";
    job.smsError = null;
    await saveJobMetadata(job);
    appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取手机号并提交，等待短信发送结果。\n`);
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "sms-provider" });
  } catch (error) {
    if (order?.requestId && job.smsOrderId === order.requestId) releaseSmsNumber(job, "error");
    if (job.status === "phone") {
      job.smsStatus = "error";
      job.smsError = safeSmsProviderError(error, smsClient.apiKey);
      if (!order) job.smsClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeSmsProviderError(error, smsClient.apiKey));
  }
}

async function beginSmsPolling(job) {
  if (
    !job.smsClient
    || !job.smsOrderId
    || job.smsPollToken
    || job.status !== "phone_otp"
    || !["number_acquired", "waiting_sms"].includes(job.smsStatus)
  ) return;
  const pollToken = crypto.randomUUID();
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const startedAt = Date.now();
  job.smsPollToken = pollToken;
  job.smsStatus = "waiting_sms";
  job.smsError = null;
  touch(job);

  try {
    if (smsClient.markReady) {
      await smsClient.markReady(requestId).catch((error) => {
        appendJobLog(job, `[sms] ${smsClient.name} 更新号码就绪状态失败：${safeSmsProviderError(error)}\n`);
      });
    }
    while (
      job.smsPollToken === pollToken &&
      job.smsOrderId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await smsClient.getSms(requestId);
        if (job.smsPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          if (job.smsLastSubmittedCode === result.code) {
            job.smsStatus = "error";
            job.smsError = "接码平台仍返回已提交过的验证码，已停止重复提交";
            appendJobLog(job, `[sms] ${smsClient.name} 返回了已提交过的验证码，已停止本次自动轮询。\n`);
            touch(job);
            return;
          }
          job.smsLastSubmittedCode = result.code;
          job.smsStatus = "submitting";
          job.smsError = null;
          appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取短信验证码并自动提交。\n`);
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "sms-provider" });
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = null;
      } catch (error) {
        if (job.smsPollToken !== pollToken) return;
        if (error?.terminal) {
          job.smsStatus = "error";
          job.smsError = `${safeSmsProviderError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = `${safeSmsProviderError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(SMS_POLL_INTERVAL_MS);
    }

    if (job.smsPollToken === pollToken && job.status === "phone_otp") {
      job.smsStatus = "error";
      job.smsError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.smsPollToken === pollToken) {
      job.smsPollToken = null;
      touch(job);
    }
  }
}

function stopSmsPolling(job) {
  job.smsPollToken = null;
}

function releaseSmsNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const providerName = job.smsProviderName || smsClient?.name || "接码平台";
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsNumber = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = nextStatus;
  job.smsError = errorMessage;
  if (nextStatus === "idle") {
    job.smsProviderId = null;
    job.smsProviderName = null;
    job.smsServiceLabel = null;
  }
  if (requestId && smsClient) {
    void smsClient.release(requestId).catch(() => {
      appendJobLog(job, `[sms] ${providerName} 号码释放请求失败，请在平台控制台检查订单。\n`);
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function completeSmsNumber(job) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  if (!requestId || !smsClient) return;
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = "completed";
  job.smsError = null;
  appendJobLog(job, `[sms] 手机验证码已通过，正在完成 ${smsClient.name} 订单。\n`);
  if (smsClient.complete) {
    void smsClient.complete(requestId).catch((error) => {
      appendJobLog(job, `[sms] ${smsClient.name} 完成订单失败：${safeSmsProviderError(error)}\n`);
      touch(job);
    });
  }
  touch(job);
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newSmsState() {
  return {
    smsProviderId: null,
    smsProviderName: null,
    smsServiceLabel: null,
    smsOrderId: null,
    smsNumber: null,
    smsClient: null,
    smsStatus: "idle",
    smsError: null,
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function restoredSmsState(metadata = {}) {
  const orderId = metadata.sms_order_id || metadata.luban_request_id;
  const number = metadata.sms_number || metadata.luban_number;
  if (!orderId || !number) return newSmsState();
  return {
    smsProviderId: metadata.sms_provider_id || "luban",
    smsProviderName: metadata.sms_provider_name || (metadata.sms_provider_id === "smsbower" ? "SMSBower" : "LubanSMS"),
    smsServiceLabel: metadata.sms_service_label || metadata.luban_service_id || null,
    smsOrderId: String(orderId),
    smsNumber: String(number),
    smsClient: null,
    smsStatus: "error",
    smsError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function safeSmsProviderError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<已隐藏>")
    .replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

async function submitJobInput(job, body, options = {}) {
  if (!job.child || !isActive(job.status)) {
    throw httpError(409, "This login flow is not waiting for input");
  }
  const action = String(body.action || "");
  const rawValue = String(body.value || "");
  const value = rawValue.trim();
  let inputValue = "";

  if (action === "password") {
    requireStage(job, "password");
    if (!rawValue) throw httpError(400, "密码不能为空");
    await saveStoredLoginCredentials(job.email, {
      password: rawValue,
      totpSecret: job.totpSecret,
      proxyUrl: job.proxyUrl,
    });
    job.loginMode = "password";
    job.password = rawValue;
    job.hasPasswordCredential = true;
    markAuthorizationManual(job, "password");
    await saveJobMetadata(job);
    inputValue = rawValue;
    setStage(job, "working", "正在验证账号密码");
  } else if (action === "mfa_otp") {
    requireStage(job, "mfa_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "2FA 验证码必须是 6 位数字");
    inputValue = value;
    markAuthorizationManual(job, "mfa");
    setStage(job, "working", "正在验证 2FA 验证码");
  } else if (action === "totp_setup_otp") {
    requireStage(job, "totp_setup_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "设置 2FA 的验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在激活新的 2FA");
  } else if (action === "email_otp") {
    requireStage(job, "email_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "Email code must be 6 digits");
    stopMailPolling(job);
    job.parserTail = "";
    markAuthorizationManual(job, "emailOtp");
    inputValue = value;
    setStage(job, "working", "正在验证邮箱验证码");
  } else if (action === "resend_email") {
    requireStage(job, "email_otp");
    stopMailPolling(job);
    job.parserTail = "";
    inputValue = "r";
    setStage(job, "working", "正在重新发送邮箱验证码");
  } else if (action === "phone") {
    requireStage(job, "phone");
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw httpError(400, "Phone number must use E.164 format, for example +60123456789");
    if (options.source !== "sms-provider") releaseSmsNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = options.source === "sms-provider" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    const preservedPhoneError = options.preservePhoneError ? job.phoneError : null;
    releaseSmsNumber(
      job,
      options.preservePhoneError ? "error" : "idle",
      options.preservePhoneError ? preservedPhoneError : null,
    );
    job.currentPhone = null;
    job.phoneError = preservedPhoneError;
    inputValue = "p";
    setStage(
      job,
      "working",
      options.preservePhoneError ? "当前手机号不可用，正在返回换号步骤" : "正在返回手机号输入",
    );
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

async function cancelJob(job) {
  if (!isActive(job.status)) return;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishTotpSetup(job, 1, "SIGTERM");
    if (!job.totpKnownEnabled && !job.totpRotationRemoteDisabled) {
      job.prompt = job.resultSaved
        ? "授权文件仍然可用，2FA 设置已取消"
        : "2FA 设置已取消，原登录检查点仍可继续";
      job.totpSetupError = "用户取消了本次 2FA 设置";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishPasswordAdd(job, 1, "SIGTERM");
    if (job.passwordAddError) {
      job.prompt = "原授权文件仍可使用，添加密码已取消";
      job.passwordAddError = "用户取消了本次添加密码";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "canceled";
  job.prompt = "流程已取消";
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function cancelAllJobs() {
  const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
  if (!activeJobs.length) return 0;
  queueSchedulingPaused = true;
  try {
    await Promise.all(activeJobs.map((job) => withEmailJobLock(job.email, () => cancelJob(job))));
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) {
    sendJson(res, 409, { error: "The sub2api import file is not ready" });
    return;
  }
  const safeEmail = job.email.replace(/[^a-zA-Z0-9@._+-]/g, "_");
  const data = await fs.readFile(job.outputPath);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeEmail}-sub2api-import-oauth-${downloadTimestamp()}.json"`,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function downloadBatchResult(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError(400, "请至少选择一个已完成任务");
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多下载 ${MAX_BATCH_JOBS} 个账号`);

  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  const downloadable = selected.filter((job) => job.resultSaved);
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");

  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }

  const payload = Buffer.from(`${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  }, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="sub2api-import-oauth-${accounts.length}-accounts-${downloadTimestamp()}.json"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function buildSub2ApiUploadPayload(downloadable) {
  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  };
}

function normalizeSub2ApiConfig(value, options = {}) {
  const config = value && typeof value === "object" ? value : {};
  const fallback = sub2ApiSettingsConfig || sub2ApiMonitorConfig || {};
  const stored = options.inheritStoredFields ? fallback : {};
  const baseUrl = String(config.baseUrl || fallback.baseUrl || "").trim().replace(/\/+$/, "");
  const adminApiKey = String(config.adminApiKey || fallback.adminApiKey || "").trim();
  if (!baseUrl) throw httpError(400, "请填写 Sub2API 后端地址");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError(400, "Sub2API 后端地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Sub2API 后端地址必须使用 HTTP 或 HTTPS");
  }
  if (!adminApiKey || adminApiKey.length > 512 || /[\r\n]/.test(adminApiKey)) {
    throw httpError(400, "请填写有效的 Sub2API 管理员 API Key");
  }
  const rawGroupIds = Array.isArray(config.groupIds)
    ? config.groupIds
    : Object.hasOwn(config, "groupId")
      ? (String(config.groupId || "").trim() ? [config.groupId] : [])
      : Array.isArray(stored.groupIds) ? stored.groupIds : [];
  const groupIds = [...new Set(rawGroupIds.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw httpError(400, "目标号池 ID 无效");
    }
    return Number(value);
  });
  const rawProxyId = Object.hasOwn(config, "proxyId") ? config.proxyId : stored.proxyId;
  // Serialized legacy settings use 0 for "no proxy"; treat it as empty rather than
  // rejecting a configuration during the next process start.
  const proxyText = rawProxyId === 0 || String(rawProxyId ?? "").trim() === "0"
    ? ""
    : String(rawProxyId ?? "").trim().toLowerCase();
  if (proxyText && proxyText !== SUB2API_PROXY_DIRECT
    && (!/^\d+$/.test(proxyText) || Number(proxyText) <= 0 || Number(proxyText) > Number.MAX_SAFE_INTEGER)) {
    throw httpError(400, "代理 ID 无效");
  }
  // 0 keeps the account's existing proxy, "direct" clears it, a number pins it.
  const proxyId = proxyText === SUB2API_PROXY_DIRECT ? SUB2API_PROXY_DIRECT : proxyText ? Number(proxyText) : 0;
  const concurrency = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "concurrency") ? config.concurrency : stored.concurrency,
    "并发数",
    0,
    10000,
  );
  const loadFactor = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "loadFactor") ? config.loadFactor : stored.loadFactor,
    "负载因子",
    0,
    10000,
  );
  const priority = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "priority") ? config.priority : stored.priority,
    "优先级",
    0,
    10000,
  );
  const accountNameTemplate = normalizeSub2ApiAccountNameTemplate(
    Object.hasOwn(config, "accountNameTemplate") ? config.accountNameTemplate : stored.accountNameTemplate,
  );
  const modelWhitelist = parseSub2ApiModelWhitelist(
    Object.hasOwn(config, "modelWhitelist") ? config.modelWhitelist : stored.modelWhitelist,
  );
  const codexFingerprintMode = String(
    Object.hasOwn(config, "codexFingerprintMode") ? config.codexFingerprintMode : (stored.codexFingerprintMode || "session"),
  ).trim().toLowerCase() || "session";
  if (!["off", "device", "session", "full"].includes(codexFingerprintMode)) {
    throw httpError(400, "Codex 指纹收敛模式无效");
  }
  const wsMode = normalizeSub2ApiWsMode(
    config.wsMode
      ?? config.openaiWsMode
      ?? config.openaiOAuthResponsesWebsocketsV2Mode
      ?? stored.wsMode
      ?? "off",
  );
  return { baseUrl, adminApiKey, groupIds, proxyId, concurrency, loadFactor, priority, accountNameTemplate, modelWhitelist, codexFingerprintMode, wsMode, profileId: String(config.profileId || stored.profileId || "default") };
}

function normalizeSub2ApiProxyId(stored = {}) {
  const raw = stored.proxyId ?? "";
  if (raw === 0 || String(raw).trim() === "0") return "";
  const text = String(raw).trim().toLowerCase();
  return text === SUB2API_PROXY_DIRECT ? SUB2API_PROXY_DIRECT : text;
}

function normalizeSub2ApiProfile(value, fallback = {}, id = "default") {
  const source = value && typeof value === "object" ? value : {};
  const merged = { ...fallback, ...source };
  merged.proxyId = normalizeSub2ApiProxyId(merged);
  const normalized = normalizeSub2ApiConfig({
    baseUrl: "http://127.0.0.1",
    adminApiKey: "profile-placeholder-key",
    ...merged,
  });
  const profileId = String(source.id ?? id).trim().slice(0, 128) || id;
  const name = String(source.name ?? profileId).trim().slice(0, 128) || profileId;
  return {
    id: profileId,
    name,
    ...Object.fromEntries(SUB2API_PROFILE_FIELDS.map((field) => [field, normalized[field]])),
  };
}

function profileConfig(profile, globalConfig) {
  if (!profile) return { ...globalConfig, profileId: globalConfig?.profileId || "default" };
  return {
    ...globalConfig,
    ...profile,
    profileId: profile.id,
    baseUrl: globalConfig.baseUrl,
    adminApiKey: globalConfig.adminApiKey,
  };
}

function normalizeSub2ApiPlanTypeBindings(value, profiles = sub2ApiProfiles) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profileMap = profiles instanceof Map ? profiles : new Map();
  const bindings = {};
  for (const [rawPlanType, rawProfileId] of Object.entries(value)) {
    const planType = normalizePlanType(rawPlanType);
    const profileId = String(rawProfileId ?? "").trim();
    if (!planType || !profileId || !profileMap.has(profileId)) continue;
    const canonicalPlanType = planType.toLowerCase();
    if (["__proto__", "constructor", "prototype"].includes(canonicalPlanType)) continue;
    bindings[canonicalPlanType] = profileId;
  }
  return bindings;
}

function resolveSub2ApiProfileBinding(planType, bindings = sub2ApiPlanTypeBindings) {
  const normalized = normalizePlanType(planType);
  if (!normalized || !bindings || typeof bindings !== "object") return "";
  if (Object.hasOwn(bindings, normalized) && bindings[normalized]) return String(bindings[normalized]);
  const lower = normalized.toLowerCase();
  const match = Object.entries(bindings).find(([key]) => String(key).toLowerCase() === lower);
  return match ? String(match[1] || "") : "";
}

function normalizeSub2ApiProfileState(value, baseConfig) {
  const source = value && typeof value === "object" ? value : {};
  if (!Array.isArray(source.profiles)) return null;
  const profiles = new Map();
  for (const item of source.profiles) {
    const id = String(item?.id || "").trim();
    if (id) {
      const normalized = normalizeSub2ApiProfile(item, {}, id);
      profiles.set(normalized.id, normalized);
    }
  }
  if (!profiles.size) return null;
  if (!profiles.has("default")) {
    profiles.set("default", normalizeSub2ApiProfile({ ...baseConfig, id: "default" }, {}, "default"));
  }
  const bindings = normalizeSub2ApiPlanTypeBindings(source.planTypeBindings, profiles);
  return { profiles, bindings };
}

function resolveSub2ApiConfigForAccount(baseConfig, account, requestProfileState = null) {
  const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
  const profileState = requestProfileState || { profiles: sub2ApiProfiles, bindings: sub2ApiPlanTypeBindings };
  const binding = resolveSub2ApiProfileBinding(planType, profileState.bindings);
  // Explicit upload config remains authoritative for legacy callers. A bound
  // plan type is the only case where the persisted profile overrides it.
  if (!binding) return { ...baseConfig, profileId: baseConfig?.profileId || "default" };
  const profileId = String(binding);
  const profile = profileState.profiles.get(profileId) || profileState.profiles.get("default");
  return profile ? profileConfig(profile, baseConfig) : { ...baseConfig, profileId };
}

function applySub2ApiSettingsBody(body = {}) {
  const rawConfig = body.config && typeof body.config === "object" ? body.config : body;
  const config = normalizeSub2ApiConfig(rawConfig, { inheritStoredFields: true });
  const rawProfiles = Array.isArray(body.profiles)
    ? body.profiles
    : Array.isArray(rawConfig.profiles) ? rawConfig.profiles : null;
  const nextProfiles = new Map();
  if (rawProfiles) {
    for (const item of rawProfiles) {
      const id = String(item?.id || "").trim();
      if (!id || id.length > 128) throw httpError(400, "配置方案 ID 无效");
      const previous = sub2ApiProfiles.get(id) || {};
      const normalized = normalizeSub2ApiProfile(item, previous, id);
      nextProfiles.set(normalized.id, normalized);
    }
  } else {
    // Older clients only send the legacy top-level profile fields. Preserve
    // every stored profile in that case and update only the active one.
    for (const [id, profile] of sub2ApiProfiles.entries()) {
      nextProfiles.set(profile.id || id, { ...profile });
    }
    const profileId = String(rawConfig.profileId || sub2ApiActiveProfileId || "default").trim() || "default";
    const previous = nextProfiles.get(profileId) || {};
    nextProfiles.set(profileId, normalizeSub2ApiProfile(rawConfig, previous, profileId));
  }
  if (!nextProfiles.size) {
    const profileId = String(rawConfig.profileId || sub2ApiActiveProfileId || "default");
    const normalized = normalizeSub2ApiProfile(rawConfig, sub2ApiProfiles.get(profileId) || {}, profileId);
    nextProfiles.set(normalized.id, normalized);
  }
  if (!nextProfiles.has("default")) {
    nextProfiles.set("default", normalizeSub2ApiProfile({ ...config, id: "default" }, {}, "default"));
  }
  sub2ApiProfiles = nextProfiles;
  const bindings = body.planTypeBindings ?? rawConfig.planTypeBindings ?? sub2ApiPlanTypeBindings;
  sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(bindings, sub2ApiProfiles);
  sub2ApiActiveProfileId = String(
    body.activeProfileId
      || rawConfig.activeProfileId
      || rawConfig.profileId
      || sub2ApiActiveProfileId
      || "default",
  );
  if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) sub2ApiActiveProfileId = "default";
  sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), config);
  return sub2ApiSettingsConfig;
}

function normalizeSub2ApiAccountNameTemplate(value) {
  const text = String(value ?? "").trim();
  if (text.length > 256) throw httpError(400, "账号命名模板最多 256 个字符");
  if (/[\r\n]/.test(text)) throw httpError(400, "账号命名模板不能包含换行");
  const unsupported = [...text.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1])
    .filter((key) => !SUB2API_ACCOUNT_NAME_TEMPLATE_KEYS.has(key));
  if (unsupported.length) {
    throw httpError(400, `账号命名模板包含不支持的占位符：${unsupported[0]}`);
  }
  return text;
}

function renderSub2ApiAccountName(template, account) {
  if (!template) return String(account?.name || "").trim().slice(0, 256);
  const email = sub2ApiAccountEmail(account) || "";
  const planType = extractPlanTypeFromAccount(account, { preferJwt: false }) || "";
  const accountId = String(
    account?.id
      ?? account?.account_id
      ?? account?.credentials?.chatgpt_account_id
      ?? account?.credentials?.account_id
      ?? account?.credentials?.accountId
      ?? "",
  ).trim();
  const values = {
    email,
    planType,
    plan_type: planType,
    accountId,
    account_id: accountId,
    id: accountId,
    name: String(account?.name || "").trim(),
  };
  const rendered = template.replace(/\{(email|planType|plan_type|accountId|account_id|id|name)\}/g, (_match, key) => values[key] || "").trim();
  return (rendered || values.name || email).slice(0, 256);
}

function normalizeSub2ApiWsMode(value) {
  const mode = String(value ?? "").trim().toLowerCase() || "off";
  if (!SUB2API_WS_MODES.has(mode)) throw httpError(400, "Sub2API WS mode 无效");
  return mode;
}

function buildSub2ApiAccountExtra(value, config) {
  const extra = value && typeof value === "object" ? { ...value } : {};
  // OpenAI OAuth accounts imported by toSub2 are always opted out of model
  // training. Keep this in the shared payload builder so new uploads,
  // workspace switches, and credential repairs use the same privacy state.
  extra.privacy_mode = "training_off";
  extra.codex_fingerprint_mode = config.codexFingerprintMode;
  extra.openai_oauth_responses_websockets_v2_mode = config.wsMode;
  extra.openai_oauth_responses_websockets_v2_enabled = config.wsMode !== "off";
  delete extra.responses_websockets_v2_enabled;
  delete extra.openai_ws_enabled;
  return extra;
}

function readDurationEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function initialMaxActiveJobs() {
  const value = Number(process.env.TOSUB2_MAX_ACTIVE_JOBS);
  return Number.isInteger(value) && value >= 1 && value <= MAX_ACTIVE_JOBS_LIMIT
    ? value : DEFAULT_MAX_ACTIVE_JOBS;
}

function validateMaxActiveJobs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_JOBS_LIMIT) {
    throw httpError(400, `同时运行任务数必须是 1 到 ${MAX_ACTIVE_JOBS_LIMIT} 的整数`);
  }
  return value;
}

function publicTaskSettings() {
  return { maxActiveJobs, min: 1, max: MAX_ACTIVE_JOBS_LIMIT, default: DEFAULT_MAX_ACTIVE_JOBS };
}

async function loadTaskSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(TASK_SETTINGS_PATH, "utf8"));
    maxActiveJobs = validateMaxActiveJobs(saved.maxActiveJobs);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`任务设置读取失败：${error.message}`);
    }
  }
}

async function saveTaskSettings(value) {
  const nextLimit = validateMaxActiveJobs(value);
  // Serialize writes so memory and the last persisted setting always agree.
  const operation = taskSettingsWritePromise.catch(() => {}).then(async () => {
    const tempPath = `${TASK_SETTINGS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, maxActiveJobs: nextLimit }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, TASK_SETTINGS_PATH);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    maxActiveJobs = nextLimit;
    // Reducing the limit leaves running jobs alone; they drain before new work
    // starts. Increasing it immediately makes extra slots available.
    scheduleQueuedJobs();
    return publicTaskSettings();
  });
  taskSettingsWritePromise = operation;
  return operation;
}

function parseOptionalSub2ApiInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw httpError(400, `${label}必须是数字`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpError(400, `${label}范围必须是 ${min} 到 ${max}`);
  return parsed;
}

function parseSub2ApiModelWhitelist(value) {
  const models = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length > 200) throw httpError(400, "支持模型最多填写 200 个");
  if (models.some((model) => model.length > 200 || /[\r\n]/.test(model))) throw httpError(400, "支持模型名称格式不正确");
  return [...new Set(models)];
}

function requestSub2Api(config, endpoint, options = {}) {
  const requestPromise = performSub2ApiRequest(config, endpoint, options);
  sub2ApiRequestPromises.add(requestPromise);
  void requestPromise.then(
    () => sub2ApiRequestPromises.delete(requestPromise),
    () => sub2ApiRequestPromises.delete(requestPromise),
  );
  return requestPromise;
}

async function performSub2ApiRequest(config, endpoint, options = {}) {
  const controller = new AbortController();
  sub2ApiRequestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.adminApiKey,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = sub2ApiResponseMessage(payload, text).slice(0, 500);
      const error = httpError(502, `Sub2API 返回 HTTP ${response.status}${message ? `：${message}` : ""}`);
      error.remoteStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") {
      throw httpError(shuttingDown ? 503 : 504, shuttingDown ? "Sub2API 请求已因服务关闭而取消" : "Sub2API 请求超时");
    }
    throw httpError(502, `无法连接 Sub2API 后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
    sub2ApiRequestControllers.delete(controller);
  }
}

function sub2ApiResponseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || "";
  return typeof message === "string" && message.trim()
    ? message.trim()
    : extractResponseMessage(text);
}

function serializeSub2ApiConfig(config) {
  return {
    baseUrl: config.baseUrl,
    adminApiKey: config.adminApiKey,
    groupIds: config.groupIds,
    proxyId: config.proxyId,
    concurrency: config.concurrency,
    loadFactor: config.loadFactor,
    priority: config.priority,
    accountNameTemplate: config.accountNameTemplate,
    modelWhitelist: config.modelWhitelist,
    codexFingerprintMode: config.codexFingerprintMode,
    wsMode: config.wsMode,
    profileId: config.profileId || "default",
  };
}

function publicSub2ApiConfig(config) {
  if (!config) return null;
  const { adminApiKey: _adminApiKey, ...publicConfig } = serializeSub2ApiConfig(config);
  return publicConfig;
}

function publicSub2ApiSettingsState() {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const publicProfiles = [...sub2ApiProfiles.values()].map((profile) => ({ ...profile }));
  return {
    configured: Boolean(config?.baseUrl && config?.adminApiKey),
    hasAdminApiKey: Boolean(config?.adminApiKey),
    monitorEnabled: Boolean(sub2ApiMonitorConfig?.enabled),
    config: publicSub2ApiConfig(config),
    baseUrl: config?.baseUrl || null,
    profiles: publicProfiles,
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
  };
}

async function loadSub2ApiSettingsConfiguration() {
  try {
    const saved = JSON.parse(await fs.readFile(SUB2API_SETTINGS_PATH, "utf8"));
    let needsMigration = saved.version !== 2 || !Array.isArray(saved.profiles);
    sub2ApiSettingsConfig = normalizeSub2ApiConfig(saved.config || saved);
    sub2ApiProfiles = new Map();
    const profiles = Array.isArray(saved.profiles) ? saved.profiles : [];
    for (const item of profiles) {
      const id = String(item?.id || "").trim();
      if (id) {
        const normalized = normalizeSub2ApiProfile(item, {}, id);
        sub2ApiProfiles.set(normalized.id, normalized);
      }
    }
    if (!sub2ApiProfiles.size) {
      sub2ApiProfiles.set("default", normalizeSub2ApiProfile(saved.config || {}, {}, "default"));
    } else if (!sub2ApiProfiles.has("default")) {
      // Keep the settings invariant even for hand-edited or partially written
      // v2 files. The first profile remains available under its original ID.
      const firstProfile = sub2ApiProfiles.values().next().value;
      sub2ApiProfiles.set("default", normalizeSub2ApiProfile({ ...firstProfile, id: "default" }, {}, "default"));
      needsMigration = true;
    }
    sub2ApiActiveProfileId = String(saved.activeProfileId || sub2ApiSettingsConfig.profileId || "default");
    if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) {
      sub2ApiActiveProfileId = sub2ApiProfiles.has("default")
        ? "default"
        : sub2ApiProfiles.keys().next().value;
      needsMigration = true;
    }
    sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(saved.planTypeBindings, sub2ApiProfiles);
    sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), sub2ApiSettingsConfig);
    if (needsMigration) await persistSub2ApiSettingsConfiguration();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] Sub2API 设置配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    sub2ApiSettingsConfig = null;
  }
}

async function persistSub2ApiSettingsConfiguration() {
  if (!sub2ApiSettingsConfig) return;
  const payload = {
    version: 2,
    config: serializeSub2ApiConfig(sub2ApiSettingsConfig),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${SUB2API_SETTINGS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, SUB2API_SETTINGS_PATH);
}

async function loadSub2ApiMonitorConfiguration() {
  try {
    const saved = JSON.parse(await fs.readFile(SUB2API_MONITOR_PATH, "utf8"));
    if (!sub2ApiSettingsConfig) {
      // Older deployments only persisted the monitor file. Migrate its
      // connection/profile fields once, then use the canonical settings state.
      const legacyConfig = normalizeSub2ApiConfig(saved.config || saved);
      sub2ApiSettingsConfig = legacyConfig;
      if (!sub2ApiProfiles.size) {
        const savedProfiles = Array.isArray(saved.profiles) ? saved.profiles : [];
        for (const item of savedProfiles) {
          const id = String(item?.id || "").trim();
          if (!id) continue;
          const normalized = normalizeSub2ApiProfile(item, {}, id);
          sub2ApiProfiles.set(normalized.id, normalized);
        }
      }
      if (!sub2ApiProfiles.size) sub2ApiProfiles.set("default", normalizeSub2ApiProfile(legacyConfig, {}, "default"));
      if (!sub2ApiProfiles.has("default")) {
        const firstProfile = sub2ApiProfiles.values().next().value;
        sub2ApiProfiles.set("default", normalizeSub2ApiProfile({ ...firstProfile, id: "default" }, {}, "default"));
      }
      sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(saved.planTypeBindings, sub2ApiProfiles);
      sub2ApiActiveProfileId = String(saved.activeProfileId || "default");
      if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) sub2ApiActiveProfileId = "default";
      sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), legacyConfig);
      await persistSub2ApiSettingsConfiguration();
    }
    sub2ApiMonitorConfig = { ...sub2ApiSettingsConfig, enabled: saved.enabled === true };
    sub2ApiMonitorState.lastCheckAt = saved.state?.lastCheckAt || null;
    sub2ApiMonitorState.lastError = saved.state?.lastError || null;
    sub2ApiMonitorState.lastResult = saved.state?.lastResult && typeof saved.state.lastResult === "object"
      ? saved.state.lastResult
      : null;
    sub2ApiMonitorState.planTypes = normalizeSub2ApiPlanTypeState(saved.state?.planTypes);
    sub2ApiMonitorState.planTypesBackend = typeof saved.state?.planTypesBackend === "string"
      ? saved.state.planTypesBackend
      : null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] Sub2API 号池监控配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    sub2ApiMonitorConfig = sub2ApiSettingsConfig
      ? { ...sub2ApiSettingsConfig, enabled: false }
      : null;
  }
}

async function persistSub2ApiMonitorConfiguration() {
  if (!sub2ApiMonitorConfig) return;
  const payload = {
    version: 1,
    enabled: Boolean(sub2ApiMonitorConfig.enabled),
    config: serializeSub2ApiConfig(sub2ApiMonitorConfig),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    state: {
      lastCheckAt: sub2ApiMonitorState.lastCheckAt,
      lastError: sub2ApiMonitorState.lastError,
      lastResult: sub2ApiMonitorState.lastResult,
      planTypes: sub2ApiMonitorState.planTypes,
      planTypesBackend: sub2ApiMonitorState.planTypesBackend,
    },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${SUB2API_MONITOR_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, SUB2API_MONITOR_PATH);
}

function publicSub2ApiMonitorState() {
  const config = sub2ApiMonitorConfig || sub2ApiSettingsConfig;
  return {
    configured: Boolean(config?.baseUrl && config?.adminApiKey),
    hasAdminApiKey: Boolean(config?.adminApiKey),
    enabled: Boolean(sub2ApiMonitorConfig?.enabled),
    baseUrl: config?.baseUrl || null,
    groupIds: config?.groupIds || [],
    config: publicSub2ApiConfig(config),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    intervalMinutes: Math.max(1, Math.round(SUB2API_MONITOR_INTERVAL_MS / 60_000)),
    cooldownMinutes: Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000)),
    running: sub2ApiMonitorState.running,
    lastCheckAt: sub2ApiMonitorState.lastCheckAt,
    nextCheckAt: sub2ApiMonitorState.nextCheckAt,
    lastError: sub2ApiMonitorState.lastError,
    lastResult: sub2ApiMonitorState.lastResult,
  };
}

function normalizePlanTypeLabelMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "PlanType 映射必须是对象");
  }
  const mapping = {};
  for (const [rawKey, rawLabel] of Object.entries(value).slice(0, 100)) {
    const key = String(rawKey || "").trim();
    const label = String(rawLabel || "").trim();
    if (!key && !label) continue;
    if (!key || !label || key.length > 128 || label.length > 128 || /[\r\n]/.test(key) || /[\r\n]/.test(label)) {
      throw httpError(400, "PlanType 映射项格式不正确");
    }
    if (["__proto__", "constructor", "prototype"].includes(key.toLowerCase())) continue;
    mapping[key] = label;
  }
  return mapping;
}

async function loadPlanTypeLabelMapping() {
  try {
    const saved = JSON.parse(await fs.readFile(PLAN_TYPE_MAPPING_PATH, "utf8"));
    planTypeLabelMapping = normalizePlanTypeLabelMapping(saved.mapping ?? saved);
    planTypeLabelMappingConfigured = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] PlanType 映射无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    planTypeLabelMapping = {};
    planTypeLabelMappingConfigured = false;
  }
}

async function persistPlanTypeLabelMapping(mapping) {
  const payload = {
    version: 1,
    mapping: { ...mapping },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${PLAN_TYPE_MAPPING_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, PLAN_TYPE_MAPPING_PATH);
}

function scheduleSub2ApiMonitor() {
  if (sub2ApiMonitorTimer) {
    clearInterval(sub2ApiMonitorTimer);
    sub2ApiMonitorTimer = null;
  }
  sub2ApiMonitorState.nextCheckAt = null;
  if (!sub2ApiMonitorConfig?.enabled || shuttingDown) return;
  const interval = Number.isFinite(SUB2API_MONITOR_INTERVAL_MS) && SUB2API_MONITOR_INTERVAL_MS >= 1_000
    ? SUB2API_MONITOR_INTERVAL_MS
    : 5 * 60_000;
  sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
  sub2ApiMonitorTimer = setInterval(() => {
    sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
    void runSub2ApiMonitor("scheduled").catch((error) => {
      console.warn(`[warn] Sub2API 号池巡检失败：${String(error?.message || error).slice(0, 180)}`);
    });
  }, interval);
  sub2ApiMonitorTimer.unref?.();
}

async function runSub2ApiMonitor(trigger = "scheduled") {
  if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "Sub2API 号池监控未启用");
  if (sub2ApiMonitorPromise) return sub2ApiMonitorPromise;
  const config = { ...sub2ApiMonitorConfig, groupIds: [...sub2ApiMonitorConfig.groupIds] };
  const profileState = snapshotSub2ApiProfileState();
  const monitorGroupIds = sub2ApiMonitorGroupIds(config, profileState);
  const backend = monitorBackendIdentity(config);
  sub2ApiMonitorPromise = (async () => {
    sub2ApiMonitorState.running = true;
    sub2ApiMonitorState.lastError = null;
    const summary = {
      trigger,
      checked: 0,
      matched: 0,
      started: 0,
      updated: 0,
      missingTask: 0,
      ineligible: 0,
      blocked: 0,
      busy: 0,
      cooldown: 0,
      outsideGroups: 0,
      missingEmail: 0,
      planTypeChecked: 0,
      planTypeChanged: 0,
      planTypeChanges: 0,
      planTypeUpdated: 0,
      planTypeSkipped: 0,
      planTypeUpdateFailed: 0,
      planTypeScanIncomplete: false,
      proxyFallbackUpdated: 0,
      proxyFallbackFailed: 0,
    };
    try {
      await syncCompletedOutputs(true);
      await retryPendingSub2ApiUploads(config, summary, profileState);
      if (shuttingDown) throw httpError(503, "服务正在关闭，已停止号池巡检");
      const accountListing = await listSub2ApiAccounts(config, { withMeta: true });
      const allRemoteAccounts = accountListing.accounts;
      if (accountListing.complete) {
        await fallBackExpiredSub2ApiProxies(config, profileState, allRemoteAccounts, summary);
        const previousPlanTypes = sub2ApiMonitorState.planTypesBackend === backend
          ? normalizeSub2ApiPlanTypeState(sub2ApiMonitorState.planTypes)
          : Object.create(null);
        const nextPlanTypes = Object.create(null);
        for (const account of allRemoteAccounts) {
          const accountId = normalizeSub2ApiAccountId(account?.id);
          if (!accountId) continue;
          summary.planTypeChecked += 1;
          const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
          const previous = Object.hasOwn(previousPlanTypes, accountId)
            ? normalizePlanType(previousPlanTypes[accountId] || "")
            : "";
          // A transiently missing PlanType must not erase a known baseline;
          // otherwise the next restored value would look like a first sighting.
          if (!planType && previous) {
            nextPlanTypes[accountId] = previous;
            continue;
          }
          nextPlanTypes[accountId] = planType || null;
          if (!previous || !planType || previous === planType) continue;
          const profileId = resolveSub2ApiProfileBinding(planType, profileState.bindings);
          const profile = profileId ? profileState.profiles.get(profileId) : null;
          if (!profile) {
            summary.planTypeSkipped += 1;
            continue;
          }
          summary.planTypeChanged += 1;
          summary.planTypeChanges += 1;
          try {
            if (await updateSub2ApiAccountFromProfile(config, account, profile)) summary.planTypeUpdated += 1;
          } catch (error) {
            summary.planTypeUpdateFailed += 1;
            // Keep the previous value so the next scheduled check retries the PUT.
            nextPlanTypes[accountId] = previous || null;
            console.warn(`[warn] Sub2API 账号 ${accountId} 配置方案更新失败：${String(error?.message || error).slice(0, 180)}`);
          }
        }
        sub2ApiMonitorState.planTypes = nextPlanTypes;
        sub2ApiMonitorState.planTypesBackend = backend;
        if (summary.planTypeUpdated) invalidateSub2ApiAccountStatusCache();
      } else {
        summary.planTypeScanIncomplete = true;
        // Keep the last complete baseline. Applying changes from a partial
        // page could mistake a temporarily truncated response for a PlanType
        // transition and update the wrong account.
      }
      const remoteAccounts = await listSub2ApiErrorAccounts(config);
      summary.checked = remoteAccounts.length;
      const grouped = new Map();
      for (const account of remoteAccounts) {
        if (!isSub2ApiAccountInMonitoredGroups(account, monitorGroupIds)) {
          summary.outsideGroups += 1;
          continue;
        }
        const email = sub2ApiAccountEmail(account);
        if (!email) {
          summary.missingEmail += 1;
          continue;
        }
        if (!grouped.has(email)) grouped.set(email, []);
        grouped.get(email).push(account);
      }

      for (const [email, accounts] of grouped) {
        await withEmailJobLock(email, async () => {
          const job = findJobByEmail(email);
          if (!job) {
            summary.missingTask += accounts.length;
            return;
          }
          summary.matched += accounts.length;
          if (job.autoRepairBlocked) {
            summary.blocked += accounts.length;
            return;
          }
          if (isActive(job.status) || job.autoRepairOperation) {
            summary.busy += accounts.length;
            return;
          }
          if (isAutoRepairCoolingDown(job)) {
            summary.cooldown += accounts.length;
            return;
          }
          await reloadMissingJobCredentials(job);
          const eligibility = getAutoRepairEligibility(job);
          if (!eligibility.eligible) {
            summary.ineligible += accounts.length;
            return;
          }

          const operation = createSub2ApiAutoRepairOperation(config, accounts, profileState);
          await forceReloginJob(job, {}, { autoRepair: operation });
          appendJobLog(job, `[monitor] Sub2API 号池发现 ${accounts.length} 条异常记录，已自动加入重新登录并授权队列。\n`);
          await saveJobMetadata(job);
          summary.started += accounts.length;
        });
      }

      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastResult = summary;
      await persistSub2ApiMonitorConfiguration();
      return summary;
    } catch (error) {
      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastError = String(error?.message || error).slice(0, 500);
      await persistSub2ApiMonitorConfiguration().catch(() => {});
      throw error;
    } finally {
      sub2ApiMonitorState.running = false;
    }
  })().finally(() => {
    sub2ApiMonitorPromise = null;
  });
  return sub2ApiMonitorPromise;
}

const SUB2API_PROFILE_FIELD_LABELS = {
  groupIds: "号池",
  proxyId: "代理",
  concurrency: "并发数",
  loadFactor: "负载因子",
  priority: "优先级",
  accountNameTemplate: "账号命名模板",
  modelWhitelist: "模型白名单",
  codexFingerprintMode: "Codex 指纹模式",
  wsMode: "WS mode",
};
const SUB2API_PROFILE_SYNC_CONCURRENCY = 4;
const SUB2API_PROXY_STATE_TTL_MS = 60_000;
const sub2ApiProxyStateCache = new Map();

function isSub2ApiProxyExpired(proxy, now = Date.now()) {
  if (["expired", "deleted", "removed", "disabled", "inactive"].includes(String(proxy?.status || "").trim().toLowerCase())) return true;
  const expiresAt = proxy?.expires_at ? Date.parse(proxy.expires_at) : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function getSub2ApiProxyState(config, proxyId) {
  const key = `${monitorBackendIdentity(config)}:${proxyId}`;
  const cached = sub2ApiProxyStateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SUB2API_PROXY_STATE_TTL_MS) return cached.state;
  let state;
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/proxies/${encodeURIComponent(proxyId)}`);
    const proxy = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!proxy || Number(proxy.id) !== Number(proxyId)) return { found: null };
    state = { found: true, proxy };
  } catch (error) {
    // Some Sub2API versions expose only /proxies/all. Confirm a 404 against
    // that list before treating the configured proxy as deleted.
    if (error?.remoteStatus !== 404) return { found: null };
    try {
      const payload = await requestSub2Api(config, "/api/v1/admin/proxies/all");
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data) ? payload.data : [];
      const proxy = items.find((item) => Number(item?.id) === Number(proxyId));
      state = proxy ? { found: true, proxy } : { found: false };
    } catch (listError) {
      // A transient failure must not switch accounts to direct. Only a
      // successful list that omits the ID is treated as a deletion.
      return { found: null };
    }
  }
  sub2ApiProxyStateCache.set(key, { fetchedAt: Date.now(), state });
  return state;
}

/**
 * Resolve the proxy that should actually be written for a configured proxy ID.
 * An expired or deleted proxy falls back to direct, unless Sub2API itself was
 * configured to fall back to a backup proxy that is still usable. When the
 * state cannot be read, the configured proxy is kept unchanged.
 */
async function resolveSub2ApiProxyFallback(config, proxyId) {
  const state = await getSub2ApiProxyState(config, proxyId);
  if (state.found === null) return proxyId;
  if (state.found && !isSub2ApiProxyExpired(state.proxy)) return proxyId;
  const backupId = Number(state.proxy?.backup_proxy_id);
  if (state.found && state.proxy.fallback_mode === "proxy" && Number.isSafeInteger(backupId) && backupId > 0 && backupId !== proxyId) {
    const backup = await getSub2ApiProxyState(config, backupId);
    if (backup.found && !isSub2ApiProxyExpired(backup.proxy)
      && String(backup.proxy.status || "active").toLowerCase() === "active") {
      return backupId;
    }
  }
  return SUB2API_PROXY_DIRECT;
}

async function resolveSub2ApiWriteConfig(accountConfig) {
  const proxyId = Number(accountConfig?.proxyId);
  if (!Number.isSafeInteger(proxyId) || proxyId <= 0) return accountConfig;
  const target = await resolveSub2ApiProxyFallback(accountConfig, proxyId);
  return target === proxyId ? accountConfig : { ...accountConfig, proxyId: target, proxyFallbackFrom: proxyId };
}

function sub2ApiProxyFields(accountConfig) {
  if (String(accountConfig?.proxyId || "").trim().toLowerCase() === SUB2API_PROXY_DIRECT) {
    return { proxy_id: 0 };
  }
  return accountConfig.proxyId ? { proxy_id: accountConfig.proxyId } : {};
}

/**
 * Move pool accounts off proxies that a profile uses but that have expired or
 * been deleted. Accounts Sub2API already moved (to direct or a backup proxy)
 * no longer reference the expired ID and are left alone.
 */
async function fallBackExpiredSub2ApiProxies(config, profileState, accounts, summary) {
  const proxyIds = [...new Set([...profileState.profiles.values()]
    .map((profile) => Number(profile.proxyId))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (const proxyId of proxyIds) {
    if (shuttingDown) return;
    const target = await resolveSub2ApiProxyFallback(config, proxyId);
    if (target === proxyId) continue;
    for (const account of accounts) {
      const accountId = normalizeSub2ApiAccountId(account?.id);
      if (!accountId || Number(account?.proxy_id) !== proxyId) continue;
      try {
        await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify({ proxy_id: target === SUB2API_PROXY_DIRECT ? 0 : target }),
        });
        summary.proxyFallbackUpdated += 1;
      } catch (error) {
        summary.proxyFallbackFailed += 1;
        console.warn(`[warn] Sub2API 账号 ${accountId} 代理回退失败：${String(error?.message || error).slice(0, 180)}`);
      }
    }
  }
  if (summary.proxyFallbackUpdated) invalidateSub2ApiAccountStatusCache();
}

/**
 * Compare the profile state before and after a settings save and return the
 * PlanTypes whose bound profile parameters changed. Only PlanTypes that were
 * explicitly bound both before and after the save qualify: for a newly bound
 * PlanType the parameters currently stored on its pool accounts are unknown,
 * and unbound PlanTypes follow the fallback profile, which is deliberately
 * never pushed automatically.
 */
function diffSub2ApiProfileSyncTargets(previous, next) {
  const targets = [];
  for (const [planType, profileId] of Object.entries(next.bindings || {})) {
    const previousProfileId = resolveSub2ApiProfileBinding(planType, previous.bindings);
    if (!previousProfileId) continue;
    const before = previous.profiles.get(previousProfileId);
    const after = next.profiles.get(profileId);
    if (!before || !after) continue;
    const fields = SUB2API_PROFILE_FIELDS.filter((field) => (
      JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)
    ));
    if (fields.length) targets.push({ planType, profileId, fields });
  }
  return targets;
}

// A cleared profile value means "keep whatever the account already has" on
// every other write path, so a save never clears these fields remotely either.
function unsyncableSub2ApiProfileFields(accountConfig, fields) {
  return fields.filter((field) => {
    if (field === "groupIds") return !accountConfig.groupIds.length;
    if (field === "proxyId") return !accountConfig.proxyId;
    if (["concurrency", "loadFactor", "priority"].includes(field)) return accountConfig[field] === null;
    if (field === "accountNameTemplate") return !accountConfig.accountNameTemplate;
    if (field === "modelWhitelist") return !accountConfig.modelWhitelist.length;
    return false;
  });
}

function buildSub2ApiProfileSyncUpdate(remoteAccount, accountConfig, fields) {
  const changed = new Set(fields);
  const body = {};
  if (changed.has("groupIds")) body.group_ids = accountConfig.groupIds;
  if (changed.has("proxyId")) Object.assign(body, sub2ApiProxyFields(accountConfig));
  if (changed.has("concurrency")) body.concurrency = accountConfig.concurrency;
  if (changed.has("loadFactor")) body.load_factor = accountConfig.loadFactor;
  if (changed.has("priority")) body.priority = accountConfig.priority;
  if (changed.has("accountNameTemplate")) {
    const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, remoteAccount);
    if (accountName) body.name = accountName;
  }
  if (changed.has("codexFingerprintMode") || changed.has("wsMode")) {
    body.extra = buildSub2ApiAccountExtra(normalizeSub2ApiExtra(remoteAccount.extra), accountConfig);
  }
  if (changed.has("modelWhitelist")) {
    body.credentials = {
      ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
      model_mapping: Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model])),
    };
  }
  return body;
}

/**
 * Push changed profile parameters to every pool account whose PlanType is
 * bound to the edited profile. Only the changed fields are written, so
 * per-account adjustments to other fields (for example a manually edited
 * priority) survive unrelated profile edits. The settings are already saved
 * when this runs; failures are reported back instead of failing the save.
 */
async function syncSub2ApiProfileChanges(config, targets, profileState) {
  if (!targets.length) return null;
  const syncTargets = [];
  for (const target of targets) {
    const profile = profileState.profiles.get(target.profileId);
    const accountConfig = await resolveSub2ApiWriteConfig(profileConfig(profile, config));
    const skipped = unsyncableSub2ApiProfileFields(accountConfig, target.fields);
    syncTargets.push({ ...target, accountConfig, fields: target.fields.filter((field) => !skipped.includes(field)), skipped });
  }
  const fields = [...new Set(syncTargets.flatMap((target) => target.fields))];
  const skippedFields = [...new Set(syncTargets.flatMap((target) => target.skipped))];
  const result = {
    planTypes: syncTargets.map((target) => target.planType),
    fields,
    fieldLabels: fields.map((field) => SUB2API_PROFILE_FIELD_LABELS[field] || field),
    skippedFields,
    skippedFieldLabels: skippedFields.map((field) => SUB2API_PROFILE_FIELD_LABELS[field] || field),
    matched: 0,
    updated: 0,
    failed: 0,
    incomplete: false,
    error: null,
  };
  const pushTargets = new Map(syncTargets
    .filter((target) => target.fields.length)
    .map((target) => [target.planType.toLowerCase(), target]));
  if (!pushTargets.size) return result;
  if (!config?.baseUrl || !config?.adminApiKey) {
    result.error = "尚未配置 Sub2API 后端地址和管理员 API Key";
    return result;
  }

  let listing;
  try {
    listing = await listSub2ApiAccounts(config, { withMeta: true });
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 500);
    return result;
  }
  result.incomplete = !listing.complete;
  const work = [];
  for (const account of listing.accounts) {
    const accountId = normalizeSub2ApiAccountId(account?.id);
    const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
    const target = planType ? pushTargets.get(planType.toLowerCase()) : null;
    if (accountId && target) work.push({ accountId, account, target });
  }
  result.matched = work.length;

  let cursor = 0;
  const worker = async () => {
    while (cursor < work.length && !shuttingDown) {
      const { accountId, account, target } = work[cursor];
      cursor += 1;
      const body = buildSub2ApiProfileSyncUpdate(account, target.accountConfig, target.fields);
      if (!Object.keys(body).length) continue;
      try {
        await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        result.updated += 1;
      } catch (error) {
        result.failed += 1;
        result.error ||= String(error?.message || error).slice(0, 500);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SUB2API_PROFILE_SYNC_CONCURRENCY, work.length) }, worker));
  if (result.updated) invalidateSub2ApiAccountStatusCache();
  return result;
}

async function updateSub2ApiAccountFromProfile(globalConfig, remoteAccount, profile) {
  const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
  if (!accountId) return false;
  const accountConfig = await resolveSub2ApiWriteConfig(profileConfig(profile, globalConfig));
  const body = {};
  if (Array.isArray(accountConfig.groupIds) && accountConfig.groupIds.length) body.group_ids = accountConfig.groupIds;
  Object.assign(body, sub2ApiProxyFields(accountConfig));
  if (accountConfig.concurrency !== null) body.concurrency = accountConfig.concurrency;
  if (accountConfig.loadFactor !== null) body.load_factor = accountConfig.loadFactor;
  if (accountConfig.priority !== null) body.priority = accountConfig.priority;
  const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, remoteAccount);
  if (accountName) body.name = accountName;
  body.extra = buildSub2ApiAccountExtra(remoteAccount.extra, accountConfig);
  if (accountConfig.modelWhitelist.length) {
    body.credentials = {
      ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
      model_mapping: Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model])),
    };
  }
  await requestSub2Api(globalConfig, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return true;
}

function buildSub2ApiAccountUpdate(localAccount, accountConfig, remoteAccount = {}) {
  const remoteCredentials = remoteAccount?.credentials && typeof remoteAccount.credentials === "object"
    ? remoteAccount.credentials
    : {};
  const localCredentials = localAccount?.credentials && typeof localAccount.credentials === "object"
    ? localAccount.credentials
    : {};
  const credentials = {
    // Keep fields managed by Sub2API (usage snapshots, error metadata, or
    // provider-specific values) while letting the freshly selected workspace
    // OAuth bundle replace the credential values.
    ...remoteCredentials,
    ...localCredentials,
  };
  const targetPlanType = normalizePlanType(
    localAccount?.plan_type
      || localCredentials.plan_type
      || localAccount?.extra?.plan_type
      || extractPlanTypeFromAccount(localAccount, { preferJwt: false })
      || "",
  );
  if (targetPlanType) credentials.plan_type = targetPlanType;
  if (accountConfig.modelWhitelist.length) {
    credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
  }
  // Sub2API deployments may serialize `extra` as a JSON string. Normalize
  // both sides before merging so usage snapshots and provider metadata do
  // not disappear when a workspace switch updates the credentials.
  const remoteExtra = normalizeSub2ApiExtra(remoteAccount?.extra);
  const localExtra = normalizeSub2ApiExtra(localAccount?.extra);
  const mergedExtra = { ...remoteExtra, ...localExtra };
  if (targetPlanType) mergedExtra.plan_type = targetPlanType;
  const extra = buildSub2ApiAccountExtra(mergedExtra, accountConfig);
  const accountId = normalizeSub2ApiAccountId(remoteAccount?.id || localAccount?.id);
  const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, {
    ...localAccount,
    id: accountId || localAccount?.id,
  });
  return {
    credentials,
    extra,
    ...(targetPlanType ? { plan_type: targetPlanType } : {}),
    ...(accountName ? { name: accountName } : {}),
    ...(accountConfig.groupIds.length
      ? { group_ids: accountConfig.groupIds }
      : { group_ids: sub2ApiAccountGroupIds(remoteAccount) }),
    ...sub2ApiProxyFields(accountConfig),
    ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
    ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
    ...(accountConfig.priority !== null ? { priority: accountConfig.priority } : {}),
  };
}

/**
 * Update the existing Sub2API account records after a ChatGPT workspace
 * switch. The remote account id is deliberately retained; matching by email
 * prevents the normal batch-import endpoint from creating a duplicate record
 * every time the account changes between a personal and an organization
 * workspace. When a historical duplicate already exists, update every record
 * with the same email so their credentials and PlanType converge.
 */
async function synchronizeSub2ApiWorkspaceAccount(job) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !config?.adminApiKey) {
    return { configured: false, matched: 0, updated: 0, accountIds: [] };
  }
  const payload = await buildSub2ApiUploadPayload([job]);
  const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === String(job.email || "").trim().toLowerCase())
    || payload.accounts[0];
  if (!localAccount?.credentials) throw new Error("授权文件中没有可同步的账号凭据");

  const listing = await listSub2ApiAccounts(config, { withMeta: true });
  if (!listing.complete) throw new Error("Sub2API 账号列表不完整，已停止工作空间同步以避免写错账号");
  const email = sub2ApiAccountEmail(localAccount) || String(job.email || "").trim().toLowerCase();
  const matches = listing.accounts.filter((account) => sub2ApiAccountEmail(account) === email);
  if (!matches.length) {
    invalidateSub2ApiAccountStatusCache();
    return { configured: true, matched: 0, updated: 0, accountIds: [] };
  }

  const profileState = snapshotSub2ApiProfileState();
  const accountIds = [];
  for (const remoteAccount of matches) {
    const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
    if (!accountId) continue;
    const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(config, localAccount, profileState));
    const accountUpdate = buildSub2ApiAccountUpdate(localAccount, accountConfig, remoteAccount);
    await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: JSON.stringify(accountUpdate),
    });
    accountIds.push(accountId);
  }
  if (accountIds.length) invalidateSub2ApiAccountStatusCache();
  return { configured: true, matched: matches.length, updated: accountIds.length, accountIds };
}

function createSub2ApiAutoRepairOperation(config, accounts, profileState = snapshotSub2ApiProfileState()) {
  const validAccounts = accounts.filter((account) => {
    const id = Number(account?.id);
    return Number.isSafeInteger(id) && id > 0;
  });
  return {
    accountIds: validAccounts.map((account) => Number(account.id)),
    accounts: validAccounts,
    backend: monitorBackendIdentity(config),
    config,
    profileState,
    startedAt: new Date().toISOString(),
  };
}

async function retryPendingSub2ApiUploads(config, summary, profileState = snapshotSub2ApiProfileState()) {
  const backend = monitorBackendIdentity(config);
  const legacyBackend = legacyMonitorBackendIdentity(config);
  for (const candidate of listUniqueJobs()) {
    await withEmailJobLock(candidate.email, async () => {
      const job = findJobByEmail(candidate.email);
      const pendingIds = [...new Set(job?.autoRepairPendingAccountIds || [])]
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (
        !job
        || pendingIds.length === 0
        || ![backend, legacyBackend].includes(job.autoRepairPendingBackend)
        || !job.resultSaved
        || job.status !== "completed"
        || job.autoRepairOperation
        || isAutoRepairCoolingDown(job)
      ) return;

      const accounts = [];
      const missingIds = [];
      const expectedEmail = String(job.email || "").trim().toLowerCase();
      try {
        for (const accountId of pendingIds) {
          const account = await getSub2ApiAccount(config, accountId);
          const remoteEmail = account && sub2ApiAccountEmail(account);
          if (account && remoteEmail === expectedEmail) accounts.push(account);
          else {
            missingIds.push(accountId);
            if (account) {
              appendJobLog(job, `[monitor] 待重传账号 ${accountId} 的邮箱与任务不一致，已停止更新以避免覆盖错误账号。\n`);
            }
          }
        }
      } catch (error) {
        job.autoRepairLastAttemptAt = new Date().toISOString();
        job.autoRepairLastError = String(error?.message || error).slice(0, 500);
        appendJobLog(job, `[monitor] 读取待重传的 Sub2API 账号失败：${job.autoRepairLastError}。\n`);
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      if (missingIds.length) {
        const missing = new Set(missingIds);
        job.autoRepairPendingAccountIds = pendingIds.filter((id) => !missing.has(id));
        appendJobLog(job, `[monitor] ${missingIds.length} 条待重传账号已从 Sub2API 删除，已停止重试。\n`);
      }
      if (!accounts.length) {
        job.autoRepairPendingBackend = null;
        job.autoRepairLastError = null;
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      job.autoRepairOperation = createSub2ApiAutoRepairOperation(config, accounts, profileState);
      job.autoRepairLastAttemptAt = new Date().toISOString();
      appendJobLog(job, `[monitor] 正在重传 ${accounts.length} 条上次未完成的 Sub2API 更新，不重复登录。\n`);
      if (await finishSub2ApiAutoRepairSuccess(job)) summary.updated += accounts.length;
    });
  }
}

async function getSub2ApiAccount(config, accountId) {
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`);
    const account = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!account || normalizeSub2ApiAccountId(account.id) !== normalizeSub2ApiAccountId(accountId)) {
      throw new Error(`Sub2API 账号 ${accountId} 返回数据不完整`);
    }
    return account;
  } catch (error) {
    if (error?.remoteStatus === 404) return null;
    throw error;
  }
}

async function listSub2ApiErrorAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      platform: "openai",
      status: "error",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai" && String(account.status || "error") === "error"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

function sub2ApiAccountEmail(account) {
  const direct = [
    account?.email,
    account?.account_email,
    account?.credentials?.email,
    account?.credentials?.account_email,
    account?.extra?.email,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .find(isEmail);
  if (direct) return direct;
  const match = String(account?.name || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match && isEmail(match[0]) ? match[0] : null;
}

async function loadSub2ApiAccountStatus({ forceRefresh = false } = {}) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !config?.adminApiKey) {
    sub2ApiAccountStatusCache = { backend: null, fetchedAt: null, accounts: new Map() };
    return sub2ApiAccountStatusCache;
  }
  const backend = monitorBackendIdentity(config);
  const cacheAge = sub2ApiAccountStatusCache.fetchedAt
    ? Date.now() - Date.parse(sub2ApiAccountStatusCache.fetchedAt)
    : Number.POSITIVE_INFINITY;
  if (!forceRefresh && sub2ApiAccountStatusCache.backend === backend && cacheAge < SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS) {
    return sub2ApiAccountStatusCache;
  }
  if (sub2ApiAccountStatusPromise) return sub2ApiAccountStatusPromise;
  sub2ApiAccountStatusPromise = (async () => {
    const remoteAccounts = await listSub2ApiAccounts(config);
    const accounts = new Map();
    const fetchedAt = new Date().toISOString();
    const previousAccounts = sub2ApiAccountStatusCache.backend === backend
      ? sub2ApiAccountStatusCache.accounts
      : new Map();
    for (const remoteAccount of remoteAccounts) {
      const email = sub2ApiAccountEmail(remoteAccount);
      const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
      if (!email || !accountId) continue;
      const groupIds = sub2ApiAccountGroupIds(remoteAccount);
      const enabled = sub2ApiAccountSchedulable(remoteAccount);
      const priority = sub2ApiAccountPriority(remoteAccount);
      const usage = normalizeSub2ApiUsage(remoteAccount, fetchedAt);
      const current = accounts.get(email);
      const previous = previousAccounts.get(email);
      if (!current) {
        accounts.set(email, {
          email,
          accountIds: [accountId],
          groupIds,
          enabled,
          priority,
          planType: extractPlanTypeFromAccount(remoteAccount, { preferJwt: false }) || null,
          remoteStatus: String(remoteAccount?.status || "").trim() || null,
          usage: mergeSub2ApiUsage(previous?.usage || null, usage),
          fetchedAt,
        });
        continue;
      }
      current.accountIds = [...new Set([...current.accountIds, accountId])];
      current.groupIds = [...new Set([...current.groupIds, ...groupIds])];
      current.enabled = mergeSub2ApiBoolean(current.enabled, enabled);
      current.priority = mergeSub2ApiPriority(current.priority, priority);
      current.planType ||= extractPlanTypeFromAccount(remoteAccount, { preferJwt: false }) || null;
      current.remoteStatus ||= String(remoteAccount?.status || "").trim() || null;
      current.usage = mergeSub2ApiUsage(current.usage, usage);
    }
    sub2ApiAccountStatusCache = { backend, fetchedAt, accounts };
    return sub2ApiAccountStatusCache;
  })().finally(() => {
    sub2ApiAccountStatusPromise = null;
  });
  return sub2ApiAccountStatusPromise;
}

function invalidateSub2ApiAccountStatusCache() {
  sub2ApiAccountStatusCache = { backend: null, fetchedAt: null, accounts: new Map() };
}

function publicSub2ApiAccountStatusState(state = sub2ApiAccountStatusCache) {
  const accounts = {};
  for (const [email, entry] of state.accounts || []) accounts[email] = publicSub2ApiAccountStatusEntry(entry);
  return {
    configured: Boolean(state.backend && state.fetchedAt),
    fetchedAt: state.fetchedAt || null,
    accounts,
  };
}

function publicSub2ApiAccountStatusEntry(entry) {
  return {
    email: entry.email,
    accountId: entry.accountIds?.[0] || null,
    accountIds: [...(entry.accountIds || [])],
    inPool: true,
    enabled: entry.enabled ?? null,
    priority: entry.priority ?? null,
    planType: entry.planType || null,
    groupIds: [...(entry.groupIds || [])],
    remoteStatus: entry.remoteStatus || null,
    usage: publicSub2ApiUsage(entry.usage),
    fetchedAt: entry.fetchedAt || null,
  };
}

function normalizeSub2ApiUsage(account, fallbackFetchedAt = null) {
  const extra = normalizeSub2ApiExtra(account?.extra);
  const primary = normalizeSub2ApiUsageWindow(extra, "5h");
  const secondary = normalizeSub2ApiUsageWindow(extra, "7d");
  const remoteUpdatedAt = normalizeSub2ApiUsageDate(extra.codex_usage_updated_at)
    || normalizeSub2ApiUsageDate(account?.usage_updated_at)
    || normalizeSub2ApiUsageDate(account?.usageUpdatedAt);
  const updatedAt = remoteUpdatedAt || fallbackFetchedAt;
  const creditsRaw = extra.codex_credits_snapshot?.credits;
  const credits = creditsRaw && typeof creditsRaw === "object"
    ? {
        hasCredits: typeof creditsRaw.has_credits === "boolean" ? creditsRaw.has_credits : null,
        unlimited: typeof creditsRaw.unlimited === "boolean" ? creditsRaw.unlimited : null,
        balance: creditsRaw.balance === null || creditsRaw.balance === undefined ? null : String(creditsRaw.balance),
        overageLimitReached: typeof creditsRaw.overage_limit_reached === "boolean" ? creditsRaw.overage_limit_reached : null,
      }
    : null;
  if (!primary && !secondary && !credits) return null;
  const limitReached = [primary, secondary].some((window) => window?.usedPercent !== null && window.usedPercent >= 100)
    ? true
    : [primary, secondary].some(Boolean) ? false : null;
  return {
    source: "sub2api",
    fetchedAt: updatedAt,
    snapshotTimestamp: remoteUpdatedAt,
    planType: extractPlanTypeFromAccount(account, { preferJwt: false }) || null,
    allowed: limitReached === null ? null : !limitReached,
    limitReached,
    primary,
    secondary,
    credits,
  };
}

function normalizeSub2ApiExtra(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 256_000) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicSub2ApiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    source: "sub2api",
    fetchedAt: usage.fetchedAt || null,
    planType: usage.planType || null,
    allowed: usage.allowed ?? null,
    limitReached: usage.limitReached ?? null,
    primary: publicSub2ApiUsageWindow(usage.primary),
    secondary: publicSub2ApiUsageWindow(usage.secondary),
    credits: usage.credits ? { ...usage.credits } : null,
  };
}

function publicSub2ApiUsageWindow(window) {
  if (!window) return null;
  return { ...window };
}

function mergeSub2ApiUsage(current, next) {
  if (!current) return next || null;
  if (!next) return current;
  const currentTimestamp = Date.parse(current.snapshotTimestamp || current.fetchedAt || "") || 0;
  const nextTimestamp = Date.parse(next.snapshotTimestamp || next.fetchedAt || "") || 0;
  const currentHasRemoteTimestamp = Boolean(current.snapshotTimestamp);
  const nextHasRemoteTimestamp = Boolean(next.snapshotTimestamp);
  const preferNext = currentHasRemoteTimestamp !== nextHasRemoteTimestamp
    ? nextHasRemoteTimestamp
    : nextTimestamp >= currentTimestamp;
  const primary = preferNext ? (next.primary || current.primary) : (current.primary || next.primary);
  const secondary = preferNext ? (next.secondary || current.secondary) : (current.secondary || next.secondary);
  const credits = preferNext ? (next.credits || current.credits) : (current.credits || next.credits);
  return {
    ...current,
    ...next,
    fetchedAt: preferNext ? next.fetchedAt : current.fetchedAt,
    snapshotTimestamp: preferNext ? (next.snapshotTimestamp || current.snapshotTimestamp || null) : (current.snapshotTimestamp || next.snapshotTimestamp || null),
    planType: preferNext ? (next.planType || current.planType || null) : (current.planType || next.planType || null),
    allowed: preferNext ? (next.allowed ?? current.allowed ?? null) : (current.allowed ?? next.allowed ?? null),
    limitReached: preferNext ? (next.limitReached ?? current.limitReached ?? null) : (current.limitReached ?? next.limitReached ?? null),
    primary,
    secondary,
    credits,
  };
}

function normalizeSub2ApiUsageWindow(extra, window) {
  const prefix = window === "5h" ? "codex_5h" : "codex_7d";
  const legacyPrefix = resolveSub2ApiLegacyWindowPrefix(extra, window);
  const usedPercent = firstSub2ApiUsageValue(
    [extra[`${prefix}_used_percent`], extra[`${legacyPrefix}_used_percent`]],
    normalizeSub2ApiUsagePercent,
  );
  const resetAt = firstSub2ApiUsageValue(
    [extra[`${prefix}_reset_at`], extra[`${legacyPrefix}_reset_at`]],
    normalizeSub2ApiUsageDate,
  );
  const resetAfterSeconds = firstSub2ApiUsageValue(
    [extra[`${prefix}_reset_after_seconds`], extra[`${legacyPrefix}_reset_after_seconds`]],
    normalizeSub2ApiUsageSeconds,
  );
  const windowMinutes = firstSub2ApiUsageValue(
    [extra[`${prefix}_window_minutes`], extra[`${legacyPrefix}_window_minutes`]],
    normalizeSub2ApiUsageSeconds,
  );
  if (usedPercent === null && !resetAt && resetAfterSeconds === null && windowMinutes === null) return null;
  return {
    usedPercent: usagePercentAfterReset(usedPercent, resetAt),
    resetAfterSeconds: resetAfterSeconds && resetAfterSeconds > 0 ? resetAfterSeconds : null,
    resetAt,
    limitWindowSeconds: windowMinutes && windowMinutes > 0 ? windowMinutes * 60 : null,
  };
}

function firstSub2ApiUsageValue(values, normalize) {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function resolveSub2ApiLegacyWindowPrefix(extra, window) {
  const primaryMinutes = normalizeSub2ApiUsageSeconds(extra.codex_primary_window_minutes);
  const secondaryMinutes = normalizeSub2ApiUsageSeconds(extra.codex_secondary_window_minutes);
  if (primaryMinutes !== null && secondaryMinutes !== null) {
    if (primaryMinutes <= 360 && secondaryMinutes > 360) return window === "5h" ? "codex_primary" : "codex_secondary";
    if (secondaryMinutes <= 360 && primaryMinutes > 360) return window === "5h" ? "codex_secondary" : "codex_primary";
  }
  if (primaryMinutes !== null) return primaryMinutes <= 360
    ? (window === "5h" ? "codex_primary" : "codex_secondary")
    : (window === "5h" ? "codex_secondary" : "codex_primary");
  if (secondaryMinutes !== null) return secondaryMinutes <= 360
    ? (window === "5h" ? "codex_secondary" : "codex_primary")
    : (window === "5h" ? "codex_primary" : "codex_secondary");
  // Sub2API's legacy fallback treats primary as 7d and secondary as 5h.
  return window === "5h" ? "codex_secondary" : "codex_primary";
}

function normalizeSub2ApiUsagePercent(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

function normalizeSub2ApiUsageSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 31_536_000 ? Math.round(number) : null;
}

function normalizeSub2ApiUsageDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric <= 0) return null;
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function getSub2ApiAccountStatusForJob(job, state = sub2ApiAccountStatusCache) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const expectedBackend = config?.baseUrl ? monitorBackendIdentity(config) : null;
  if (!state?.fetchedAt || state.backend !== expectedBackend) {
    return { inPool: null, enabled: null, priority: null, accountId: null, accountIds: [], groupIds: [], remoteStatus: null, planType: null, usage: null };
  }
  const entry = state.accounts.get(String(job.email || "").toLowerCase());
  if (!entry) return { inPool: false, enabled: null, priority: null, accountId: null, accountIds: [], groupIds: [], remoteStatus: null, planType: null, usage: null };
  return {
    inPool: true,
    enabled: entry.enabled ?? null,
    priority: entry.priority ?? null,
    accountId: entry.accountIds?.[0] || null,
    accountIds: [...(entry.accountIds || [])],
    groupIds: [...(entry.groupIds || [])],
    remoteStatus: entry.remoteStatus || null,
    planType: entry.planType || null,
    usage: entry.usage || null,
  };
}

function getJobPlanType(job, state = sub2ApiAccountStatusCache) {
  return job.workspacePlanType || job.planType || getSub2ApiAccountStatusForJob(job, state).planType || null;
}

function normalizeSub2ApiAccountId(value) {
  const id = String(value ?? "").trim();
  return id
    && id.length <= 128
    && !/[/?#]/.test(id)
    && !["__proto__", "constructor", "prototype"].includes(id.toLowerCase())
    ? id
    : null;
}

function normalizeSub2ApiPlanTypeState(value) {
  const normalized = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [rawId, rawPlanType] of Object.entries(value)) {
    const accountId = normalizeSub2ApiAccountId(rawId);
    if (!accountId) continue;
    normalized[accountId] = normalizePlanType(rawPlanType) || null;
  }
  return normalized;
}

function sub2ApiAccountGroupIds(account) {
  const values = [
    ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
    ...(Array.isArray(account?.groupIds) ? account.groupIds : []),
    ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id ?? item?.groupId ?? item?.id) : []),
    ...(Array.isArray(account?.groups) ? account.groups.map((item) => item?.id ?? item?.group_id ?? item?.groupId) : []),
  ];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sub2ApiAccountSchedulable(account) {
  for (const value of [account?.schedulable, account?.is_schedulable, account?.enabled, account?.is_enabled]) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
    if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  }
  return null;
}

function sub2ApiAccountPriority(account) {
  for (const value of [account?.priority, account?.extra?.priority, account?.credentials?.priority, account?.settings?.priority]) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) return number;
    const text = String(value).trim();
    if (text.length <= 64 && !/[\r\n]/.test(text)) return text;
  }
  return null;
}

function mergeSub2ApiPriority(current, next) {
  return current === null || current === undefined ? (next ?? null) : current;
}

function mergeSub2ApiBoolean(current, next) {
  if (current === null || current === undefined) return next ?? null;
  if (next === null || next === undefined) return current;
  return current === true && next === true;
}

async function listSub2ApiAccounts(config, options = {}) {
  const accounts = [];
  const withMeta = options?.withMeta === true;
  let complete = true;
  const pageSize = 100;
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      platform: "openai",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.list)
            ? data.list
            : Array.isArray(data?.records)
              ? data.records
              : Array.isArray(data?.accounts)
                ? data.accounts
                : Array.isArray(payload?.accounts)
                  ? payload.accounts
                  : null;
    if (!items) complete = false;
    const pageItems = items || [];
    accounts.push(...pageItems.filter((account) => account && typeof account === "object"));
    const reportedPages = Number(data?.pages ?? data?.total_pages ?? data?.totalPages);
    const reportedTotal = Number(data?.total ?? data?.total_count ?? data?.count);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
        ? Math.max(page, Math.ceil(reportedTotal / pageSize))
        : pageItems.length >= pageSize ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  if (page <= pages) complete = false;
  return withMeta ? { accounts, complete } : accounts;
}

async function listSub2ApiTargetGroups(config) {
  const results = await Promise.allSettled(SUB2API_TARGET_GROUP_PLATFORMS.map(async (platform) => {
    const payload = await requestSub2Api(config, `/api/v1/admin/groups/all?platform=${platform}`);
    const groups = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    return groups
      .filter((group) => group && Number.isInteger(Number(group.id)))
      .map((group) => ({
        id: Number(group.id),
        name: String(group.name || `号池 ${group.id}`),
        platform: String(group.platform || platform).trim().toLowerCase() || platform,
        status: String(group.status || "active"),
      }));
  }));
  const successfulResults = results.filter((result) => result.status === "fulfilled");
  const successful = successfulResults.flatMap((result) => result.value);
  if (!successfulResults.length) {
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  const groups = new Map();
  for (const group of successful) {
    const key = String(group.id);
    if (!groups.has(key)) groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => (
    String(left.platform).localeCompare(String(right.platform))
      || left.id - right.id
      || String(left.name).localeCompare(String(right.name), "zh-CN")
  ));
}

function isSub2ApiAccountInMonitoredGroups(account, groupIds) {
  if (!groupIds.length) return true;
  const accountGroupIds = sub2ApiAccountGroupIds(account)
    .map(Number)
    .filter(Number.isSafeInteger);
  return groupIds.some((id) => accountGroupIds.includes(Number(id)));
}

function sub2ApiMonitorGroupIds(activeConfig, profileState = null) {
  const profiles = [...(profileState?.profiles || sub2ApiProfiles).values()];
  if (!profiles.length) return [...(activeConfig?.groupIds || [])];
  // An empty group selection means "all OpenAI accounts". Keep that meaning
  // when any profile is configured that way; otherwise monitor the union so a
  // plan bound to a non-active profile is not skipped.
  if (profiles.some((profile) => !Array.isArray(profile.groupIds) || profile.groupIds.length === 0)) return [];
  return [...new Set(profiles.flatMap((profile) => profile.groupIds).map(Number).filter(Number.isSafeInteger))];
}

function snapshotSub2ApiProfileState() {
  return {
    profiles: new Map([...sub2ApiProfiles.entries()].map(([id, profile]) => [id, { ...profile }])),
    bindings: { ...sub2ApiPlanTypeBindings },
  };
}

function monitorBackendIdentity(config) {
  // Include the key fingerprint so a tenant/key rotation cannot reuse an
  // account-ID PlanType baseline from a different Sub2API installation.
  return crypto.createHash("sha256")
    .update(`${String(config?.baseUrl || "")}\0${String(config?.adminApiKey || "")}`)
    .digest("hex")
    .slice(0, 24);
}

function legacyMonitorBackendIdentity(config) {
  return crypto.createHash("sha256")
    .update(String(config?.baseUrl || ""))
    .digest("hex")
    .slice(0, 24);
}

function isAutoRepairCoolingDown(job) {
  if (!job.autoRepairLastAttemptAt || !Number.isFinite(SUB2API_AUTO_REPAIR_COOLDOWN_MS) || SUB2API_AUTO_REPAIR_COOLDOWN_MS <= 0) return false;
  return Date.now() - new Date(job.autoRepairLastAttemptAt).getTime() < SUB2API_AUTO_REPAIR_COOLDOWN_MS;
}

function getAutoRepairEligibility(job) {
  if (job.autoRepairBlocked) return { eligible: false, reason: "账号已确认封禁、删除或永久停用" };
  if (!job.lastAuthAutomated) return { eligible: false, reason: job.lastAuthAutomationReason || "上次授权不是全自动完成" };
  const requirements = job.lastAuthRequirements || {};
  if (requirements.password && !job.password) return { eligible: false, reason: "已保存的密码无法读取" };
  if (requirements.emailOtp && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动收取邮箱验证码的 API" };
  if (requirements.mfa && !job.totpSecret) return { eligible: false, reason: "已保存的 2FA 密钥无法读取" };
  if (!job.password && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动登录的密码或邮件收码 API" };
  if (job.hasTotpCredential && !job.totpSecret) return { eligible: false, reason: "2FA 密钥在当前系统上无法恢复" };
  return { eligible: true, reason: "上次完整登录全自动完成，所需资料仍可用" };
}

function finishSub2ApiAutoRepairSuccess(job) {
  const operationPromise = performSub2ApiAutoRepairSuccess(job);
  sub2ApiAutoRepairPromises.add(operationPromise);
  void operationPromise.then(
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
  );
  return operationPromise;
}

async function performSub2ApiAutoRepairSuccess(job) {
  const operation = job.autoRepairOperation;
  if (!operation) return false;
  job.autoRepairPendingAccountIds = [...new Set(operation.accountIds)];
  job.autoRepairPendingBackend = operation.backend;
  try {
    const payload = await buildSub2ApiUploadPayload([job]);
    const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase())
      || payload.accounts[0];
    if (!localAccount?.credentials) throw new Error("新授权文件中没有可更新的账号凭据");

    const pendingIds = new Set(job.autoRepairPendingAccountIds);
    for (const remoteAccount of operation.accounts) {
      const accountId = Number(remoteAccount.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      // An error account can have a different PlanType from the monitor's active
      // profile. Resolve the bound profile per remote account before writing the
      // repaired credentials, otherwise auto-repair silently applies the active
      // profile to every account in the operation.
      const remotePlanType = extractPlanTypeFromAccount(remoteAccount, { preferJwt: false });
      const localPlanType = extractPlanTypeFromAccount(localAccount, { preferJwt: false });
      const profileAccount = {
        ...localAccount,
        ...remoteAccount,
        id: remoteAccount.id,
        name: remoteAccount.name,
        credentials: {
          ...(localAccount.credentials && typeof localAccount.credentials === "object" ? localAccount.credentials : {}),
          ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        },
        extra: {
          ...(localAccount.extra && typeof localAccount.extra === "object" ? localAccount.extra : {}),
          ...(remoteAccount.extra && typeof remoteAccount.extra === "object" ? remoteAccount.extra : {}),
        },
      };
      if (remotePlanType || localPlanType) profileAccount.plan_type = remotePlanType || localPlanType;
      const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(operation.config, profileAccount, operation.profileState));
      const credentials = {
        ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        ...localAccount.credentials,
      };
      if (accountConfig.modelWhitelist.length) {
        credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
      }
      const extra = buildSub2ApiAccountExtra(remoteAccount.extra, accountConfig);
      const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, {
        ...localAccount,
        id: remoteAccount.id,
        name: remoteAccount.name,
      });
      const accountUpdate = {
        credentials,
        extra,
        ...(accountName ? { name: accountName } : {}),
        ...(accountConfig.groupIds.length ? { group_ids: accountConfig.groupIds } : {}),
        ...sub2ApiProxyFields(accountConfig),
        ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
        ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
        ...(accountConfig.priority !== null ? { priority: accountConfig.priority } : {}),
      };
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify(accountUpdate),
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/clear-error`, {
        method: "POST",
        body: "{}",
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ schedulable: true }),
      });
      pendingIds.delete(accountId);
      job.autoRepairPendingAccountIds = [...pendingIds];
    }

    job.autoRepairLastSuccessAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
    job.autoRepairOperation = null;
    clearAutoRepairBlock(job);
    appendJobLog(job, `[monitor] 已用新授权覆盖更新 Sub2API 中的 ${operation.accountIds.length} 条账号记录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return true;
  } catch (error) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = String(error?.message || error).slice(0, 500);
    job.autoRepairOperation = null;
    appendJobLog(job, `[monitor] 新授权已生成，但更新 Sub2API 失败：${job.autoRepairLastError}。下次巡检会优先重传，不会重复登录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return false;
  }
}

async function finishSub2ApiAutoRepairFailure(job) {
  if (!job.autoRepairOperation) return;
  const operation = job.autoRepairOperation;
  job.autoRepairOperation = null;
  job.autoRepairLastAttemptAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason || job.lastError || "自动重新登录并授权未完成";
  appendJobLog(job, job.autoRepairBlocked
    ? "[monitor] 自动授权确认账号已永久不可用，已停止后续巡检。\n"
    : `[monitor] 本次自动授权未完成，${Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000))} 分钟内不会重复启动。\n`);
  if (!job.autoRepairBlocked) {
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = operation.backend;
  }
  touch(job);
  await saveJobMetadata(job);
}

async function exportSourceAccounts(res, ids) {
  const selected = resolveSelectedJobs(ids);
  const lines = [];
  for (const job of selected) {
    let password = job.password || "";
    let totpSecret = job.totpSecret || "";
    if ((!password && job.hasPasswordCredential) || (!totpSecret && job.hasTotpCredential)) {
      const storedCredentials = await loadStoredLoginCredentials(job.email);
      password ||= storedCredentials.password;
      totpSecret ||= storedCredentials.totpSecret;
    }
    if ((job.loginMode === "password" || job.hasPasswordCredential) && !password) {
      throw httpError(409, `${job.email} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (password) {
      const parts = [job.email, password];
      if (job.mailRequestBody) parts.push(job.mailRequestBody);
      else if (job.mailApiUrl) parts.push(job.mailApiUrl);
      if (totpSecret) parts.push(totpSecret);
      lines.push(parts.join("----"));
      continue;
    }
    if (job.mailRequestBody) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailRequestBody}----${totpSecret}`
        : `${job.email}----${job.mailRequestBody}`);
      continue;
    }
    if (job.mailApiUrl) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailApiUrl}----${totpSecret}`
        : `${job.email}----${job.mailApiUrl}`);
      continue;
    }
    if (job.loginMode === "manual") {
      throw httpError(409, `${job.email} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出`);
    }
    lines.push(totpSecret ? `${job.email}--------${totpSecret}` : job.email);
  }
  const payload = Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="chatgpt-account-source-${lines.length}-accounts-${downloadTimestamp()}.txt"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicJob(job) {
  const autoRepair = getAutoRepairEligibility(job);
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    prompt: job.status === "queued"
      ? `排队中，前方还有 ${Math.max(0, getQueuePosition(job) - 1)} 条任务`
      : job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastOperationAt: job.lastOperationAt || job.createdAt,
    lastOperationType: job.lastOperationType || "initial_authorization",
    completedAt: job.completedAt,
    startedAt: job.startedAt,
    durationMs: getJobDurationMs(job),
    planType: job.workspacePlanType || getJobPlanType(job),
    sub2apiInPool: sub2ApiStatus.inPool,
    sub2apiEnabled: sub2ApiStatus.enabled,
    sub2apiPriority: sub2ApiStatus.priority,
    sub2apiAccountId: sub2ApiStatus.accountId,
    sub2apiAccountIds: sub2ApiStatus.accountIds,
    sub2apiGroupIds: sub2ApiStatus.groupIds,
    sub2apiRemoteStatus: sub2ApiStatus.remoteStatus,
    sub2apiPlanType: sub2ApiStatus.planType,
    sub2apiUsage: publicSub2ApiUsage(sub2ApiStatus.usage),
    lastError: job.lastError,
    canDownload: Boolean(job.resultSaved),
    loginMode: job.loginMode || (job.mailApiUrl ? "email_otp" : "manual"),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    autoEmailOtp: Boolean(job.mailApiUrl),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    totpSetupSecret: job.status === "totp_setup_otp" ? job.totpSetupSecret : null,
    totpSetupUri: job.status === "totp_setup_otp" ? job.totpSetupUri : null,
    totpSetupError: job.totpSetupError || null,
    totpSetupReplaceExisting: Boolean(job.totpSetupReplaceExisting),
    totpRotationRemoteDisabled: Boolean(job.totpRotationRemoteDisabled),
    totpRotationStage: job.totpRotationStage || null,
    totpRotationIncomplete: Boolean(job.totpRotationIncomplete),
    passwordAddError: job.passwordAddError || null,
    passwordAddedAt: job.passwordAddedAt || null,
    smsProviderId: job.smsProviderId,
    smsProviderName: job.smsProviderName,
    smsServiceLabel: job.smsServiceLabel,
    smsStatus: job.smsStatus,
    smsError: job.smsError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: job.status === "resume_available",
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    canReplaceTotp: canReplaceTotp(job),
    canAddPassword: canAddPassword(job),
    restartRequired: job.restartRequired,
    proxyConfigured: Boolean(job.proxyUrl),
    autoRepairEligible: autoRepair.eligible,
    autoRepairEligibilityReason: autoRepair.reason,
    autoRepairBlocked: Boolean(job.autoRepairBlocked),
    autoRepairBlockedReason: job.autoRepairBlockedReason || null,
    autoRepairLastAttemptAt: job.autoRepairLastAttemptAt || null,
    autoRepairLastSuccessAt: job.autoRepairLastSuccessAt || null,
    autoRepairLastError: job.autoRepairLastError || null,
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

async function getAccountUsage(job, forceRefresh = false) {
  // Normal reads use the low-cost snapshot synchronized with the Sub2API account list.
  // An explicit refresh delegates the upstream probe to Sub2API for this account only.
  if (!job?.email) throw new Error("ACCOUNT_USAGE_CREDENTIALS_UNAVAILABLE: 账号标识无效");
  const state = await loadSub2ApiAccountStatus({ forceRefresh });
  let status = getSub2ApiAccountStatusForJob(job, state);
  if (forceRefresh && status.inPool === true && status.accountIds.length) {
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    const refreshed = await refreshSub2ApiAccountUsage(config, status.accountIds);
    if (refreshed) {
      const entry = state.accounts.get(String(job.email || "").toLowerCase());
      const merged = mergeSub2ApiUsage(entry?.usage || status.usage || null, refreshed);
      if (entry) {
        entry.usage = merged;
        entry.fetchedAt = new Date().toISOString();
        state.fetchedAt = entry.fetchedAt;
      }
      status = { ...status, usage: merged };
    }
  }
  const usage = publicSub2ApiUsage(status.usage);
  return usage || {
    source: "sub2api",
    fetchedAt: state.fetchedAt || null,
    planType: getJobPlanType(job, state),
    allowed: null,
    limitReached: null,
    primary: null,
    secondary: null,
    credits: null,
  };
}

async function refreshSub2ApiAccountUsage(config, accountIds) {
  if (!config?.baseUrl || !config?.adminApiKey) return null;
  const ids = [...new Set(accountIds.map((value) => normalizeSub2ApiAccountId(value)).filter(Boolean))].slice(0, 8);
  if (!ids.length) return null;
  const responses = await Promise.allSettled(ids.map((accountId) => requestSub2Api(
    config,
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/usage?source=active&force=true`,
  )));
  const usages = responses
    .filter((result) => result.status === "fulfilled")
    .map((result) => normalizeSub2ApiUsagePayload(result.value))
    .filter(Boolean);
  if (!usages.length) return null;
  return usages.reduce((current, next) => mergeSub2ApiUsage(current, next), null);
}

function normalizeSub2ApiUsagePayload(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!data || typeof data !== "object") return null;
  const rateLimit = data.rate_limit && typeof data.rate_limit === "object" ? data.rate_limit : {};
  const primary = normalizeSub2ApiResponseWindow(
    data.five_hour ?? data.fiveHour ?? rateLimit.primary_window ?? rateLimit.primaryWindow,
    "5h",
  );
  const secondary = normalizeSub2ApiResponseWindow(
    data.seven_day ?? data.sevenDay ?? rateLimit.secondary_window ?? rateLimit.secondaryWindow,
    "7d",
  );
  const snapshotTimestamp = normalizeSub2ApiUsageDate(data.updated_at ?? data.updatedAt ?? data.fetched_at ?? data.fetchedAt);
  const fetchedAt = snapshotTimestamp || new Date().toISOString();
  if (!primary && !secondary) return null;
  const inferredLimitReached = [primary, secondary].some((window) => window?.usedPercent !== null && window.usedPercent >= 100);
  const limitReached = typeof data.limit_reached === "boolean"
    ? data.limit_reached
    : typeof rateLimit.limit_reached === "boolean"
      ? rateLimit.limit_reached
      : inferredLimitReached;
  const explicitAllowed = typeof data.allowed === "boolean"
    ? data.allowed
    : typeof data.limit_reached === "boolean"
      ? !data.limit_reached
      : typeof rateLimit.allowed === "boolean"
        ? rateLimit.allowed
        : typeof rateLimit.limit_reached === "boolean"
          ? !rateLimit.limit_reached
          : null;
  return {
    source: "sub2api",
    fetchedAt,
    snapshotTimestamp,
    planType: null,
    allowed: explicitAllowed ?? !limitReached,
    limitReached,
    primary,
    secondary,
    credits: normalizeSub2ApiCredits(data.credits),
  };
}

function normalizeSub2ApiResponseWindow(value, fallbackWindow) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = firstSub2ApiUsageValue(
    [value.utilization, value.used_percent, value.usedPercent],
    normalizeSub2ApiUsagePercent,
  );
  const resetAt = firstSub2ApiUsageValue(
    [value.resets_at, value.reset_at, value.resetAt],
    normalizeSub2ApiUsageDate,
  );
  const resetAfterSeconds = firstSub2ApiUsageValue(
    [value.remaining_seconds, value.reset_after_seconds, value.resetAfterSeconds],
    normalizeSub2ApiUsageSeconds,
  );
  if (usedPercent === null && !resetAt && resetAfterSeconds === null) return null;
  return {
    usedPercent: usagePercentAfterReset(usedPercent, resetAt),
    resetAfterSeconds: resetAfterSeconds && resetAfterSeconds > 0 ? resetAfterSeconds : null,
    resetAt,
    limitWindowSeconds: firstSub2ApiUsageValue(
      [value.limit_window_seconds, value.limitWindowSeconds],
      normalizeSub2ApiUsageSeconds,
    ) || (fallbackWindow === "5h" ? 18_000 : 604_800),
  };
}

function usagePercentAfterReset(usedPercent, resetAt) {
  if (usedPercent === null || !resetAt) return usedPercent;
  return Date.parse(resetAt) <= Date.now() ? 0 : usedPercent;
}

function normalizeSub2ApiCredits(value) {
  if (!value || typeof value !== "object") return null;
  return {
    hasCredits: typeof value.has_credits === "boolean" ? value.has_credits : typeof value.hasCredits === "boolean" ? value.hasCredits : null,
    unlimited: typeof value.unlimited === "boolean" ? value.unlimited : null,
    balance: value.balance === null || value.balance === undefined ? null : String(value.balance),
    overageLimitReached: typeof value.overage_limit_reached === "boolean" ? value.overage_limit_reached : null,
  };
}

async function publicCredentialDetails(job, persisted = null) {
  let sub2apiJson = "";
  try {
    const raw = await fs.readFile(job.outputPath, "utf8");
    sub2apiJson = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {}
  return {
    email: job.email,
    password: job.password || "",
    totpSecret: job.totpSecret || "",
    hasPassword: Boolean(job.password || job.hasPasswordCredential),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    passwordAvailable: Boolean(job.password),
    totpSecretAvailable: Boolean(job.totpSecret),
    sub2apiJson,
    hasSub2apiJson: Boolean(sub2apiJson),
    persisted,
  };
}

function normalizePlanType(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 128 ? text : "";
}

function extractPlanTypeFromAccount(account, { preferJwt = true } = {}) {
  const fromJwt = extractPlanTypeFromJwt(account?.credentials?.id_token);
  const direct = normalizePlanType(
    account?.plan_type
      || account?.planType
      || account?.credentials?.plan_type
      || account?.credentials?.planType
      || account?.extra?.plan_type
      || account?.extra?.planType,
  );
  return preferJwt ? (fromJwt || direct) : (direct || fromJwt);
}

function extractPlanTypeFromJwt(jwt) {
  if (!jwt) return "";
  try {
    const [, payload] = String(jwt).split(".");
    if (!payload) return "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const authClaims = claims?.["https://api.openai.com/auth"];
    return normalizePlanType(
      authClaims?.plan_type
        || claims?.plan_type
        || authClaims?.chatgpt_plan_type
        || claims?.["https://api.openai.com/auth.chatgpt_plan_type"]
        || claims?.chatgpt_plan_type,
    );
  } catch {
    return "";
  }
}

async function readPlanTypeFromOutput(outputPath) {
  try {
    const data = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return extractPlanTypeFromAccount(data?.accounts?.[0]) || null;
  } catch {
    return null;
  }
}

function publicSelectionJob(job) {
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    planType: getJobPlanType(job),
    sub2apiInPool: sub2ApiStatus.inPool,
    sub2apiEnabled: sub2ApiStatus.enabled,
    sub2apiPriority: sub2ApiStatus.priority,
    sub2apiAccountId: sub2ApiStatus.accountId,
    sub2apiAccountIds: sub2ApiStatus.accountIds,
    canDownload: Boolean(job.resultSaved),
    sub2apiPlanType: sub2ApiStatus.planType,
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    canReplaceTotp: canReplaceTotp(job),
    canAddPassword: canAddPassword(job),
  };
}

function canForceRelogin(job) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);
}

function canSetupTotp(job) {
  if (job.totpSecret || job.hasTotpCredential || job.totpKnownEnabled) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "canceled", "reauth_required"].includes(job.status);
}

function canAddPassword(job) {
  if (job.password || job.hasPasswordCredential) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "canceled", "reauth_required"].includes(job.status);
}

function setStage(job, status, prompt) {
  if (isTerminalStatus(job.status)) return;
  job.status = status;
  job.prompt = prompt;
  job.lastError = null;
  touch(job);
}

function failJob(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "流程失败";
  job.lastError = message;
  if (isPermanentAccountFailure(message)) markAutoRepairBlocked(job, message);
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function beginAuthorizationAutomationAttempt(job, source) {
  job.authAutomationAttempt = {
    source,
    startedAt: new Date().toISOString(),
    requirements: { password: false, emailOtp: false, mfa: false },
    automatic: { password: false, emailOtp: false, mfa: false },
    manual: { password: false, emailOtp: false, mfa: false },
  };
}

function markAuthorizationRequirement(job, field) {
  if (!job.authAutomationAttempt?.requirements || !Object.hasOwn(job.authAutomationAttempt.requirements, field)) return;
  job.authAutomationAttempt.requirements[field] = true;
}

function markAuthorizationAutomatic(job, field) {
  if (!job.authAutomationAttempt?.automatic || !Object.hasOwn(job.authAutomationAttempt.automatic, field)) return;
  job.authAutomationAttempt.automatic[field] = true;
}

function markAuthorizationManual(job, field) {
  if (!job.authAutomationAttempt?.manual || !Object.hasOwn(job.authAutomationAttempt.manual, field)) return;
  job.authAutomationAttempt.manual[field] = true;
}

function completeAuthorizationAutomationAttempt(job) {
  const attempt = job.authAutomationAttempt;
  if (!attempt) return;
  const reasons = [];
  for (const [field, label] of [["password", "密码"], ["emailOtp", "邮箱验证码"], ["mfa", "登录 2FA 验证码"]]) {
    if (attempt.manual[field]) reasons.push(`${label}由用户手动输入`);
    else if (attempt.requirements[field] && !attempt.automatic[field]) reasons.push(`${label}未记录为自动完成`);
  }
  const hasAutomaticLoginSource = attempt.requirements.password
    || attempt.requirements.emailOtp
    || Boolean(job.password || job.mailApiUrl);
  if (!hasAutomaticLoginSource) reasons.push("没有可用于下次自动登录的密码或邮件收码接口");

  job.lastAuthAutomated = reasons.length === 0;
  job.lastAuthAutomationReason = reasons.length ? reasons.join("；") : "上次完整登录未需要人工输入密码、邮箱码或登录 2FA";
  job.lastAuthAutomatedAt = new Date().toISOString();
  job.lastAuthRequirements = { ...attempt.requirements };
  job.authAutomationAttempt = null;
  appendJobLog(job, job.lastAuthAutomated
    ? "[automation] 本次完整登录已记录为可自动修复。\n"
    : `[automation] 本次完整登录不可自动修复：${job.lastAuthAutomationReason}。\n`);
}

function clearAutoRepairBlock(job) {
  job.autoRepairBlocked = false;
  job.autoRepairBlockedReason = null;
  job.autoRepairBlockedAt = null;
}

function markAutoRepairBlocked(job, reason) {
  job.autoRepairBlocked = true;
  job.autoRepairBlockedReason = String(reason || "账号已被永久停用").slice(0, 500);
  job.autoRepairBlockedAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  job.autoRepairOperation = null;
  appendJobLog(job, "[monitor] 已确认账号被封禁、删除或永久停用，后续号池巡检将直接跳过。\n");
}

function isPermanentAccountFailure(message) {
  const text = String(message || "");
  return /(?:account|user)_(?:deactivated|deleted|suspended|disabled)|(?:your|this) account (?:has been|is) (?:deleted|deactivated|suspended|disabled)|account has been (?:deleted|deactivated|suspended|disabled)|deleted or deactivated|do not have an account because it has been deleted/i.test(text);
}

function requireStage(job, expected) {
  if (job.status !== expected) {
    throw httpError(409, `The flow is currently at ${job.status}, not ${expected}`);
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function getJobDurationMs(job, now = Date.now()) {
  if (job.status === "queued") return null;
  const startedAt = Date.parse(job.startedAt || "");
  if (!Number.isFinite(startedAt)) return null;
  const completedAt = Date.parse(job.completedAt || "");
  const end = isTerminalStatus(job.status)
    ? (completedAt >= startedAt ? completedAt : Date.parse(job.updatedAt || ""))
    : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - startedAt);
}

function recordJobOperation(job, type, at = new Date().toISOString()) {
  job.lastOperationAt = at;
  job.lastOperationType = type;
}

function sanitizeLog(text) {
  return String(text)
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|login_hint|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(access_token|refresh_token|id_token|password|totp_secret|2fa_key)\s*[=:]\s*[^\s,}]+/gi, "$1=<redacted>");
}

function isActive(status) {
  return !isTerminalStatus(status);
}

function occupiesActiveSlot(job) {
  return isActive(job.status) && job.status !== "queued";
}

function getQueuePosition(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()]
    .filter((item) => item.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))
    .findIndex((item) => item.id === job.id) + 1;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(status);
}

function uniqueByJson(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listUniqueJobs() {
  const seen = new Set();
  return [...jobs.values()].sort(sortNewestFirst).filter((job) => {
    const key = job.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findJobByEmail(email) {
  const key = String(email || "").toLowerCase();
  return listUniqueJobs().find((job) => job.email.toLowerCase() === key) || null;
}

async function withEmailJobLock(email, operation) {
  const key = String(email || "").trim().toLowerCase();
  const previous = emailJobLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  emailJobLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (emailJobLocks.get(key) === current) emailJobLocks.delete(key);
  }
}

function resolveSelectedJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, "请至少选择一条任务");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多操作 ${MAX_BATCH_JOBS} 条任务`);
  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  return selected;
}

async function deleteJobsByEmail(email) {
  const matching = [...jobs.values()].filter((job) => job.email.toLowerCase() === email);
  const directories = new Set();
  matching.forEach((job) => {
    job.deleted = true;
    stopMailPolling(job);
    releaseSmsNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
  await Promise.allSettled(matching.map((job) => job.metadataWritePromise).filter(Boolean));
  await Promise.all([
    ...[...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    deleteStoredLoginCredentials(email),
  ]);
  scheduleQueuedJobs();
}

function downloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function syncCompletedOutputs(force = false) {
  if (!force && Date.now() - lastOutputSyncAt < 2_000) return;
  if (outputSyncPromise) return outputSyncPromise;
  outputSyncPromise = (async () => {
    lastOutputSyncAt = Date.now();
    let entries = [];
    try {
      entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (jobs.has(entry.name)) return;
      const outputDir = path.join(OUTPUT_ROOT, entry.name);
      const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
      const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
      const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
      const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(path.join(outputDir, JOB_META_FILENAME), "utf8"));
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(outputPath, "utf8"), fs.stat(outputPath)]);
        const data = JSON.parse(raw);
        if (data.type !== "sub2api-data" || !Array.isArray(data.accounts) || !data.accounts.length) throw new Error("invalid output");
        const account = data.accounts[0];
        const email = metadata.email || account?.credentials?.email || account?.extra?.email || account?.name || `restored-${entry.name}`;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredOperation = restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery);
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredOperation.status,
          prompt: restoredOperation.prompt,
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || completedAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || completedAt,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: restoredOperation.log,
          lastError: restoredOperation.lastError,
          child: null,
          parserTail: "",
          resultSaved: true,
          planType: extractPlanTypeFromAccount(account) || normalizePlanType(metadata.plan_type),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          totpSetupError: restoredOperation.totpSetupError,
          passwordAddError: restoredOperation.passwordAddError,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: false,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
        return;
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(checkpointPath, "utf8"), fs.stat(checkpointPath)]);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.email !== "string" || !checkpoint.email) return;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const email = metadata.email || checkpoint.email;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredAt = stat.mtime.toISOString();
        const savedStatus = String(metadata.status || "");
        const restoredStatus = passwordRecovery.recovered || totpRecovery.recovered
          ? "resume_available"
          : isTerminalStatus(savedStatus) ? savedStatus : "resume_available";
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredStatus,
          prompt: totpRecovery.recovered
            ? "已恢复成功激活的 2FA 密钥，可以继续未完成的 Codex 授权"
            : passwordRecovery.recovered
              ? "已恢复成功添加的新密码，可以继续未完成的 Codex 授权"
            : metadata.prompt || (restoredStatus === "resume_available"
              ? "检测到邮箱登录检查点，可以继续手机号绑定"
              : "已恢复上次操作状态，登录检查点仍然保留"),
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: null,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: totpRecovery.recovered
            ? "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n"
            : passwordRecovery.recovered
              ? "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n"
            : `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: passwordRecovery.recovered || totpRecovery.recovered
            ? "ChatGPT 登录状态已保留，点击继续流程即可重新开始 Codex 授权"
            : metadata.last_error || (restoredStatus === "resume_available"
              ? "上次流程在生成授权文件前中断"
              : null),
          child: null,
          parserTail: "",
          resultSaved: false,
          planType: normalizePlanType(metadata.plan_type),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          totpSetupError: totpRecovery.error || null,
          passwordAddError: passwordRecovery.error || metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: true,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...restoredSmsState(metadata),
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        const missingStoredCredentials = restoredMissingCredentials(metadata, storedCredentials);
        const storedCredentialsMissing = missingStoredCredentials.length > 0;
        const savedStatus = String(metadata.status || "");
        const restartable = ["queued", "starting"].includes(savedStatus);
        const interrupted = Boolean(savedStatus) && !isTerminalStatus(savedStatus) && !restartable;
        const restoredStatus = storedCredentialsMissing && restartable
          ? "reauth_required"
          : restartable
            ? "queued"
            : interrupted || !savedStatus
              ? "failed"
              : savedStatus;
        const restoredPrompt = storedCredentialsMissing && restartable
          ? "登录资料需要重新确认"
          : restartable
            ? "服务重启后已恢复，等待任务槽位"
            : interrupted || !savedStatus
              ? "上次流程因服务重启中断，可以重新授权"
              : metadata.prompt || "已恢复上次任务状态";
        const restoredError = storedCredentialsMissing && restartable
          ? `请重新导入或填写${missingStoredCredentials.join("、")}后重试，任务不会使用缺失的资料自动登录`
          : interrupted || !savedStatus
            ? metadata.last_error || `上次 ${savedStatus || "未知"} 阶段未完成`
            : metadata.last_error || null;
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: restoredStatus,
          prompt: restoredPrompt,
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || null,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: storedCredentialsMissing && restartable
            ? `[restore] 系统安全凭据存储中无法恢复${missingStoredCredentials.join("、")}，已停止自动启动。\n`
            : restartable
              ? "[restore] 已恢复排队任务，等待可用任务槽位。\n"
              : interrupted || !savedStatus
                ? "[restore] 上次任务在生成授权文件前中断，已恢复为可重试状态。\n"
                : "[restore] 已恢复上次任务状态。\n",
          lastError: restoredError,
          child: null,
          parserTail: "",
          resultSaved: false,
          planType: normalizePlanType(metadata.plan_type),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "baseline" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || null,
          phoneError: null,
          restartRequired: restoredStatus === "reauth_required",
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          queuedMode: restoredStatus === "queued" && metadata.queued_mode === "refresh" ? "refresh" : "full",
          queuedAt: restoredStatus === "queued" ? metadata.queued_at || restoredAt : null,
          queuedStartPrompt: metadata.queued_mode === "refresh"
            ? "正在使用已有刷新令牌直接生成新授权"
            : "正在建立登录会话",
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          passwordAddError: metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: Boolean(metadata.login_checkpoint_available),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

async function recoverActivatedTotpCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null };
    return { credentials, recovered: false, error: `2FA 结果文件无法读取：${error.message}` };
  }
  if (result?.activation_succeeded !== true || !result?.secret) {
    return { credentials, recovered: false, error: null };
  }
  try {
    const secret = normalizeTotpSecret(result.secret);
    const nextCredentials = { ...credentials, totpSecret: secret };
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留",
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `2FA 已激活，但密钥恢复失败：${error.message}；结果文件已保留`,
    };
  }
}

async function recoverAddedPasswordCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null, addedAt: null };
    return { credentials, recovered: false, error: `添加密码结果文件无法读取：${error.message}`, addedAt: null };
  }
  if (
    result?.version !== 1
    || String(result.email || "").toLowerCase() !== email.toLowerCase()
    || typeof result.password !== "string"
    || result.password.length < 12
  ) {
    return { credentials, recovered: false, error: "添加密码结果文件格式不正确", addedAt: null };
  }
  const nextCredentials = { ...credentials, password: result.password };
  try {
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "密码已经添加，但当前系统不支持持久凭据存储；结果文件已保留",
        addedAt: result.added_at || null,
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null, addedAt: result.added_at || null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `密码已经添加，但新密码恢复失败：${error.message}；结果文件已保留`,
      addedAt: result.added_at || null,
    };
  }
}

function restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery) {
  const savedStatus = String(metadata.status || "");
  const interrupted = savedStatus && !isTerminalStatus(savedStatus);
  const status = !savedStatus || savedStatus === "completed"
    ? "completed"
    : interrupted ? "failed" : savedStatus;
  if (passwordRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功添加的新密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n",
    };
  }
  if (passwordRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，新密码需要重试恢复",
      lastError: null,
      totpSetupError: null,
      passwordAddError: passwordRecovery.error,
      log: `[restore] ${passwordRecovery.error}\n`,
    };
  }
  if (savedStatus.startsWith("password_add") || metadata.queued_mode === "password_add") {
    return {
      status: "completed",
      prompt: "服务重启中断了添加密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: "添加密码尚未完成，请重新点击添加密码",
      log: "[restore] 添加密码被服务重启中断，旧授权文件未受影响。\n",
    };
  }
  if (totpRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n",
    };
  }
  if (totpRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，2FA 密钥需要重试恢复",
      lastError: metadata.last_error || null,
      totpSetupError: totpRecovery.error,
      passwordAddError: null,
      log: `[restore] ${totpRecovery.error}\n`,
    };
  }
  if (interrupted) {
    return {
      status,
      prompt: "上次操作因服务重启中断，旧授权文件仍可下载",
      lastError: metadata.last_error || `上次 ${savedStatus} 阶段未完成`,
      totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
      passwordAddError: savedStatus.startsWith("password_add") ? "服务重启时添加密码未完成，请重新发起" : null,
      log: "[restore] 检测到旧授权文件，同时保留了上次中断的操作状态。\n",
    };
  }
  return {
    status,
    prompt: metadata.prompt || (status === "completed"
      ? "已从本地输出目录恢复，可以下载导入文件"
      : "旧授权文件仍可下载，已恢复最近一次操作状态"),
    lastError: metadata.last_error || null,
    totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
    passwordAddError: metadata.password_add_error || null,
    log: `[restore] 已恢复任务状态，旧授权文件时间 ${completedAt}。\n`,
  };
}

function isEmail(value) {
  const text = String(value || "");
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.lastIndexOf("@");
  if (at <= 0 || at !== text.indexOf("@")) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    !label
    || label.length > 63
    || label.startsWith("-")
    || label.endsWith("-")
    || !/^[A-Z0-9-]+$/i.test(label)
  ))) return false;
  const topLevelDomain = labels.at(-1);
  if (!/^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i.test(topLevelDomain)) return false;
  return true;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw httpError(400, "账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailRequestBody = typeof value.mailRequestBody === "string" ? value.mailRequestBody : "";
  const configuredPostUrl = mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : null;
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl)
    ? String(value.mailApiUrl).trim()
    : mailRequestBody && configuredPostUrl
      ? configuredPostUrl
      : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl, mailRequestBody, password, totpSecret };
}

function restoredCredentialFlags(metadata = {}, credentials = {}) {
  const hasExplicitPasswordFlag = Object.hasOwn(metadata, "has_password");
  const hasExplicitTotpFlag = Object.hasOwn(metadata, "has_totp_key");
  return {
    hasPasswordCredential: Boolean(
      credentials.password
      || (hasExplicitPasswordFlag ? metadata.has_password : metadata.login_mode === "password" && metadata.has_stored_credentials),
    ),
    hasTotpCredential: Boolean(
      credentials.totpSecret
      || (hasExplicitTotpFlag ? metadata.has_totp_key : metadata.has_stored_credentials),
    ),
  };
}

function restoredTotpSetupState(metadata = {}, credentials = {}) {
  return {
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpSetupReplaceExisting: Boolean(metadata.totp_setup_replace_existing),
    totpRotationRemoteDisabled: Boolean(metadata.totp_rotation_remote_disabled),
    totpRotationStage: typeof metadata.totp_rotation_stage === "string" ? metadata.totp_rotation_stage : null,
    totpRotationIncomplete: Boolean(metadata.totp_rotation_incomplete || metadata.totp_rotation_remote_disabled),
    totpKnownEnabled: Boolean(
      metadata.totp_known_enabled
      || (credentials.totpSecret && !metadata.totp_rotation_remote_disabled),
    ),
    totpSetupAttempt: 0,
    totpResultLoading: false,
  };
}

function restoredProxyRiskState(metadata = {}) {
  const count = Number(metadata.proxy_risk_retry_count || 0);
  const connectionFailures = Number(metadata.proxy_connection_failure_count || 0);
  return {
    proxyRiskRetryCount: Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_PROXY_RISK_RETRIES) : 0,
    proxyConnectionFailureCount: Number.isInteger(connectionFailures) && connectionFailures >= 0
      ? Math.min(connectionFailures, MAX_PROXY_CONNECTION_FAILURES)
      : 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
  };
}

function restoredAutoRepairState(metadata = {}) {
  const requirements = metadata.last_auth_requirements;
  const pendingIds = Array.isArray(metadata.auto_repair_pending_account_ids)
    ? metadata.auto_repair_pending_account_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  return {
    lastAuthAutomated: metadata.last_auth_automated === true,
    lastAuthAutomationReason: String(metadata.last_auth_automation_reason || "旧任务没有自动化参与记录"),
    lastAuthAutomatedAt: metadata.last_auth_automated_at || null,
    lastAuthRequirements: requirements && typeof requirements === "object"
      ? {
          password: Boolean(requirements.password),
          emailOtp: Boolean(requirements.emailOtp),
          mfa: Boolean(requirements.mfa),
        }
      : null,
    authAutomationAttempt: null,
    autoRepairBlocked: metadata.auto_repair_blocked === true,
    autoRepairBlockedReason: metadata.auto_repair_blocked_reason || null,
    autoRepairBlockedAt: metadata.auto_repair_blocked_at || null,
    autoRepairLastAttemptAt: metadata.auto_repair_last_attempt_at || null,
    autoRepairLastSuccessAt: metadata.auto_repair_last_success_at || null,
    autoRepairLastError: metadata.auto_repair_last_error || null,
    autoRepairPendingAccountIds: [...new Set(pendingIds)],
    autoRepairPendingBackend: metadata.auto_repair_pending_backend || null,
    autoRepairOperation: null,
  };
}

function restoredMissingCredentials(metadata = {}, credentials = {}) {
  const missing = [];
  const passwordRequired = Object.hasOwn(metadata, "has_password")
    ? metadata.has_password
    : metadata.login_mode === "password" && metadata.has_stored_credentials;
  const totpRequired = Object.hasOwn(metadata, "has_totp_key")
    ? metadata.has_totp_key
    : metadata.has_stored_credentials && !passwordRequired;
  if (passwordRequired && !credentials.password) missing.push("密码");
  if (totpRequired && !credentials.totpSecret) missing.push("2FA 密钥");
  if (metadata.proxy_configured && !credentials.proxyUrl) missing.push("代理 IP");
  return missing;
}

function normalizeTotpSecret(value, lineNumber = null) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    const prefix = lineNumber ? `第 ${lineNumber} 行` : "";
    throw httpError(400, `${prefix}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7`);
  }
  return normalized;
}

function parseBatchEntries(value, requestConfig = {}) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw httpError(400, "请至少输入一行账号信息");
  if (lines.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);

  const entries = lines.map((line, index) => (
    requestConfig.method === "POST" && !isEmail(line)
      ? parsePostMailAccountLine(line, index + 1, requestConfig)
      : parseSmartAccountLine(line, index + 1)
  ));

  const unique = new Map();
  entries.forEach((entry) => unique.set(entry.email.toLowerCase(), entry));
  return [...unique.values()];
}

function parsePostMailAccountLine(line, lineNumber, requestConfig) {
  if (!validateMailApiUrl(requestConfig.url)) {
    throw httpError(400, "POST 邮件接码模式需要先在控制台配置统一请求 URL");
  }
  const fields = line.split("----").map((value) => value.trim());
  if (fields.length < 2) {
    throw httpError(400, `第 ${lineNumber} 行格式错误，POST 邮件接码请使用 邮箱----编码请求体`);
  }
  const emailFields = fields.map((value, index) => ({ value, index })).filter((field) => isEmail(field.value));
  if (emailFields.length !== 1) throw httpError(400, `第 ${lineNumber} 行必须包含一个独立邮箱`);
  const emailField = emailFields[0];
  const remaining = fields
    .map((value, index) => ({ value, index }))
    .filter((field) => field.index !== emailField.index && field.value);
  if (!remaining.length) throw httpError(400, `第 ${lineNumber} 行缺少 POST 请求体`);

  let totpField = null;
  if (remaining.length >= 2) {
    const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
    if (totpCandidates.length === 1) totpField = totpCandidates[0];
  }
  const bodyAndPassword = remaining.filter((field) => field !== totpField);
  const recognizableBodies = bodyAndPassword.filter((field) => looksLikeEncodedMailRequestBody(field.value));
  const bodyField = recognizableBodies.length === 1 ? recognizableBodies[0] : bodyAndPassword.at(-1);
  const passwordFields = bodyAndPassword.filter((field) => field !== bodyField);
  if (passwordFields.length > 1) {
    throw httpError(400, `第 ${lineNumber} 行无法区分密码和 POST 请求体，请将编码请求体放在最后`);
  }
  const mailRequestBody = bodyField?.value || "";
  const password = passwordFields[0]?.value || "";
  if (Buffer.byteLength(mailRequestBody) > MAX_MAIL_REQUEST_BODY_BYTES) {
    throw httpError(400, `第 ${lineNumber} 行 POST 请求体不能超过 64 KB`);
  }
  return {
    email: emailField.value,
    loginMode: password ? "password" : "email_otp",
    mailApiUrl: requestConfig.url,
    mailRequestBody,
    password,
    totpSecret: totpField ? normalizeTotpSecret(totpField.value, lineNumber) : "",
  };
}

function looksLikeEncodedMailRequestBody(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^[{\[]/.test(text)) {
    try {
      JSON.parse(text);
      return true;
    } catch {}
  }
  if (/(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(text) || /%[0-9A-F]{2}/i.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.length >= 12) {
    try {
      const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
      return /^[{\[]/.test(decoded) || /(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(decoded);
    } catch {}
  }
  return false;
}

function parseSmartAccountLine(line, lineNumber) {
  if (isEmail(line)) {
    return {
      email: line,
      loginMode: "email_otp",
      mailApiUrl: null,
      password: "",
      totpSecret: "",
      preserveExistingCredentials: true,
    };
  }

  const parsed = accountDelimiterCandidates(line)
    .map((delimiter) => parseAccountLineWithDelimiter(line, delimiter, lineNumber))
    .filter(Boolean);
  const ambiguity = parsed.find((candidate) => candidate.ambiguity);
  if (ambiguity) throw httpError(400, `第 ${lineNumber} 行${ambiguity.ambiguity}`);

  const candidates = parsed
    .sort(compareAccountParseCandidates);
  if (!candidates.length) {
    const unsupportedHyphenRun = [...line.matchAll(/-+/g)].find((match) => (
      match[0].length === 5 || match[0].length > 8
    ));
    if (unsupportedHyphenRun) {
      throw httpError(400, `第 ${lineNumber} 行存在 ${unsupportedHyphenRun[0].length} 个连续短横线，无法确定是分隔符还是字段内容，请改用 | 或 Tab 分隔`);
    }
    throw httpError(400, `第 ${lineNumber} 行无法识别出独立邮箱和账号字段`);
  }
  const best = candidates[0];
  const conflicting = candidates.find((candidate) => (
    candidate.recognizedCount === best.recognizedCount
    && accountParseSignature(candidate) !== accountParseSignature(best)
  ));
  if (conflicting) {
    throw httpError(400, `第 ${lineNumber} 行存在多种可能的字段分隔方式，请改用 ---- 明确分隔`);
  }
  if (passwordContainsStructuredField(best.entry.password)) {
    throw httpError(400, `第 ${lineNumber} 行似乎混用了多种分隔符，密码中又识别到 URL 或 2FA 密钥，请统一改用 ---- 分隔`);
  }
  return best.entry;
}

function accountDelimiterCandidates(line) {
  const candidates = [
    { id: "hyphen-4", split: (value) => splitHyphenDelimitedLine(value, 4), priority: 110 },
    { id: "hyphen-3", split: (value) => splitHyphenDelimitedLine(value, 3), priority: 105 },
    { id: "hyphen-mixed", split: (value) => splitMixedHyphenDelimitedLine(value), priority: 100 },
    { id: "tab", pattern: /\t+/g, priority: 80 },
    { id: "pipe", pattern: /\|+/g, priority: 70 },
    { id: "double-colon", pattern: /:{2,}/g, priority: 65 },
    { id: "semicolon", pattern: /[;；]+/g, priority: 60 },
    { id: "comma", pattern: /[,，]+/g, priority: 55 },
    { id: "spaces", pattern: / {2,}/g, priority: 40 },
  ];
  const repeated = line.match(/([#~^*])\1+/g) || [];
  for (const delimiter of new Set(repeated)) {
    candidates.push({
      id: `repeated-${delimiter[0].codePointAt(0)}`,
      pattern: new RegExp(escapeRegExp(delimiter), "g"),
      priority: 35 + delimiter.length,
    });
  }
  return candidates;
}

function parseAccountLineWithDelimiter(line, delimiter, lineNumber) {
  const split = delimiter.split ? delimiter.split(line) : splitPreservingDelimiters(line, delimiter.pattern);
  if (split.separators.length === 0) return null;
  if (split.segments.length > 64) return null;
  const fields = split.segments.map((raw, index) => ({ raw, value: raw.trim(), index, type: "plain" }));
  if (fields.filter((field) => isEmail(field.value)).length > 1) {
    return { ambiguity: "中识别到多个完整邮箱，无法确定哪个是账号" };
  }
  const emailRange = findLongestEmailRange(split);
  if (!emailRange) return null;
  for (let index = emailRange.start; index <= emailRange.end; index += 1) fields[index].type = "email";

  const urls = fields.filter((field) => field.type === "plain" && validateMailApiUrl(field.value));
  if (urls.length > 1) return null;
  if (["comma", "semicolon"].includes(delimiter.id) && urls.some((field) => (
    adjacentPlainFieldCanExtendUrl(fields, split, field)
  ))) {
    return { ambiguity: "中的 URL 可能包含逗号或分号，请改用 ---- 分隔字段" };
  }
  for (const field of urls) field.type = "mail_api";

  const remaining = fields.filter((field) => field.type === "plain" && field.value);
  const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
  const emptyFieldPresent = fields.some((field) => !field.value);
  let totp = null;
  let totpValue = "";
  if (totpCandidates.length === 1) {
    const candidate = totpCandidates[0];
    const otherPlain = remaining.filter((field) => field !== candidate);
    const followsMailApi = urls.some((field) => field.index < candidate.index);
    if (otherPlain.length > 0 || followsMailApi || emptyFieldPresent) {
      totp = candidate;
      totp.type = "totp";
      totpValue = totp.value;
    }
  } else if (totpCandidates.length > 1) {
    const conventionalPasswordTotp = delimiter.id.startsWith("hyphen-")
      && split.separators.length === 2
      && fields.length === 3
      && emailRange.start === 0
      && emailRange.end === 0
      && urls.length === 0
      && totpCandidates.length === 2
      && totpCandidates[0].index === 1
      && totpCandidates[1].index === 2;
    if (!conventionalPasswordTotp) return null;
    // A 16-character password can also look like Base32; in email----password----2FA, the final field is 2FA.
    totp = totpCandidates[1];
    totp.type = "totp";
    totpValue = totp.value;
  }
  if (!totp && delimiter.id === "spaces") {
    const groupedTotp = findGroupedTotpCandidate(fields, split);
    if (groupedTotp) {
      const outsidePlain = remaining.filter((field) => (
        field.index < groupedTotp.start || field.index > groupedTotp.end
      ));
      if (outsidePlain.length > 0 || urls.length > 0 || emptyFieldPresent) {
        for (let index = groupedTotp.start; index <= groupedTotp.end; index += 1) fields[index].type = "totp";
        totp = fields[groupedTotp.start];
        totpValue = groupedTotp.value;
      }
    }
  }

  const passwordFields = fields.filter((field) => field.type === "plain" && field.value);
  if (passwordFields.length && !indexesAreContiguous(passwordFields.map((field) => field.index))) return null;
  const password = passwordFields.length
    ? reconstructSegmentRange(split, passwordFields[0].index, passwordFields.at(-1).index).trim()
    : "";
  if (!password && !urls.length && !totp) return null;

  const recognizedCount = 1 + urls.length + Number(Boolean(totp));
  const score = recognizedCount * 1_000
    + Number(Boolean(password)) * 100
    + delimiter.priority
    - Math.max(0, split.separators.length - 3);
  return {
    score,
    recognizedCount,
    delimiter: delimiter.id,
    entry: {
      email: emailRange.value,
      loginMode: password ? "password" : "email_otp",
      mailApiUrl: urls[0]?.value || null,
      password,
      totpSecret: totp ? normalizeTotpSecret(totpValue, lineNumber) : "",
    },
  };
}

function splitHyphenDelimitedLine(line, width) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    if (match[0].length === width) return [{ index: match.index, value: match[0] }];
    if (match[0].length === width * 2) {
      return [
        { index: match.index, value: "-".repeat(width) },
        { index: match.index + width, value: "-".repeat(width) },
      ];
    }
    return [];
  }));
}

function splitMixedHyphenDelimitedLine(line) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    const length = match[0].length;
    if (length === 3 || length === 4) return [{ index: match.index, value: match[0] }];
    if (length >= 6 && length <= 8) {
      const firstLength = length === 6 ? 3 : 4;
      return [
        { index: match.index, value: "-".repeat(firstLength) },
        { index: match.index + firstLength, value: "-".repeat(length - firstLength) },
      ];
    }
    return [];
  }));
}

function splitWithSelectedMatches(line, matches) {
  const segments = [];
  const separators = [];
  let cursor = 0;
  for (const match of matches) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match.value);
    cursor = match.index + match.value.length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function splitPreservingDelimiters(line, pattern) {
  const segments = [];
  const separators = [];
  pattern.lastIndex = 0;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match[0]);
    cursor = match.index + match[0].length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function reconstructSegmentRange(split, start, end) {
  let result = split.segments[start];
  for (let index = start; index < end; index += 1) {
    result += split.separators[index] + split.segments[index + 1];
  }
  return result;
}

function findLongestEmailRange(split) {
  const candidates = [];
  for (let start = 0; start < split.segments.length; start += 1) {
    for (let end = start; end < split.segments.length; end += 1) {
      const value = reconstructSegmentRange(split, start, end).trim();
      const atCount = (value.match(/@/g) || []).length;
      if (atCount > 1) break;
      if (atCount === 1 && isEmail(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  const leadingCandidates = candidates.filter((candidate) => candidate.start === 0);
  const standaloneCandidates = candidates.filter((candidate) => candidate.start === candidate.end);
  // A complete segment is a stronger signal than a longer range. Otherwise a
  // dotted password can be appended to a valid email and still look like a
  // valid domain (for example, email----r7.UjRUWVVS).
  const preferred = standaloneCandidates.length ? standaloneCandidates : leadingCandidates;
  if (!preferred.length) return null;
  preferred.sort((left, right) => (
    right.value.length - left.value.length
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
  ));
  const best = preferred[0];
  const conflicting = preferred.find((candidate) => (
    candidate.value.length === best.value.length && candidate.value.toLowerCase() !== best.value.toLowerCase()
  ));
  return conflicting ? null : best;
}

function adjacentPlainFieldCanExtendUrl(fields, split, urlField) {
  for (const adjacentIndex of [urlField.index - 1, urlField.index + 1]) {
    const adjacent = fields[adjacentIndex];
    if (!adjacent || adjacent.type !== "plain" || !adjacent.value) continue;
    const start = Math.min(urlField.index, adjacentIndex);
    const end = Math.max(urlField.index, adjacentIndex);
    if (validateMailApiUrl(reconstructSegmentRange(split, start, end).trim())) return true;
  }
  return false;
}

function findGroupedTotpCandidate(fields, split) {
  const candidates = [];
  for (let start = 0; start < fields.length; start += 1) {
    if (fields[start].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[start].value)) continue;
    for (let end = start + 1; end < fields.length; end += 1) {
      if (fields[end].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[end].value)) break;
      const value = reconstructSegmentRange(split, start, end);
      if (isTotpSecretCandidate(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start));
  const best = candidates[0];
  return candidates.some((candidate) => (
    candidate !== best
    && candidate.end - candidate.start === best.end - best.start
    && (candidate.start !== best.start || candidate.end !== best.end)
  )) ? null : best;
}

function isTotpSecretCandidate(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized);
}

function passwordContainsStructuredField(password) {
  const text = String(password || "");
  if (!text) return false;
  const patterns = [/-{3,4}/g, /\|+/g, /:{2,}/g, /[;；]+/g, /[,，]+/g, / {2,}/g];
  return patterns.some((pattern) => {
    const split = splitPreservingDelimiters(text, pattern);
    return split.separators.length > 0 && split.segments.some((segment) => (
      validateMailApiUrl(segment.trim()) || isTotpSecretCandidate(segment.trim())
    ));
  });
}

function indexesAreContiguous(indexes) {
  return indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
}

function compareAccountParseCandidates(left, right) {
  return right.score - left.score || left.delimiter.localeCompare(right.delimiter);
}

function accountParseSignature(candidate) {
  const { email, mailApiUrl, mailRequestBody, password, totpSecret } = candidate.entry;
  return JSON.stringify({ email: email.toLowerCase(), mailApiUrl, mailRequestBody, password, totpSecret });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function updateJobCredentials(job, credentials, options = {}) {
  if (credentials.preserveExistingCredentials) await reloadMissingJobCredentials(job);
  const normalized = credentials.preserveExistingCredentials
    ? normalizeLoginCredentials({
        password: job.password,
        mailApiUrl: job.mailApiUrl,
        mailRequestBody: job.mailRequestBody,
        totpSecret: job.totpSecret,
      })
    : normalizeLoginCredentials(credentials);
  const nextProxyUrl = options.hasProxyUpdate ? normalizeProxyUrl(options.proxyUrl) : job.proxyUrl;
  const changed = job.loginMode !== normalized.loginMode
    || job.mailApiUrl !== normalized.mailApiUrl
    || job.mailRequestBody !== normalized.mailRequestBody
    || job.password !== normalized.password
    || job.totpSecret !== normalized.totpSecret
    || job.proxyUrl !== nextProxyUrl;
  await saveStoredLoginCredentials(job.email, { ...normalized, proxyUrl: nextProxyUrl });
  if (!changed) return;
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.mailRequestBody = normalized.mailRequestBody;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  job.proxyUrl = nextProxyUrl;
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = job.mailApiUrl ? "baseline" : "manual";
  job.mailApiError = null;
  recordJobOperation(job, "account_update");
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function canReplaceTotp(job) {
  if (isActive(job.status)) return false;
  if ((job.totpRotationIncomplete || job.totpRotationRemoteDisabled) && job.resultSaved) return true;
  if (!(job.status === "completed" && job.resultSaved)) return false;
  return Boolean(job.totpKnownEnabled || job.totpSecret || job.hasTotpCredential);
}

async function updateStoredCredentialFields(job, body = {}) {
  if (isActive(job.status)) throw httpError(409, "任务正在运行，请等待完成后再修改凭据");
  const hasPassword = Object.hasOwn(body, "password");
  const hasTotpSecret = Object.hasOwn(body, "totpSecret");
  if (!hasPassword && !hasTotpSecret) throw httpError(400, "至少需要提供 password 或 totpSecret");

  await reloadMissingJobCredentials(job);
  if (!hasPassword && job.hasPasswordCredential && !job.password) {
    throw httpError(409, "现有密码无法从系统凭据存储读取，请同时提交密码后再修改其他字段");
  }
  if (!hasTotpSecret && job.hasTotpCredential && !job.totpSecret) {
    throw httpError(409, "现有 2FA 密钥无法从系统凭据存储读取，请同时提交 2FA 密钥后再修改其他字段");
  }
  const password = hasPassword ? String(body.password ?? "") : job.password || "";
  const totpSecret = hasTotpSecret ? normalizeTotpSecret(body.totpSecret) : job.totpSecret || "";
  if (password.length > 128) throw httpError(400, "密码长度不能超过 128 个字符");
  if (hasTotpSecret && !/^[A-Z2-7]{16,128}$/.test(totpSecret)) {
    throw httpError(400, "2FA 密钥必须是 16 到 128 位 Base32 字符");
  }

  const persisted = await saveStoredLoginCredentials(job.email, {
    password: hasPassword ? password : job.password,
    totpSecret: hasTotpSecret ? totpSecret : job.totpSecret,
    proxyUrl: job.proxyUrl,
  });
  if (hasPassword) {
    job.password = password;
    job.hasPasswordCredential = Boolean(password);
    job.loginMode = password ? "password" : (job.mailApiUrl ? "email_otp" : "manual");
  }
  if (hasTotpSecret) {
    job.totpSecret = totpSecret;
    job.hasTotpCredential = Boolean(totpSecret);
    if (totpSecret) job.totpKnownEnabled = true;
  }
  recordJobOperation(job, "credential_update");
  appendJobLog(job, "[account] 登录凭据已更新，敏感字段未写入日志。\n");
  touch(job);
  await saveJobMetadata(job);
  return persisted;
}

async function updateJobProxy(job, proxyUrl) {
  if (job.proxyUrl === proxyUrl) return;
  job.proxyUrl = proxyUrl;
  await saveStoredLoginCredentials(job.email, job);
  recordJobOperation(job, "proxy_update");
  appendJobLog(job, "[proxy] 账号代理配置已更新。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function restartJobAfterConfigurationUpdate(job) {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  beginAuthorizationAutomationAttempt(job, "configuration_update");
  appendJobLog(job, "[account] 已停止使用旧配置的登录进程，并使用新配置重新排队。\n");
  enqueueJob(job, "full", "账号资料已更新，正在重新建立登录会话");
}

async function saveJobMetadata(job) {
  if (job.deleted) return;
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (job.deleted) return;
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        status: job.status,
        prompt: job.prompt || null,
        last_error: job.lastError || null,
        result_saved: Boolean(job.resultSaved),
        plan_type: job.planType || null,
        workspace_plan_type: job.workspacePlanType || null,
        completed_at: job.completedAt || null,
        started_at: job.startedAt || null,
        attempt: Number(job.attempt || 1),
        security_check_required: Boolean(job.securityCheckRequired),
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        last_operation_at: job.lastOperationAt || job.createdAt,
        last_operation_type: job.lastOperationType || "initial_authorization",
        login_mode: job.loginMode || null,
        mail_api_url: job.mailApiUrl || null,
        mail_request_body: job.mailRequestBody || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: Boolean(job.totpSecret || job.hasTotpCredential),
        totp_known_enabled: Boolean(
          !job.totpRotationRemoteDisabled && (job.totpKnownEnabled || job.totpSecret || job.hasTotpCredential),
        ),
        totp_setup_replace_existing: Boolean(job.totpSetupReplaceExisting),
        totp_rotation_remote_disabled: Boolean(job.totpRotationRemoteDisabled),
        totp_rotation_stage: job.totpRotationStage || null,
        totp_rotation_incomplete: Boolean(job.totpRotationIncomplete),
        password_add_error: job.passwordAddError || null,
        password_added_at: job.passwordAddedAt || null,
        login_checkpoint_available: Boolean(job.loginCheckpointAvailable),
        proxy_risk_retry_count: Number(job.proxyRiskRetryCount || 0),
        proxy_connection_failure_count: Number(job.proxyConnectionFailureCount || 0),
        proxy_configured: Boolean(job.proxyUrl),
        sms_provider_id: job.smsProviderId || null,
        sms_provider_name: job.smsProviderName || null,
        sms_service_label: job.smsServiceLabel || null,
        sms_order_id: job.smsOrderId || null,
        sms_number: job.smsNumber || null,
        sms_status: job.smsStatus || null,
        last_auth_automated: Boolean(job.lastAuthAutomated),
        last_auth_automation_reason: job.lastAuthAutomationReason || null,
        last_auth_automated_at: job.lastAuthAutomatedAt || null,
        last_auth_requirements: job.lastAuthRequirements || null,
        auto_repair_blocked: Boolean(job.autoRepairBlocked),
        auto_repair_blocked_reason: job.autoRepairBlockedReason || null,
        auto_repair_blocked_at: job.autoRepairBlockedAt || null,
        auto_repair_last_attempt_at: job.autoRepairLastAttemptAt || null,
        auto_repair_last_success_at: job.autoRepairLastSuccessAt || null,
        auto_repair_last_error: job.autoRepairLastError || null,
        auto_repair_pending_account_ids: job.autoRepairPendingAccountIds || [],
        auto_repair_pending_backend: job.autoRepairPendingBackend || null,
        updated_at: new Date().toISOString(),
      };
      const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, metadataPath);
    });
  return job.metadataWritePromise;
}

async function saveStoredLoginCredentials(email, credentials = {}) {
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const totpSecret = credentials.totpSecret ? normalizeTotpSecret(credentials.totpSecret) : "";
  const proxyUrl = credentials.proxyUrl ? normalizeProxyUrl(credentials.proxyUrl) : "";
  if (!password && !totpSecret && !proxyUrl) {
    await deleteStoredLoginCredentials(email);
    return true;
  }
  try {
    await credentialStore.save(email, { password, totpSecret, proxyUrl });
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
  return true;
}

async function loadStoredLoginCredentials(email) {
  try {
    const data = await credentialStore.load(email);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
      proxyUrl: data.proxyUrl ? normalizeProxyUrl(data.proxyUrl) : null,
    };
  } catch {
    return { password: "", totpSecret: "", proxyUrl: null };
  }
}

async function deleteStoredLoginCredentials(email) {
  await credentialStore.delete(email);
}

async function loadMailboxBaseline(job) {
  try {
    const candidates = await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
      request: mailRequestForJob(job),
    });
    candidates.forEach((candidate) => job.mailSeenCandidateKeys.add(candidate.key));
    job.mailStatus = "ready";
    job.mailApiError = null;
    appendJobLog(job, `[mail] 已记录收码接口中的 ${candidates.length} 个旧邮件验证码标识，等待新邮件。\n`);
  } catch (error) {
    job.mailStatus = "error";
    job.mailApiError = safeMailError(error);
    appendJobLog(job, `[mail] 首次读取收码接口失败：${job.mailApiError}\n`);
  }
  touch(job);
}

async function beginMailPolling(job) {
  if (!mailApiUrlForJob(job) || job.mailPollRunning || job.status !== "email_otp") return;
  job.mailPollRunning = true;
  job.mailStatus = "polling";
  job.mailApiError = null;
  const pollToken = crypto.randomUUID();
  const startedAt = Date.now();
  job.mailPollToken = pollToken;
  touch(job);

  try {
    while (
      job.mailPollToken === pollToken &&
      job.status === "email_otp" &&
      job.child &&
      Date.now() - startedAt < MAIL_POLL_TIMEOUT_MS
    ) {
      try {
        const candidates = filterMailboxOtpCandidatesByRequestTime(
          await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
            request: mailRequestForJob(job),
          }),
          job.mailOtpRequestedAt,
        );
        if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return;
        const unseen = candidates.filter((candidate) => !job.mailSeenCandidateKeys.has(candidate.key));
        let fresh = unseen.find((candidate) => candidate.score >= 12);
        if (!fresh) {
          unseen.forEach((candidate) => {
            job.mailCandidateCounts.set(candidate.key, (job.mailCandidateCounts.get(candidate.key) || 0) + 1);
          });
          fresh = unseen.find((candidate) => (job.mailCandidateCounts.get(candidate.key) || 0) >= 2);
        }
        job.mailApiError = null;
        if (fresh) {
          job.mailSeenCandidateKeys.add(fresh.key);
          job.mailCandidateCounts.delete(fresh.key);
          job.mailStatus = "found";
          markAuthorizationRequirement(job, "emailOtp");
          markAuthorizationAutomatic(job, "emailOtp");
          job.parserTail = "";
          appendJobLog(job, "[mail] 已从收码接口自动取得新验证码并提交。\n");
          setStage(job, "working", "已自动获取邮箱验证码，正在验证");
          job.child.stdin.write(`${fresh.code}\n`);
          return;
        }
      } catch (error) {
        if (job.mailPollToken !== pollToken) return;
        job.mailStatus = "error";
        job.mailApiError = safeMailError(error);
        touch(job);
      }
      await delay(MAIL_POLL_INTERVAL_MS);
    }

    if (job.mailPollToken === pollToken && job.status === "email_otp") {
      job.mailStatus = "timeout";
      job.mailApiError = "自动收码等待超时，请手动输入或重新发送";
      job.prompt = "自动收码等待超时，请手动输入邮箱验证码";
      touch(job);
    }
  } finally {
    if (job.mailPollToken === pollToken) {
      job.mailPollRunning = false;
      job.mailPollToken = null;
      touch(job);
    }
  }
}

function stopMailPolling(job) {
  if (!job.mailApiUrl) return;
  job.mailPollToken = null;
  job.mailPollRunning = false;
  if (job.mailStatus === "polling") job.mailStatus = "stopped";
}

function appendJobLog(job, text) {
  job.logs = `${job.logs}${sanitizeLog(text)}`.slice(-MAX_LOG_CHARS);
}

function safeMailError(error) {
  const message = String(error?.message || "读取收码接口失败");
  return message.replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>").slice(0, 180);
}

function normalizeMailRequestConfig(value) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const method = String(config.method || "GET").trim().toUpperCase();
  if (!["GET", "POST"].includes(method)) throw httpError(400, "邮件接码请求方式只支持 GET 或 POST");

  const sourceHeaders = config.headers == null ? {} : config.headers;
  if (!sourceHeaders || typeof sourceHeaders !== "object" || Array.isArray(sourceHeaders)) {
    throw httpError(400, "邮件接码请求头必须是 JSON 对象");
  }
  const entries = Object.entries(sourceHeaders);
  if (entries.length > MAX_MAIL_REQUEST_HEADERS) {
    throw httpError(400, `邮件接码请求头最多配置 ${MAX_MAIL_REQUEST_HEADERS} 项`);
  }
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw httpError(400, `无效的请求头名称：${rawName}`);
    if (FORBIDDEN_MAIL_REQUEST_HEADERS.has(name)) throw httpError(400, `请求头 ${rawName} 由请求库自动管理，不能手动配置`);
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw httpError(400, `请求头 ${rawName} 的值必须是文本或数字`);
    }
    const headerValue = String(rawValue);
    if (/\r|\n/.test(headerValue)) throw httpError(400, `请求头 ${rawName} 不能包含换行符`);
    if (Buffer.byteLength(headerValue) > 8 * 1024) throw httpError(400, `请求头 ${rawName} 的值过长`);
    headers[name] = headerValue;
  }

  const url = String(config.url || "").trim();
  if (method === "POST" && !validateMailApiUrl(url)) {
    throw httpError(400, "POST 邮件接码模式必须配置有效的 HTTP 或 HTTPS 请求 URL");
  }
  return { method, url: validateMailApiUrl(url) ? url : null, headers };
}

function mailRequestForJob(job) {
  return {
    method: mailRequestConfig.method,
    headers: mailRequestConfig.headers,
    body: mailRequestConfig.method === "POST" ? job.mailRequestBody || "" : "",
  };
}

function mailApiUrlForJob(job) {
  return mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : job.mailApiUrl;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, "Request body is too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sessionApiError(error) {
  if (error?.status) return error;
  const message = String(error?.message || "SESSION_PROVIDER_ERROR: 会话服务请求失败")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 320);
  const status = /SESSION_(?:CREDENTIALS_UNAVAILABLE|TOKEN_EXPIRED)/.test(message)
    ? 409
    : /SESSION_(?:TARGET_INVALID|CURRENT_DEVICE)/.test(message)
      ? 400
      : /SESSION_TARGET_NOT_FOUND/.test(message)
        ? 404
        : /SESSION_TOKEN_REFRESH_FAILED/.test(message)
          ? 502
          : /SESSION_PROVIDER_ERROR: HTTP 401/.test(message)
            ? 401
            : /SESSION_PROVIDER_ERROR: HTTP 403/.test(message)
              ? 403
              : 502;
  return httpError(status, message.replace(/^SESSION_[A-Z_]+:\s*/, ""));
}

function accountUsageApiError(error) {
  if (error?.status) return error;
  const message = String(error?.message || "ACCOUNT_USAGE_PROVIDER_ERROR: Sub2API 用量同步失败")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 320);
  const status = /ACCOUNT_USAGE_CREDENTIALS_UNAVAILABLE|SESSION_CREDENTIALS_UNAVAILABLE|SESSION_TOKEN_EXPIRED/.test(message)
    ? 409
    : /SESSION_PROVIDER_ERROR: HTTP 401/.test(message)
      ? 401
      : /SESSION_PROVIDER_ERROR: HTTP 403/.test(message)
        ? 403
        : 502;
  return httpError(status, message.replace(/^(?:ACCOUNT_USAGE|SESSION)_[A-Z_]+:\s*/, ""));
}

process.on("SIGINT", () => void shutdown().catch(reportShutdownFailure));
process.on("SIGTERM", () => void shutdown().catch(reportShutdownFailure));

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    queueSchedulingPaused = true;
    if (sub2ApiMonitorTimer) {
      clearInterval(sub2ApiMonitorTimer);
      sub2ApiMonitorTimer = null;
    }
    for (const controller of sub2ApiRequestControllers) controller.abort();
    await Promise.allSettled([
      sub2ApiMonitorPromise,
      taskSettingsWritePromise,
      ...sub2ApiRequestPromises,
      ...sub2ApiAutoRepairPromises,
    ].filter(Boolean));
    const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
    const childWaits = activeJobs
      .map((job) => job.child)
      .filter(Boolean)
      .map((child) => waitForChildExit(child, 3_000));
    await Promise.allSettled(activeJobs.map((job) => cancelJob(job)));
    await Promise.allSettled([
      ...childWaits,
      ...[...jobs.values()].map((job) => job.metadataWritePromise).filter(Boolean),
    ]);
    await vite.close();
    await closeHttpServer(server);
  })();
  return shutdownPromise;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      resolve();
    }, 3_000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reportShutdownFailure(error) {
  console.error(`[shutdown] ${error.message}`);
  process.exitCode = 1;
}
