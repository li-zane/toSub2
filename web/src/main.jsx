import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Filter,
  BriefcaseBusiness,
  Globe2,
  KeyRound,
  ListPlus,
  LoaderCircle,
  LogIn,
  Mail,
  MailCheck,
  LogOut,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Tags,
  PhoneIncoming,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";

const POLL_INTERVAL_MS = 900;
const SUB2API_PIPELINE_TIMEOUT_MS = 15 * 60_000;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const MAIL_REQUEST_SETTINGS_KEY = "chatgpt-onboarding.mail-request-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const ACCOUNT_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";
const PLAN_TYPE_MAPPING_STORAGE_KEY = "chatgpt-onboarding.plan-type-mapping-v1";
const DEFAULT_PLAN_TYPE_MAPPING = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  self_serve_business: "Business",
  self_serve_business_prolite: "Business Premium",
  self_serve_business_usage_based: "Business Usage Based",
  self_serve_pro: "Pro",
};
const SUB2API_WS_MODE_OPTIONS = [
  { value: "off", label: "关闭（off）" },
  { value: "ctx_pool", label: "上下文池（ctx_pool）" },
  { value: "passthrough", label: "透传（passthrough）" },
  { value: "http_bridge", label: "HTTP 桥接（http_bridge）" },
];
const SUB2API_WS_MODES = new Set(SUB2API_WS_MODE_OPTIONS.map((option) => option.value));
const SUB2API_WS_MODE_LABELS = Object.fromEntries(SUB2API_WS_MODE_OPTIONS.map((option) => [option.value, option.label]));
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
};
const REGION_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;

function App() {
  const [token, setToken] = useState("");
  const [features, setFeatures] = useState({});
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [planTypeFilter, setPlanTypeFilter] = useState("");
  const [sub2apiPoolFilter, setSub2apiPoolFilter] = useState("");
  const [sub2apiEnabledFilter, setSub2apiEnabledFilter] = useState("");
  const [planTypeOptions, setPlanTypeOptions] = useState([]);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  const [smsNumberOptions, setSmsNumberOptions] = useState([]);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [mailRequestSettings, setMailRequestSettings] = useState(readMailRequestSettings);
  const [mailRequestSettingsDraft, setMailRequestSettingsDraft] = useState(readMailRequestSettings);
  const [mailRequestSettingsOpen, setMailRequestSettingsOpen] = useState(false);
  const [mailRequestSettingsError, setMailRequestSettingsError] = useState("");
  const [mailRequestSettingsSaving, setMailRequestSettingsSaving] = useState(false);
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiPlanTypeDraft, setSub2apiPlanTypeDraft] = useState("");
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [accountProxyUrl, setAccountProxyUrl] = useState(() => readLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY));
  const [planTypeMapping, setPlanTypeMapping] = useState(readPlanTypeMapping);
  const [planTypeMappingOpen, setPlanTypeMappingOpen] = useState(false);
  const [planTypeMappingDraft, setPlanTypeMappingDraft] = useState(() => planTypeMappingRows(readPlanTypeMapping()));
  const [planTypeMappingError, setPlanTypeMappingError] = useState("");
  const [planTypeMappingSaving, setPlanTypeMappingSaving] = useState(false);
  const [credentialJob, setCredentialJob] = useState(null);
  const [sessionJob, setSessionJob] = useState(null);
  const [workspaceJob, setWorkspaceJob] = useState(null);
  const [sub2apiAccountStatus, setSub2apiAccountStatus] = useState({ configured: false, fetchedAt: null, accounts: {} });
  const [sub2apiToggleBusy, setSub2apiToggleBusy] = useState(() => new Set());
  const [sub2apiPriorityBusy, setSub2apiPriorityBusy] = useState(() => new Set());
  const [accountUsageByJobId, setAccountUsageByJobId] = useState({});

  const accountUsageJobKey = jobs
    .filter((job) => job.canDownload)
    .map((job) => `${job.id}:${job.lastOperationAt || job.updatedAt || ""}:${JSON.stringify(job.sub2apiUsage || null)}`)
    .join("|");

  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(MAIL_REQUEST_SETTINGS_KEY, mailRequestSettings), [mailRequestSettings]);
  useEffect(() => {
    const browserSettings = { ...sub2apiSettings };
    browserSettings.adminApiKey = "";
    writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, browserSettings);
  }, [sub2apiSettings]);
  useEffect(() => writeLocalTextSetting(ACCOUNT_PROXY_STORAGE_KEY, accountProxyUrl.trim()), [accountProxyUrl]);
  useEffect(() => writeLocalJson(PLAN_TYPE_MAPPING_STORAGE_KEY, planTypeMapping), [planTypeMapping]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          setToken(data.token);
          setFeatures(data.features || {});
        }
      })
      .catch((requestError) => setError(requestError.message));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    const localMapping = readPlanTypeMapping();
    apiFetch(token, "/api/plan-type-mapping")
      .then((data) => {
        if (stopped) return;
        const serverMapping = normalizePlanTypeMapping(data?.mapping);
        const shouldMigrate = data?.configured !== true && hasCustomPlanTypeMapping(localMapping);
        const merged = {
          ...DEFAULT_PLAN_TYPE_MAPPING,
          ...(shouldMigrate ? localMapping : serverMapping),
        };
        setPlanTypeMapping(merged);
        setPlanTypeMappingDraft(planTypeMappingRows(merged));
        if (shouldMigrate) {
          return apiFetch(token, "/api/plan-type-mapping", {
            method: "POST",
            body: JSON.stringify({ mapping: localMapping }),
          });
        }
        return null;
      })
      .catch((requestError) => {
        if (!stopped) setError(requestError.message);
      });
    return () => {
      stopped = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void apiFetch(token, "/api/mail-request-config", {
      method: "POST",
      body: JSON.stringify({ config: buildMailRequestConfig(mailRequestSettings) }),
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const filters = {
          planType: planTypeFilter || undefined,
          sub2apiPool: sub2apiPoolFilter || undefined,
          sub2apiEnabled: sub2apiEnabledFilter || undefined,
        };
        const data = emailFilter.length
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, emails: emailFilter, ...filters }),
            })
          : await apiFetch(token, `/api/jobs?${new URLSearchParams({
              page: String(page),
              ...(filters.planType ? { planType: filters.planType } : {}),
              ...(filters.sub2apiPool ? { sub2apiPool: filters.sub2apiPool } : {}),
              ...(filters.sub2apiEnabled ? { sub2apiEnabled: filters.sub2apiEnabled } : {}),
            }).toString()}`);
        if (!stopped) {
          setJobs(data.jobs);
          setCredentialJob((current) => data.jobs.find((job) => job.id === current?.id) || current);
          setSessionJob((current) => data.jobs.find((job) => job.id === current?.id) || current);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          setPlanTypeOptions(Array.isArray(data.filterOptions?.planTypes) ? data.filterOptions.planTypes : []);
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [token, page, emailFilter, planTypeFilter, sub2apiPoolFilter, sub2apiEnabledFilter]);

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => mergeServerSub2ApiSettings(current, data));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    apiFetch(token, "/api/sub2api/settings")
      .then((data) => {
        if (!stopped) setSub2apiSettings((current) => mergeServerSub2ApiSettings(current, data));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !features.sub2apiAccountStatus) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        if (!stopped) await refreshSub2ApiAccountStatus();
      } catch {
        // A missing or temporarily unavailable Sub2API backend leaves the local task list usable.
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiAccountStatus, sub2apiSettings.baseUrl, sub2apiSettings.hasStoredAdminApiKey]);

  useEffect(() => {
    if (!token || !features.accountUsage) return undefined;
    const usageJobs = jobs.filter((job) => job.canDownload);
    const usageJobIds = usageJobs.map((job) => job.id);
    setAccountUsageByJobId((current) => {
      const next = { ...current };
      for (const jobId of Object.keys(next)) {
        if (!usageJobIds.includes(jobId)) delete next[jobId];
      }
      for (const jobId of usageJobIds) {
        const job = usageJobs.find((item) => item.id === jobId);
        next[jobId] = job?.sub2apiUsage
          ? { status: "ready", ...job.sub2apiUsage }
          : { status: "ready", source: "sub2api", primary: null, secondary: null, credits: null, allowed: null, limitReached: null };
      }
      return next;
    });
  }, [token, features.accountUsage, accountUsageJobKey]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft],
  );
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const activeCredentialJob = credentialJob
    ? jobs.find((job) => job.id === credentialJob.id) || credentialJob
    : null;
  const activeSessionJob = sessionJob
    ? jobs.find((job) => job.id === sessionJob.id) || sessionJob
    : null;
  const activeWorkspaceJob = workspaceJob
    ? jobs.find((job) => job.id === workspaceJob.id) || workspaceJob
    : null;
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const canRotateAndUploadSelected = selectedJobs.length > 0
    && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canReplaceTotp && job.canDownload);
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;
  const hasJobFilters = Boolean(emailFilter.length || planTypeFilter || sub2apiPoolFilter || sub2apiEnabledFilter);
  const availablePlanTypes = [...new Set([
    ...planTypeOptions,
    ...jobs.map((job) => job.planType).filter(Boolean),
    ...(planTypeFilter && planTypeFilter !== "__unknown__" ? [planTypeFilter] : []),
  ])].sort();
  // PlanType bindings are persisted as a global reverse index (PlanType ->
  // profile), but the editor is scoped to the selected profile. Keeping the
  // view scoped prevents a binding from appearing to follow the user when they
  // switch profiles, while preserving the backend format and migration path.
  const activeProfileBindings = Object.entries(sub2apiSettingsDraft.planTypeBindings || {})
    .filter(([, profileId]) => String(profileId) === String(sub2apiSettingsDraft.activeProfileId));

  async function refreshAccountUsage(jobId) {
    if (!token || !features.accountUsage) return;
    setAccountUsageByJobId((current) => ({ ...current, [jobId]: { status: "loading" } }));
    try {
      const data = await apiFetch(token, `/api/jobs/${encodeURIComponent(jobId)}/usage?refresh=1`);
      setJobs((current) => current.map((job) => job.id === jobId ? { ...job, sub2apiUsage: data.usage || null } : job));
      setJobSelectionIndex((current) => current.map((job) => job.id === jobId ? { ...job, sub2apiUsage: data.usage || null } : job));
      setAccountUsageByJobId((current) => ({
        ...current,
        [jobId]: { status: "ready", ...(data.usage || {}) },
      }));
    } catch (requestError) {
      setAccountUsageByJobId((current) => ({
        ...current,
        [jobId]: { status: "error", error: requestError.message },
      }));
    }
  }

  function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsSettingsOpen(true);
  }

  function openMailRequestSettings() {
    setMailRequestSettingsDraft({ ...mailRequestSettings });
    setMailRequestSettingsError("");
    setMailRequestSettingsOpen(true);
  }

  async function saveMailRequestSettings(event) {
    event.preventDefault();
    let config;
    try {
      config = buildMailRequestConfig(mailRequestSettingsDraft);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
      return;
    }
    setMailRequestSettingsSaving(true);
    setMailRequestSettingsError("");
    try {
      await apiFetch(token, "/api/mail-request-config", {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setMailRequestSettings(normalizeMailRequestSettings(mailRequestSettingsDraft));
      setMailRequestSettingsOpen(false);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
    } finally {
      setMailRequestSettingsSaving(false);
    }
  }

  function openSub2ApiSettings() {
    const normalized = normalizeSub2ApiSettings({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsDraft(normalized);
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  function updateSub2ApiDraftProfile(patch) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const activeId = normalized.activeProfileId;
      const resolvedPatch = typeof patch === "function" ? patch(normalized) : patch;
      const profiles = normalized.profiles.map((profile) => profile.id === activeId
        ? normalizeSub2ApiProfile({ ...profile, ...resolvedPatch }, 0, profile)
        : profile);
      const active = profiles.find((profile) => profile.id === activeId) || profiles[0];
      return { ...normalized, ...active, profiles };
    });
  }

  function selectSub2ApiProfile(profileId) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const active = normalized.profiles.find((profile) => profile.id === String(profileId)) || normalized.profiles[0];
      return { ...normalized, ...active, activeProfileId: active.id };
    });
  }

  function addSub2ApiProfile() {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const id = `profile-${Date.now()}`;
      const profile = normalizeSub2ApiProfile({ id, name: `方案 ${normalized.profiles.length + 1}` }, normalized.profiles.length);
      return { ...normalized, ...profile, profiles: [...normalized.profiles, profile], activeProfileId: id };
    });
  }

  function removeSub2ApiProfile() {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      if (normalized.profiles.length <= 1 || normalized.activeProfileId === "default") return current;
      const remaining = normalized.profiles.filter((profile) => profile.id !== normalized.activeProfileId);
      const active = remaining[0];
      const planTypeBindings = Object.fromEntries(Object.entries(normalized.planTypeBindings)
        .filter(([, profileId]) => profileId !== normalized.activeProfileId));
      return { ...normalized, ...active, profiles: remaining, activeProfileId: active.id, planTypeBindings };
    });
  }

  function updateSub2ApiPlanTypeBinding(planType, profileId) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const next = { ...normalized.planTypeBindings };
      const key = String(planType || "").trim();
      if (key) next[key] = String(profileId);
      return { ...normalized, planTypeBindings: next };
    });
  }

  function removeSub2ApiPlanTypeBinding(planType) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const next = { ...normalized.planTypeBindings };
      delete next[planType];
      return { ...normalized, planTypeBindings: next };
    });
  }

  function addSub2ApiPlanTypeBinding() {
    const planType = String(sub2apiPlanTypeDraft || "").trim();
    if (!planType) return;
    updateSub2ApiPlanTypeBinding(planType, sub2apiSettingsDraft.activeProfileId);
    setSub2apiPlanTypeDraft("");
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function refreshSub2ApiAccountStatus(forceRefresh = false) {
    const data = await apiFetch(token, `/api/sub2api/account-status${forceRefresh ? "?refresh=1" : ""}`);
    setSub2apiAccountStatus(data);
    setJobs((current) => current.map((job) => mergeSub2ApiStatusIntoJob(job, data)));
    setJobSelectionIndex((current) => current.map((job) => mergeSub2ApiStatusIntoJob(job, data)));
    return data;
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError("请输入 http:// 或 https:// 开头的 Sub2API 后端地址");
      return;
    }
    if (!adminApiKey && !sub2apiSettingsDraft.hasStoredAdminApiKey) {
      setSub2apiSettingsError("请输入 Sub2API 管理员 API Key");
      return;
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
      hasStoredAdminApiKey: true,
    };
    setSub2apiSettingsSaving(true);
    try {
      const savedSettings = await apiFetch(token, "/api/sub2api/settings", {
        method: "POST",
        body: JSON.stringify({ config: nextSettings }),
      });
      const monitor = features.sub2apiMonitor
        ? await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      })
        : { ...savedSettings, enabled: false };
      setSub2apiSettings(mergeServerSub2ApiSettings(nextSettings, { ...savedSettings, ...monitor }));
      setSub2apiMonitorStatus((current) => ({ ...current, ...monitor }));
      void refreshSub2ApiAccountStatus(true).catch(() => {});
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    updateSub2ApiDraftProfile((normalized) => {
      const selected = new Set(normalized.groupIds || []);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { groupIds: [...selected] };
    });
  }

  async function performSub2ApiUpload(ids) {
    return apiFetch(token, "/api/sub2api/upload", {
      method: "POST",
      body: JSON.stringify({ ids, config: sub2apiSettings }),
    });
  }

  async function toggleSub2ApiAccount(job, enabled) {
    if (!job?.sub2apiInPool || sub2apiToggleBusy.has(job.id)) return;
    setSub2apiToggleBusy((current) => new Set(current).add(job.id));
    try {
      const data = await apiFetch(token, `/api/sub2api/accounts/${encodeURIComponent(job.id)}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      const status = data.status || {};
      const fields = sub2ApiStatusJobFields(status);
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, ...fields } : item));
      setJobSelectionIndex((current) => current.map((item) => item.id === job.id ? { ...item, ...fields } : item));
      setSub2apiAccountStatus((current) => ({
        ...current,
        fetchedAt: status.fetchedAt || current.fetchedAt,
        accounts: {
          ...(current.accounts || {}),
          [String(job.email || "").toLowerCase()]: status,
        },
      }));
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSub2apiToggleBusy((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }

  async function updateSub2ApiPriority(job, priority) {
    if (!job?.sub2apiInPool || sub2apiPriorityBusy.has(job.id)) return;
    setSub2apiPriorityBusy((current) => new Set(current).add(job.id));
    try {
      const data = await apiFetch(token, `/api/sub2api/accounts/${encodeURIComponent(job.id)}/priority`, {
        method: "POST",
        body: JSON.stringify({ priority }),
      });
      const status = {
        ...(data.status || {}),
        priority: data.status?.priority ?? data.priority ?? null,
      };
      const fields = sub2ApiStatusJobFields(status);
      const emailKey = String(job.email || "").toLowerCase();
      setJobs((current) => current.map((item) => (
        item.id === job.id || String(item.email || "").toLowerCase() === emailKey
          ? { ...item, ...fields }
          : item
      )));
      setJobSelectionIndex((current) => current.map((item) => (
        item.id === job.id || String(item.email || "").toLowerCase() === emailKey
          ? { ...item, ...fields }
          : item
      )));
      setSub2apiAccountStatus((current) => ({
        ...current,
        configured: true,
        fetchedAt: status.fetchedAt || current.fetchedAt,
        accounts: {
          ...(current.accounts || {}),
          [emailKey]: status,
        },
      }));
      setUploadNotice(`已更新 ${job.email} 的 Sub2API 优先级为 ${status.priority}`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSub2apiPriorityBusy((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }

  function formatSub2ApiUploadNotice(data) {
    if (Object.hasOwn(data || {}, "created") || Object.hasOwn(data || {}, "updated")) {
      const created = Math.max(0, Number(data?.created) || 0);
      const updated = Math.max(0, Number(data?.updated) || 0);
      const total = created + updated;
      return `已同步 ${total} 条（新增 ${created}，原地更新 ${updated}）${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`;
    }
    const rawResults = Array.isArray(data.result) ? data.result : [data.result || {}];
    const countField = (result, keys) => {
      const value = Number(keys.map((key) => result?.[key]).find((candidate) => candidate !== undefined) ?? 0);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    const createdKeys = ["account_created", "success"];
    const hasCreatedCount = rawResults.some((result) => createdKeys.some((key) => result?.[key] !== undefined));
    const created = hasCreatedCount
      ? rawResults.reduce((total, result) => total + countField(result, createdKeys), 0)
      : Number(data.uploaded || 0);
    const failed = rawResults.reduce((total, result) => total + countField(result, ["account_failed", "failed"]), 0);
    return `已上传 ${created} 条${failed ? `，失败 ${failed} 条` : ""}${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`;
  }

  async function uploadSelected(ids) {
    if (!hasUsableSub2ApiSettings(sub2apiSettings)) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址和管理员 API Key");
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      const data = await performSub2ApiUpload(ids);
      setUploadNotice(formatSub2ApiUploadNotice(data));
      void refreshSub2ApiAccountStatus(true).catch(() => {});
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function queryPipelineJobs(ids, emailById) {
    const emails = ids.map((id) => emailById.get(id)).filter(Boolean);
    if (emails.length !== ids.length) throw new Error("无法读取一键流程中的账号信息");
    const pages = [];
    let pageNumber = 1;
    let totalPages = 1;
    do {
      const data = await apiFetch(token, "/api/jobs/query", {
        method: "POST",
        body: JSON.stringify({ page: pageNumber, emails }),
      });
      pages.push(data);
      totalPages = Math.max(1, Number(data.pagination?.totalPages) || 1);
      pageNumber += 1;
    } while (pageNumber <= totalPages);
    const jobsById = new Map(pages.flatMap((data) => data.jobs || []).map((job) => [job.id, job]));
    if (jobsById.size !== ids.length) throw new Error("一键流程中的账号列表已发生变化，请刷新后重试");
    setJobs((current) => current.map((job) => jobsById.get(job.id) || job));
    const selectionById = new Map(pages.flatMap((data) => data.selection || []).map((job) => [job.id, job]));
    setJobSelectionIndex((current) => current.map((job) => selectionById.get(job.id) || job));
    return ids.map((id) => jobsById.get(id));
  }

  async function waitForPipelineJobs(ids, emailById, label, predicate, failurePredicate = null) {
    const deadline = Date.now() + SUB2API_PIPELINE_TIMEOUT_MS;
    let latest = [];
    while (Date.now() < deadline) {
      latest = await queryPipelineJobs(ids, emailById);
      const completed = latest.filter(predicate).length;
      setUploadNotice(`${label} ${completed}/${ids.length}`);
      const failed = latest.find((job) => failurePredicate?.(job) || (
        ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status) && !predicate(job)
      ));
      if (failed) {
        const detail = extractResponseMessage(failed.totpSetupError || failed.lastError || failed.prompt || "任务失败");
        throw new Error(`${failed.email}：${detail || "任务未完成"}`);
      }
      if (latest.every(predicate)) return latest;
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`${label}超时，请查看任务状态后重试`);
  }

  async function rotateLogoutReauthorizeUploadSelected() {
    if (!canRotateAndUploadSelected || batchAction) return;
    if (!hasUsableSub2ApiSettings(sub2apiSettings)) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址和管理员 API Key");
      return;
    }
    const ids = [...selectedJobIds];
    const emailById = new Map(selectedJobs.map((job) => [job.id, job.email]));
    const count = ids.length;
    if (!window.confirm(`确定对选中的 ${count} 个账号依次轮换 2FA、登出所有设备、重新授权并上传到 Sub2API 吗？当前会话会失效。`)) return;

    setBatchAction("rotate-logout-reauthorize-upload");
    setError("");
    setUploadNotice("正在轮换 2FA 0/" + count);
    try {
      const preflightJobs = await queryPipelineJobs(ids, emailById);
      const preflightFailure = preflightJobs.find((job) => !job.canReplaceTotp || !job.canDownload);
      if (preflightFailure) {
        throw new Error(`${preflightFailure.email} 当前不满足轮换 2FA 或上传条件，请刷新后重试`);
      }
      const rotationResults = await Promise.allSettled(ids.map((id) => apiFetch(token, `/api/jobs/${id}/replace-2fa`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      })));
      const rotationError = rotationResults.find((result) => result.status === "rejected");
      if (rotationError) throw new Error(`启动 2FA 轮换失败：${rotationError.reason?.message || "请求失败"}`);
      await waitForPipelineJobs(
        ids,
        emailById,
        "正在轮换 2FA",
        (job) => job.status === "completed"
          && job.lastOperationType === "replace_2fa"
          && job.hasTotpKey
          && !job.totpRotationIncomplete,
        (job) => (job.status === "completed" && job.totpRotationIncomplete) || job.status === "totp_setup_otp",
      );

      let loggedOut = 0;
      setUploadNotice("正在登出所有设备 0/" + count);
      const logoutResults = await Promise.allSettled(ids.map(async (id) => {
        const result = await apiFetch(token, `/api/jobs/${id}/sessions/logout-all`, { method: "POST" });
        loggedOut += 1;
        setUploadNotice(`正在登出所有设备 ${loggedOut}/${count}`);
        return result;
      }));
      const logoutError = logoutResults.find((result) => result.status === "rejected");
      if (logoutError) throw new Error(`登出所有设备失败：${logoutError.reason?.message || "请求失败"}`);

      setUploadNotice("正在重新授权 0/" + count);
      // logout-all invalidates the saved session/refresh token. Start a full
      // credential-backed login instead of the refresh-token regeneration path.
      const reauthorize = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids, proxyUrl: accountProxyUrl.trim() }),
      });
      if (reauthorize.started !== count) {
        throw new Error(`重新授权只启动了 ${reauthorize.started || 0}/${count} 个账号`);
      }
      await waitForPipelineJobs(
        ids,
        emailById,
        "正在重新授权",
        (job) => job.status === "completed"
          && job.lastOperationType === "relogin"
          && job.canDownload,
      );

      setUploadNotice("正在上传到 Sub2API");
      const uploaded = await performSub2ApiUpload(ids);
      setUploadNotice(formatSub2ApiUploadNotice(uploaded));
      setSelectedJobIds(new Set());
    } catch (requestError) {
      setError(`一键流程已停止：${requestError.message}`);
      setUploadNotice("一键流程未完成，已保留当前选择");
    } finally {
      setBatchAction("");
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError("请先填写 API Key");
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      const options = Array.isArray(data.options) ? data.options : [];
      setSmsNumberOptions(options);
      const current = resolved.config.maxPrice
        ? options.find((option) => option.country === resolved.config.country) || options[0]
        : options[0];
      if (!current) throw new Error("当前没有可购买的国家号码");
      updateSmsProviderConfig(resolved.id, {
        country: current.country,
        maxPrice: String(current.price),
        countryLabel: formatSmsCountryName(current),
      });
    } catch (requestError) {
      setSmsNumberOptions([]);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError("请选择接码平台");
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(`请填写${missing.label}`);
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  function openPlanTypeMapping() {
    setPlanTypeMappingDraft(planTypeMappingRows(planTypeMapping));
    setPlanTypeMappingError("");
    setPlanTypeMappingOpen(true);
  }

  function resetPlanTypeMapping() {
    setPlanTypeMappingDraft(planTypeMappingRows(DEFAULT_PLAN_TYPE_MAPPING));
    setPlanTypeMappingError("");
  }

  async function savePlanTypeMapping(event) {
    event.preventDefault();
    if (planTypeMappingSaving) return;
    const next = {};
    for (const row of planTypeMappingDraft) {
      const raw = String(row.raw || "").trim();
      const label = String(row.label || "").trim();
      if (!raw && !label) continue;
      if (!raw || !label) {
        setPlanTypeMappingError("每一行都需要填写原始 PlanType 和显示标签");
        return;
      }
      if (raw.length > 128 || label.length > 128) {
        setPlanTypeMappingError("PlanType 和显示标签最多 128 个字符");
        return;
      }
      next[raw] = label;
    }
    setPlanTypeMappingSaving(true);
    setPlanTypeMappingError("");
    try {
      const saved = await apiFetch(token, "/api/plan-type-mapping", {
        method: "POST",
        body: JSON.stringify({ mapping: next }),
      });
      const normalized = { ...DEFAULT_PLAN_TYPE_MAPPING, ...normalizePlanTypeMapping(saved.mapping || next) };
      setPlanTypeMapping(normalized);
      setPlanTypeMappingDraft(planTypeMappingRows(normalized));
      setPlanTypeMappingOpen(false);
    } catch (requestError) {
      setPlanTypeMappingError(requestError.message);
    } finally {
      setPlanTypeMappingSaving(false);
    }
  }

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), proxyUrl: accountProxyUrl.trim() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs([data.job], current).slice(0, 20));
      setEmail("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: batchText, proxyUrl: accountProxyUrl.trim() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs(data.jobs, current).slice(0, 20));
      setBatchText("");
      setBatchError("");
      setBatchOpen(false);
      setError("");
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setFilterText("");
    setPlanTypeFilter("");
    setSub2apiPoolFilter("");
    setSub2apiEnabledFilter("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function applyColumnFilter(setter, value) {
    setter(value);
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      const response = await fetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "批量下载失败");
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `确定为选中的 ${totpSetupSelectedCount} 个账号设置 2FA 吗？${skipped ? `另有 ${skipped} 个账号不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置 2FA${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `确定为选中的 ${passwordAddSelectedCount} 个无密码账号生成并添加随机强密码吗？${skipped ? `另有 ${skipped} 个账号已有密码或不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号添加密码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `确定让选中的 ${forceReloginSelectedCount} 个账号跳过刷新令牌，重新登录并授权吗？${skipped ? `另有 ${skipped} 个进行中账号将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds], proxyUrl: accountProxyUrl.trim() }),
      });
      setUploadNotice(`已开始重新登录并授权 ${data.started} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await fetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "原始信息导出失败");
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。`)) return;
    setBatchAction("delete");
    try {
      await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(`确定停止全部 ${runningCount} 条进行中和排队任务吗？`)) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <main className={`app-shell ${batchAction ? "workflow-busy" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div>
            <h1>ChatGPT 账号授权控制台</h1>
            <p>本地多任务协议登录</p>
          </div>
        </div>
        <div className="summary" aria-label="任务统计">
          <span><i className="status-dot active" />进行中 <strong>{stats.active}</strong></span>
          <span><i className="status-dot queued" />排队中 <strong>{stats.queued || 0}</strong></span>
          <span><i className="status-dot complete" />已完成 <strong>{stats.completed}</strong></span>
        </div>
      </header>

      <section className="workspace">
        <div className="section-heading">
          <div>
            <h2>授权任务</h2>
            <p>{emailFilter.length
              ? `匹配 ${pagination.total} 条，共 ${pagination.totalAll ?? pagination.total} 条任务`
              : (pagination.total ? `共 ${pagination.total} 条任务` : "添加邮箱后开始第一条任务")}</p>
          </div>
          <form className="add-form" onSubmit={createJob}>
            <div className="email-field">
              <Mail size={17} aria-hidden="true" />
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="输入邮箱地址"
                autoComplete="email"
                aria-label="邮箱地址"
                required
              />
            </div>
            <button className="primary-button" type="submit" disabled={!token || busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
              添加任务
            </button>
            <button className="secondary-button" type="button" onClick={openPlanTypeMapping} disabled={!token} title="配置 PlanType 映射" aria-label="配置 PlanType 映射">
              <Tags size={17} />
              PlanType 映射
            </button>
            <button className="secondary-button" type="button" onClick={() => { setBatchError(""); setBatchOpen(true); }} disabled={!token}>
              <ListPlus size={17} />
              批量添加
            </button>
            <button
              className={`secondary-button ${emailFilter.length ? "filter-active" : ""}`}
              type="button"
              onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }}
              disabled={!token}
            >
              <Filter size={17} />
              {emailFilter.length ? `筛选 ${emailFilter.length}` : "筛选账号"}
            </button>
            {emailFilter.length > 0 && (
              <button className="selection-text-button clear-filter-button" type="button" onClick={clearEmailFilter}>
                清除筛选
              </button>
            )}
          </form>
        </div>

        <div className="provider-toolbar sms-provider-toolbar" aria-label="接码平台配置">
          <div className="provider-heading"><PhoneIncoming size={17} /><strong>接码平台</strong></div>
          <span className="provider-name">{activeSmsProvider.name || "未选择"}</span>
          <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
            {activeSmsProvider.ready ? <Check size={14} /> : <CircleAlert size={14} />}
            {activeSmsProvider.ready
              ? (activeSmsProvider.summary ? `已配置 · ${activeSmsProvider.summary}` : "已配置")
              : "未完成配置"}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={openSmsSettings} disabled={!smsProviderDefinitions.length}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar mail-request-toolbar" aria-label="邮件接码请求配置">
          <div className="provider-heading"><MailCheck size={17} /><strong>邮件 API</strong></div>
          <span className="provider-name">{mailRequestSettings.method}</span>
          <span className="provider-ready">
            <Check size={14} />
            {formatMailRequestSummary(mailRequestSettings)}
          </span>
          <button type="button" className="secondary-button provider-settings-button" onClick={openMailRequestSettings} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar sub2api-toolbar" aria-label="Sub2API 配置与号池监控">
          <div className="provider-heading"><Send size={17} /><strong>Sub2API</strong></div>
          <span className="provider-name">{sub2apiSettings.baseUrl || "未配置后端"}</span>
          <span className={`provider-ready ${hasUsableSub2ApiSettings(sub2apiSettings) ? "" : "incomplete"}`}>
            {hasUsableSub2ApiSettings(sub2apiSettings) ? <Check size={14} /> : <CircleAlert size={14} />}
            {hasUsableSub2ApiSettings(sub2apiSettings)
              ? `${sub2apiSettings.groupIds.length ? `已配置 · ${sub2apiSettings.groupIds.length} 个号池` : "已配置 · 默认号池"}${sub2apiSettings.proxyId ? " · 已指定代理" : ""} · WS ${SUB2API_WS_MODE_LABELS[sub2apiSettings.wsMode] || sub2apiSettings.wsMode}`
              : "未完成配置"}
          </span>
          {features.sub2apiMonitor && (
            <span className={`provider-ready monitor-ready ${sub2apiMonitorStatus.enabled ? "" : "incomplete"}`}>
              {sub2apiMonitorStatus.running
                ? <LoaderCircle className="spin" size={14} />
                : sub2apiMonitorStatus.enabled ? <ShieldCheck size={14} /> : <CircleAlert size={14} />}
              {sub2apiMonitorStatus.running
                ? "正在巡检"
                : sub2apiMonitorStatus.enabled
                  ? `号池监控已启用${sub2apiMonitorStatus.lastCheckAt ? ` · ${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}` : ""}`
                  : "号池监控未启用"}
            </span>
          )}
          {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
            <button
              type="button"
              className="icon-button monitor-check-button"
              onClick={checkSub2ApiMonitorNow}
              disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
              title="立即检查 Sub2API 异常账号"
            >
              <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={16} />
            </button>
          )}
          <button type="button" className="secondary-button provider-settings-button" onClick={openSub2ApiSettings} disabled={!token}>
            <Settings2 size={16} />配置
          </button>
        </div>

        <div className="provider-toolbar account-proxy-toolbar" aria-label="代理 IP 配置">
          <div className="provider-heading"><Globe2 size={17} /><strong>代理 IP</strong></div>
          <div className="account-proxy-input">
            <label className="provider-field account-proxy-field" title="支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号">
              <Globe2 size={15} aria-hidden="true" />
              <input
                value={accountProxyUrl}
                onChange={(event) => setAccountProxyUrl(event.target.value)}
                placeholder="socks5h://用户名:密码@主机:端口"
                spellCheck="false"
                aria-label="代理 IP 地址"
              />
            </label>
          </div>
          <span className={`provider-ready ${accountProxyUrl.trim() ? "" : "incomplete"}`}>
            {accountProxyUrl.trim() ? <Check size={14} /> : <CircleAlert size={14} />}
            {accountProxyUrl.trim() ? "已配置，按账号检测出口" : "未配置，使用本地 IP"}
          </span>
          <a
            className="provider-external-link"
            href="https://invite.zooproxy.com/share/ez2v2jdb7"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            点击获取代理 IP
          </a>
        </div>

        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {uploadNotice && (
          <div className="global-success" role="status">
            {batchAction ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title="关闭"><X size={16} /></button>
          </div>
        )}

        {features.bulkActions && jobs.length > 0 && (
          <div className="selection-toolbar">
            <div className="selection-summary">
              <span>当前页 {jobs.length} 条，跨页已选 {selectedJobIds.size} 条，可下载 {downloadableSelectedCount} 条</span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length || Boolean(batchAction)}>
                本页全选
              </button>
              <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                清除选择
              </button>
            </div>
            <div className="bulk-actions">
              {features.cancelAll && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={!(stats.active || stats.queued) || Boolean(batchAction)}
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={16} /> : <Ban size={16} />}
                  停止全部
                </button>
              )}
              <button type="button" className="download-button" onClick={downloadSelected} disabled={!canDownloadSelected || Boolean(batchAction)}>
                {batchAction === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                批量下载
              </button>
              {features.sub2apiUpload && (
                <button type="button" className="secondary-button bulk-button" onClick={() => uploadSelected([...selectedJobIds])} disabled={!canUploadSelected || Boolean(batchAction)}>
                  {batchAction === "upload" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                  上传到 Sub2API
                </button>
              )}
              {features.sub2apiPipeline && (
                <button
                  type="button"
                  className="secondary-button bulk-button pipeline-button"
                  onClick={rotateLogoutReauthorizeUploadSelected}
                  disabled={!canRotateAndUploadSelected || Boolean(batchAction)}
                  title="依次轮换 2FA、登出所有设备、重新授权并上传到 Sub2API"
                >
                  {batchAction === "rotate-logout-reauthorize-upload" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  一键轮换并上传
                </button>
              )}
              {features.sourceExport && (
                <button type="button" className="secondary-button bulk-button" onClick={exportSelectedSource} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                  {batchAction === "source" ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
                  导出原始信息
                </button>
              )}
              <button type="button" className="regenerate-button bulk-button" onClick={reauthorizeSelected} disabled={!canReauthorizeSelected || Boolean(batchAction)}>
                {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                批量重新授权
              </button>
              {features.forceRelogin && (
                <button type="button" className="relogin-button bulk-button" onClick={forceReloginSelected} disabled={!canForceReloginSelected || Boolean(batchAction)}>
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                  批量重新登录并授权
                </button>
              )}
              {features.totpSetup && (
                <button type="button" className="secondary-button bulk-button" onClick={setupTotpSelected} disabled={!canSetupTotpSelected || Boolean(batchAction)}>
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  批量设置 2FA
                </button>
              )}
              {features.passwordAdd && (
                <button type="button" className="secondary-button bulk-button" onClick={addPasswordSelected} disabled={!canAddPasswordSelected || Boolean(batchAction)}>
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  批量添加密码
                </button>
              )}
              <button type="button" className="delete-button" onClick={deleteSelected} disabled={!selectedJobIds.size || Boolean(batchAction)}>
                {batchAction === "delete" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                批量删除
              </button>
            </div>
          </div>
        )}

        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!features.bulkActions || !pageJobIds.length || Boolean(batchAction)}
                    aria-label="选择当前页全部任务"
                  />
                </th>
                <th>账号</th>
                <th>
                  <div className="column-filter-heading">
                    <span>Plan type</span>
                    <select
                      value={planTypeFilter}
                      onChange={(event) => applyColumnFilter(setPlanTypeFilter, event.target.value)}
                      aria-label="筛选 Plan type"
                    >
                      <option value="">全部</option>
                      <option value="__unknown__">未知</option>
                      {availablePlanTypes.map((value) => <option key={value} value={value}>{formatPlanTypeLabel(value, planTypeMapping)}</option>)}
                    </select>
                  </div>
                </th>
                <th className="usage-heading">Sub2API 用量</th>
                <th>
                  <div className="column-filter-heading">
                    <span>Sub2API 号池</span>
                    <select
                      value={sub2apiPoolFilter}
                      onChange={(event) => applyColumnFilter(setSub2apiPoolFilter, event.target.value)}
                      aria-label="筛选 Sub2API 号池状态"
                    >
                      <option value="">全部</option>
                      <option value="added">已加入</option>
                      <option value="not_added">未加入</option>
                      <option value="unknown">未同步</option>
                    </select>
                  </div>
                </th>
                <th>
                  <div className="column-filter-heading">
                    <span>号池启用</span>
                    <select
                      value={sub2apiEnabledFilter}
                      onChange={(event) => applyColumnFilter(setSub2apiEnabledFilter, event.target.value)}
                      aria-label="筛选号池启用状态"
                    >
                      <option value="">全部</option>
                      <option value="enabled">已启用</option>
                      <option value="disabled">已停用</option>
                      <option value="unknown">未知</option>
                    </select>
                  </div>
                </th>
                <th className="priority-heading">Sub2API 优先级</th>
                <th>状态</th>
                <th>当前操作</th>
                <th>开始时间</th>
                <th>最近操作时间</th>
                <th className="actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && <EmptyState filtered={hasJobFilters} />}
              {jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    token={token}
                    expanded={expandedJobId === job.id}
                    onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                    onError={setError}
                    selected={selectedJobIds.has(job.id)}
                    onToggleSelected={() => toggleJobSelection(job.id)}
                    selectionSupported={Boolean(features.bulkActions && !batchAction)}
                    smsProviderAvailable={smsProviderDefinitions.length > 0}
                    smsProvider={activeSmsProvider}
                    onUpload={() => uploadSelected([job.id])}
                    sub2apiUploadAvailable={Boolean(features.sub2apiUpload && hasUsableSub2ApiSettings(sub2apiSettings))}
                    sub2apiToggleAvailable={Boolean(features.sub2apiAccountToggle && hasUsableSub2ApiSettings(sub2apiSettings))}
                    sub2apiToggleBusy={sub2apiToggleBusy.has(job.id)}
                    onToggleSub2Api={(enabled) => toggleSub2ApiAccount(job, enabled)}
                    sub2apiPriorityAvailable={Boolean(features.sub2apiAccountPriority && hasUsableSub2ApiSettings(sub2apiSettings))}
                    sub2apiPriorityBusy={sub2apiPriorityBusy.has(job.id)}
                    onUpdateSub2ApiPriority={(priority) => updateSub2ApiPriority(job, priority)}
                    totpSetupAvailable={Boolean(features.totpSetup)}
                    passwordAddAvailable={Boolean(features.passwordAdd)}
                    forceReloginAvailable={Boolean(features.forceRelogin)}
                    accountProxyUrl={accountProxyUrl}
                    planTypeMapping={planTypeMapping}
                    accountUsage={accountUsageByJobId[job.id]}
                    accountUsageAvailable={Boolean(features.accountUsage)}
                    onRefreshUsage={() => refreshAccountUsage(job.id)}
                    credentialsAvailable={Boolean(features.credentialDetails)}
                    onOpenCredentials={() => setCredentialJob(job)}
                    sessionsAvailable={Boolean(features.accountSessions)}
                    onOpenSessions={() => setSessionJob(job)}
                    workspacesAvailable={Boolean(features.accountWorkspaces)}
                    onOpenWorkspaces={() => setWorkspaceJob(job)}
                  />
                  {expandedJobId === job.id && (
                    <tr className="log-row">
                      <td colSpan="12"><JobLogs token={token} jobId={job.id} /></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {features.pagination && pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="任务分页">
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} title="上一页">
              <ChevronLeft size={17} />
            </button>
            <span>第 <strong>{pagination.page}</strong> / {pagination.totalPages} 页</span>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} title="下一页">
              <ChevronRight size={17} />
            </button>
          </nav>
        )}
      </section>
      {activeCredentialJob && (
          <CredentialDialog
          key={activeCredentialJob.id}
          token={token}
          job={activeCredentialJob}
          accountProxyUrl={accountProxyUrl}
          totpReplaceAvailable={Boolean(features.totpReplace)}
          onClose={() => setCredentialJob(null)}
          onError={setError}
        />
      )}
      {activeSessionJob && (
        <SessionDialog
          key={activeSessionJob.id}
          token={token}
          job={activeSessionJob}
          onClose={() => setSessionJob(null)}
          onError={setError}
        />
      )}
      {activeWorkspaceJob && (
        <WorkspaceDialog
          key={activeWorkspaceJob.id}
          token={token}
          job={activeWorkspaceJob}
          planTypeMapping={planTypeMapping}
          onClose={() => setWorkspaceJob(null)}
          onError={setError}
          onJobUpdate={(nextJob) => {
            setJobs((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
            setJobSelectionIndex((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
          }}
          onWorkspaceSwitched={() => {
            // The server invalidates its Sub2API status cache after the
            // in-place credential update. Refresh once immediately so the
            // account row keeps its pool badge/priority without waiting for
            // the regular 15-second status poll.
            void refreshSub2ApiAccountStatus(true).catch(() => {});
          }}
        />
      )}
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">接码平台配置</h2>
                <span>配置保存在当前浏览器</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择接码平台">
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                  }}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            {draftSmsProvider.definition && (
              <div className="provider-config-section">
                <div className="provider-description-row">
                  <div className="provider-description">{draftSmsProvider.definition.description}</div>
                  {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                    <a
                      className="provider-external-link"
                      href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label}
                    </a>
                  )}
                </div>
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => (
                    <label key={field.key} className={`settings-field ${["price-select", "textarea"].includes(field.type) ? "wide-settings-field" : ""}`}>
                      <span>{field.label}</span>
                      {field.type === "price-select" ? (
                        <div className="price-select-row">
                          <div className="price-select-box">
                            <Settings2 size={15} />
                            <select
                              value={draftSmsProvider.config.country || ""}
                              onChange={(event) => {
                                const selected = smsNumberOptions.find((option) => option.country === event.target.value);
                                if (!selected) return;
                                updateSmsProviderConfig(draftSmsProvider.id, {
                                  country: selected.country,
                                  maxPrice: String(selected.price),
                                  countryLabel: formatSmsCountryName(selected),
                                });
                              }}
                              disabled={!smsNumberOptions.length || smsOptionsLoading}
                              aria-label="SMSBower 国家与价格"
                            >
                              {!smsNumberOptions.length && (
                                <option value={draftSmsProvider.config.country || ""}>
                                  {smsOptionsLoading ? "正在查询实时价格..." : "请先查询实时价格"}
                                </option>
                              )}
                              {smsNumberOptions.map((option) => (
                                <option key={option.country} value={option.country}>{formatSmsPriceOption(option)}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="price-refresh-button"
                            onClick={() => loadSmsNumberOptions()}
                            disabled={smsOptionsLoading || !draftSmsProvider.config.apiKey}
                          >
                            {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                            {smsOptionsLoading ? "查询中" : "查询价格"}
                          </button>
                        </div>
                      ) : field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={field.placeholder}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{smsSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {mailRequestSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
        }}>
          <form className="batch-dialog mail-request-settings-dialog" onSubmit={saveMailRequestSettings} role="dialog" aria-modal="true" aria-labelledby="mail-request-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-request-settings-title">邮件 API 请求配置</h2>
                <span>配置保存在当前浏览器，请求内容不会写入任务日志</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs mail-method-tabs" role="tablist" aria-label="邮件 API 请求方式">
              {["GET", "POST"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={mailRequestSettingsDraft.method === method}
                  className={mailRequestSettingsDraft.method === method ? "active" : ""}
                  onClick={() => setMailRequestSettingsDraft((current) => ({ ...current, method }))}
                >
                  {method}
                </button>
              ))}
            </div>

            <div className="provider-config-grid mail-request-config-grid">
              {mailRequestSettingsDraft.method === "POST" && (
                <label className="settings-field wide-settings-field">
                  <span className="mail-request-url-label">
                    统一 POST 请求 URL
                    <small>必填</small>
                  </span>
                  <input
                    className="mail-request-url-input"
                    type="url"
                    value={mailRequestSettingsDraft.url}
                    onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mail.example/api/messages"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <small>每个账号自己的请求体请在批量添加账号时一并导入</small>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>请求头 JSON</span>
                <textarea
                  className="settings-textarea"
                  value={mailRequestSettingsDraft.headersText}
                  onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, headersText: event.target.value }))}
                  placeholder={'{"Authorization":"Bearer ...","Referer":"https://mail.example/"}'}
                  rows="7"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            </div>

            {mailRequestSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{mailRequestSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={mailRequestSettingsSaving || !token}>
                {mailRequestSettingsSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">Sub2API 配置</h2>
                <span>配置保存到 x1 服务端设置文件；管理员 Key 不写入任务文件、日志或浏览器存储</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title="关闭"><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>Sub2API 后端地址</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="例如 http://127.0.0.1:8080"
                  autoComplete="url"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span>
                    <strong>每 5 分钟监控异常账号</strong>
                    <small>只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务</small>
                  </span>
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>管理员 API Key</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder={sub2apiSettingsDraft.hasStoredAdminApiKey ? "已保存到 x1，留空保持不变" : "输入 sub2api 管理员 API Key"}
                  autoComplete="off"
                />
              </label>
              <section className="sub2api-profile-manager wide-settings-field" aria-label="Sub2API 配置方案">
                <div className="sub2api-profile-header">
                  <div>
                    <strong>配置方案</strong>
                    <small>管理地址、管理员密钥和自动检测为全局设置；号池、代理、模型、并发等内容按方案独立保存。</small>
                  </div>
                  <button type="button" className="secondary-button" onClick={addSub2ApiProfile}><Plus size={15} />新增方案</button>
                </div>
                <div className="sub2api-profile-controls">
                  <label className="settings-field">
                    <span>当前方案</span>
                    <select value={sub2apiSettingsDraft.activeProfileId} onChange={(event) => selectSub2ApiProfile(event.target.value)}>
                      {sub2apiSettingsDraft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label className="settings-field sub2api-profile-name-field">
                    <span>方案名称</span>
                    <input
                      value={sub2apiSettingsDraft.name || ""}
                      maxLength="80"
                      onChange={(event) => updateSub2ApiDraftProfile({ name: event.target.value })}
                      placeholder="例如 Business Premium"
                    />
                  </label>
                  <button type="button" className="icon-button danger" onClick={removeSub2ApiProfile} disabled={sub2apiSettingsDraft.profiles.length <= 1 || sub2apiSettingsDraft.activeProfileId === "default"} title={sub2apiSettingsDraft.activeProfileId === "default" ? "默认方案不可删除" : "删除当前方案"} aria-label="删除当前方案"><Trash2 size={16} /></button>
                </div>
                <div className="sub2api-profile-fallback-hint" role="note">
                  <strong>未绑定回退规则</strong>
                  <span>账号的 PlanType 没有绑定方案时，会使用当前方案“{sub2apiSettingsDraft.name || "当前方案"}”；已绑定的 PlanType 优先使用绑定方案。</span>
                </div>
                <div className="sub2api-binding-panel">
                  <div className="sub2api-binding-heading">
                    <span>PlanType 绑定（当前方案）</span>
                    <small>左框是账号实际检测到的原始 PlanType（括号内显示原始值）；右框是匹配后使用的 Sub2API 配置方案。箭头表示“检测类型 → 配置方案”。仅显示绑定到“{sub2apiSettingsDraft.name || "当前方案"}”的检测类型；切换方案后列表会随之切换。</small>
                  </div>
                  <div className="sub2api-binding-list">
                    {activeProfileBindings.map(([planType, profileId]) => (
                      <div className="sub2api-binding-row" key={planType}>
                        <select value={planType} onChange={(event) => {
                          const next = event.target.value;
                          removeSub2ApiPlanTypeBinding(planType);
                          if (next) updateSub2ApiPlanTypeBinding(next, profileId);
                        }}>
                          <option value={planType}>{formatPlanTypeLabel(planType, planTypeMapping)} ({planType})</option>
                          {availablePlanTypes.filter((value) => value !== planType).map((value) => <option key={value} value={value}>{formatPlanTypeLabel(value, planTypeMapping)} ({value})</option>)}
                        </select>
                        <span aria-hidden="true">→</span>
                        <select value={profileId} onChange={(event) => updateSub2ApiPlanTypeBinding(planType, event.target.value)}>
                          {sub2apiSettingsDraft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                        </select>
                        <button type="button" className="icon-button danger" onClick={() => removeSub2ApiPlanTypeBinding(planType)} title="删除绑定" aria-label="删除绑定"><Trash2 size={15} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="sub2api-binding-add">
                    <input
                      list="sub2api-plan-type-options"
                      value={sub2apiPlanTypeDraft}
                      maxLength="128"
                      onChange={(event) => setSub2apiPlanTypeDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSub2ApiPlanTypeBinding(); } }}
                      placeholder="输入或选择 PlanType，例如 free"
                      aria-label="添加 PlanType 绑定"
                    />
                    <datalist id="sub2api-plan-type-options">
                      {availablePlanTypes.map((value) => <option key={value} value={value}>{formatPlanTypeLabel(value, planTypeMapping)}</option>)}
                    </datalist>
                    <button type="button" className="secondary-button" onClick={addSub2ApiPlanTypeBinding} disabled={!sub2apiPlanTypeDraft.trim()}><Plus size={14} />绑定</button>
                  </div>
                </div>
              </section>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>目标号池（可多选）</legend>
                <section className="sub2api-group-picker" aria-label="目标号池">
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={(sub2apiSettingsDraft.groupIds || []).includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{group.name}</span>
                        <small>{formatSub2ApiGroupPlatform(group.platform)} · ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">暂无可选号池</div>}
                </section>
                <section className="sub2api-group-selection" aria-label="号池选择操作">
                  <span>已选 {(sub2apiSettingsDraft.groupIds || []).length} 个</span>
                  <button
                    type="button"
                    onClick={() => updateSub2ApiDraftProfile({ groupIds: sub2apiGroups.map((group) => String(group.id)) })}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => (sub2apiSettingsDraft.groupIds || []).includes(String(group.id)))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSub2ApiDraftProfile({ groupIds: [] })}
                    disabled={!sub2apiSettingsDraft.groupIds?.length}
                  >
                    清空
                  </button>
                </section>
              </fieldset>
              <label className="settings-field wide-settings-field">
                <span>代理 IP</span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => updateSub2ApiDraftProfile({ proxyId: event.target.value })}
                >
                  <option value="">使用账号原配置</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field wide-settings-field">
                <span>Codex 指纹收敛</span>
                <select
                  value={sub2apiSettingsDraft.codexFingerprintMode}
                  onChange={(event) => updateSub2ApiDraftProfile({ codexFingerprintMode: event.target.value })}
                >
                  <option value="off">关闭（透传）</option>
                  <option value="device">仅设备</option>
                  <option value="session">设备+会话（推荐）</option>
                  <option value="full">完全收敛</option>
                </select>
              </label>
              <label className="settings-field wide-settings-field">
                <span>WS mode</span>
                <select
                  value={sub2apiSettingsDraft.wsMode}
                  onChange={(event) => updateSub2ApiDraftProfile({ wsMode: event.target.value })}
                >
                  {SUB2API_WS_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="settings-field">
                <span>并发数</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.concurrency}
                  onChange={(event) => updateSub2ApiDraftProfile({ concurrency: event.target.value })}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>负载因子</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.loadFactor}
                  onChange={(event) => updateSub2ApiDraftProfile({ loadFactor: event.target.value })}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field">
                <span>优先级</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  value={sub2apiSettingsDraft.priority}
                  onChange={(event) => updateSub2ApiDraftProfile({ priority: event.target.value })}
                  placeholder="留空使用账号原值"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>账号命名模板</span>
                <input
                  type="text"
                  maxLength="256"
                  value={sub2apiSettingsDraft.accountNameTemplate}
                  onChange={(event) => updateSub2ApiDraftProfile({ accountNameTemplate: event.target.value })}
                  placeholder="例如：chatgpt-{email}"
                  spellCheck="false"
                />
                <small className="settings-field-hint">留空保留导入文件原名；支持 {'{email}'}、{'{planType}'}、{'{accountId}'}、{'{name}'}</small>
              </label>
              <label className="settings-field wide-settings-field">
                <span>允许使用的模型</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => updateSub2ApiDraftProfile({ modelWhitelist: event.target.value })}
                  placeholder={"每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1"}
                  rows="5"
                  spellCheck="false"
                />
              </label>
            </div>
            <div className="dialog-hint">分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择 OpenAI 或 Composite 分组后只监控这些号池。Codex 指纹收敛和 WS mode 会写入每个上传或巡检更新的 OpenAI OAuth 账号。要让账号级 WS mode 生效，请确认 Sub2API 的 gateway.openai_ws.mode_router_v2_enabled 已开启。</div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? `上次巡检失败：${sub2apiMonitorStatus.lastError}`
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : "尚未执行号池巡检"}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{sub2apiSettingsError}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {planTypeMappingOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPlanTypeMappingOpen(false);
        }}>
          <form className="batch-dialog plan-type-mapping-dialog" onSubmit={savePlanTypeMapping} role="dialog" aria-modal="true" aria-labelledby="plan-type-mapping-title">
            <div className="dialog-header">
              <div>
                <h2 id="plan-type-mapping-title">PlanType 映射</h2>
                <span>把 OAuth 原始参数转换为账号列表中的显示标签</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setPlanTypeMappingOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="plan-type-mapping-list">
              {planTypeMappingDraft.map((row, index) => (
                <div className="plan-type-mapping-row" key={`${row.raw || "new"}-${index}`}>
                  <label>
                    <span>原始 PlanType</span>
                    <input
                      value={row.raw}
                      onChange={(event) => setPlanTypeMappingDraft((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, raw: event.target.value } : item))}
                      placeholder="self_serve_business_prolite"
                      spellCheck="false"
                    />
                  </label>
                  <span className="plan-type-mapping-arrow" aria-hidden="true">→</span>
                  <label>
                    <span>显示标签</span>
                    <input
                      value={row.label}
                      onChange={(event) => setPlanTypeMappingDraft((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))}
                      placeholder="Business Premium"
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => setPlanTypeMappingDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    title="删除映射"
                    aria-label="删除映射"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="secondary-button mapping-add-button"
              onClick={() => setPlanTypeMappingDraft((current) => [...current, { raw: "", label: "" }])}
            >
              <Plus size={16} />添加映射
            </button>
            {planTypeMappingError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{planTypeMappingError}</div>}
            <div className="dialog-footer">
              <button type="button" className="selection-text-button" onClick={resetPlanTypeMapping}>恢复默认</button>
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setPlanTypeMappingOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={planTypeMappingSaving || !token}>
                {planTypeMappingSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存映射
              </button>
            </div>
          </form>
        </div>
      )}
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">批量添加账号</h2>
                <span>{countBatchLines(batchText)} 条，超出并发上限后自动排队</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">
              {mailRequestSettings.method === "POST"
                ? "每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限"
                : "每行一个账号：自动识别邮箱、密码、邮件 API 和 2FA，字段顺序不限"}
            </label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={mailRequestSettings.method === "POST"
                ? "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b"
                : "name@icloud.com----https://mail.example/messages/name\nhttps://mail.example/messages/name2|账号密码|name2@example.co.uk|BASE32二步验证密钥\nBASE32二步验证密钥::name3@example.dev::账号密码"}
              spellCheck="false"
              autoFocus
            />
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{batchError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>取消</button>
              <button type="submit" className="primary-button" disabled={!batchText.trim() || batchBusy || countBatchLines(batchText) > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                创建 {countBatchLines(batchText) || ""} 条任务
              </button>
            </div>
          </form>
        </div>
      )}
      {filterOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFilterOpen(false);
        }}>
          <form className="batch-dialog filter-dialog" onSubmit={applyEmailFilter} role="dialog" aria-modal="true" aria-labelledby="filter-title">
            <div className="dialog-header">
              <div>
                <h2 id="filter-title">筛选账号</h2>
                <span>{countBatchLines(filterText)} 个邮箱</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setFilterOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="filter-input">每行输入一个完整邮箱地址</label>
            <textarea
              id="filter-input"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={"name1@icloud.com\nname2@icloud.com"}
              spellCheck="false"
              autoFocus
            />
            {filterError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{filterError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim() || countBatchLines(filterText) > 500}>
                <Filter size={17} />应用筛选
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="12">
        <div className="empty-state">
          <div><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "当前筛选邮箱不在任务列表中。" : "在右上方输入邮箱地址开始登录。"}</p>
        </div>
      </td>
    </tr>
  );
}

function JobRow({ job, token, expanded, onToggleLogs, onError, selected, onToggleSelected, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, sub2apiToggleAvailable, sub2apiToggleBusy, onToggleSub2Api, sub2apiPriorityAvailable, sub2apiPriorityBusy, onUpdateSub2ApiPriority, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, accountProxyUrl, planTypeMapping, accountUsage, accountUsageAvailable, onRefreshUsage, credentialsAvailable, onOpenCredentials, sessionsAvailable, onOpenSessions, workspacesAvailable, onOpenWorkspaces }) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [priorityValue, setPriorityValue] = useState(() => job.sub2apiPriority === null || job.sub2apiPriority === undefined ? "" : String(job.sub2apiPriority));
  const [accountNameCopied, setAccountNameCopied] = useState(false);

  useEffect(() => setValue(""), [job.status]);
  useEffect(() => {
    setPriorityValue(job.sub2apiPriority === null || job.sub2apiPriority === undefined ? "" : String(job.sub2apiPriority));
  }, [job.sub2apiPriority]);

  function savePriority() {
    if (!sub2apiPriorityAvailable || job.sub2apiInPool !== true || sub2apiPriorityBusy) return;
    onUpdateSub2ApiPriority(priorityValue.trim());
  }

  async function sendInput(action, submittedValue = value) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: submittedValue }),
      });
      setValue("");
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forceRelogin() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function setupTotp() {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (!window.confirm("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。")) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify({ proxyUrl: accountProxyUrl.trim() }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError("无法自动复制，请手动选择 2FA 密钥");
    }
  }

  async function copyAccountName() {
    try {
      await copyText(job.email || "");
      setAccountNameCopied(true);
      window.setTimeout(() => setAccountNameCopied(false), 1_600);
    } catch {
      onError("无法自动复制账号名，请手动选择账号名");
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: smsProvider.id, config: smsProvider.config }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function download() {
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);

  return (
    <tr className={`job-row status-${job.status}`}>
      <td className="select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          disabled={!selectionSupported}
          aria-label={`选择 ${job.email}`}
        />
      </td>
      <td>
        <div className="account-cell">
          <div className="account-avatar">{job.email.slice(0, 1).toUpperCase()}</div>
          <div className="account-details">
            <button type="button" className={`account-name-copy ${accountNameCopied ? "copied" : ""}`} onClick={copyAccountName} title={accountNameCopied ? "已复制" : "点击复制账号名"} aria-label={`复制账号名 ${job.email}`}>
              <strong>{job.email}</strong>
              {accountNameCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            </button>
            <span>{shortId(job.id)}</span>
          </div>
          <LoginMethodBadge job={job} />
        </div>
      </td>
      <td className={`plan-cell ${job.planType ? "" : "unknown"}`} title={job.planType || "未知"}>
        <span className="plan-tag">{formatPlanTypeLabel(job.planType, planTypeMapping)}</span>
        {job.sub2apiInPool === true && job.sub2apiPlanType && job.planType
          && job.sub2apiPlanType !== job.planType && (
          <span
            className="plan-sync-note"
            title={`本地工作空间：${job.planType}；Sub2API 号池：${job.sub2apiPlanType}`}
            aria-label={`Sub2API 号池中的 PlanType 为 ${formatPlanTypeLabel(job.sub2apiPlanType, planTypeMapping)}`}
          >
            号池：{formatPlanTypeLabel(job.sub2apiPlanType, planTypeMapping)}
          </span>
        )}
      </td>
      <td className="usage-cell-column">
        <AccountUsageCell usage={accountUsage} available={job.canDownload} enabled={accountUsageAvailable} onRefresh={onRefreshUsage} />
      </td>
      <td className="pool-status-cell">
        <Sub2ApiPoolBadge inPool={job.sub2apiInPool} />
      </td>
      <td className="pool-enabled-cell">
        <Sub2ApiEnabledToggle
          inPool={job.sub2apiInPool}
          enabled={job.sub2apiEnabled}
          available={sub2apiToggleAvailable}
          busy={sub2apiToggleBusy}
          onChange={onToggleSub2Api}
        />
      </td>
      <td
        className={`sub2api-priority-cell ${job.sub2apiInPool !== true ? "unknown" : ""}`}
        title={job.sub2apiInPool !== true ? "尚未同步 Sub2API 优先级" : "编辑并保存 Sub2API 优先级"}
      >
        {job.sub2apiInPool === true ? (
          <div className="sub2api-priority-editor">
            <input
              type="number"
              min="0"
              max="10000"
              step="1"
              inputMode="numeric"
              value={priorityValue}
              onChange={(event) => setPriorityValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  savePriority();
                }
              }}
              disabled={!sub2apiPriorityAvailable || sub2apiPriorityBusy}
              aria-label={`编辑 ${job.email} 的 Sub2API 优先级`}
            />
            <button
              type="button"
              className="icon-button priority-save-button"
              onClick={savePriority}
              disabled={!sub2apiPriorityAvailable || sub2apiPriorityBusy}
              title="保存 Sub2API 优先级"
              aria-label="保存 Sub2API 优先级"
            >
              {sub2apiPriorityBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            </button>
          </div>
        ) : "—"}
      </td>
      <td><StatusBadge status={job.status} /></td>
      <td className="step-cell">
        <div className="prompt-line">{job.prompt}</div>
        {job.lastError && <div className="row-error">{extractResponseMessage(job.lastError)}</div>}
        {job.autoRepairBlocked && (
          <div className="row-error">号池监控已永久跳过：{extractResponseMessage(job.autoRepairBlockedReason || "账号已不可用")}</div>
        )}
        {job.totpSetupError && <div className="row-error">2FA：{extractResponseMessage(job.totpSetupError)}</div>}
        {job.passwordAddError && <div className="row-error">添加密码：{extractResponseMessage(job.passwordAddError)}</div>}
        {job.mailApiError && job.status === "email_otp" && <div className="mail-error">{job.mailApiError}</div>}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>2FA 密钥</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title="复制 2FA 密钥">
              <Copy size={15} />
            </button>
          </div>
        )}
        {inputConfig && (
          <div className="inline-entry">
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) sendInput(inputConfig.action);
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />重发
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />重发
                </button>
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />换号
                </button>
              </>
            )}
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? `使用 ${smsProvider.name} 取号` : "请先完成接码平台配置"}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {smsProvider.name || "平台"}取号
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="time-cell"><time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time></td>
      <td className="operation-time-cell">
        <time dateTime={job.lastOperationAt || job.createdAt}>{formatDateTime(job.lastOperationAt || job.createdAt)}</time>
        <span>{operationLabel(job.lastOperationType)}</span>
      </td>
      <td className="actions-cell">
        <div className="row-actions">
          {credentialsAvailable && (
            <button type="button" className="icon-button" onClick={onOpenCredentials} disabled={submitting} title="查看或修改账号凭据">
              <KeyRound size={17} />
            </button>
          )}
          {sessionsAvailable && job.canDownload && (
            <button type="button" className="icon-button" onClick={onOpenSessions} disabled={submitting} title="查看已登录设备和会话">
              <MonitorSmartphone size={17} />
            </button>
          )}
          {workspacesAvailable && job.canDownload && (
            <button type="button" className="icon-button" onClick={onOpenWorkspaces} disabled={submitting} title="查看并切换工作空间">
              <BriefcaseBusiness size={17} />
            </button>
          )}
          {job.canDownload && (
            <button type="button" className="download-button" onClick={download}>
              <Download size={16} />下载
            </button>
          )}
          {job.canDownload && sub2apiUploadAvailable && (
            <button type="button" className="secondary-button" onClick={onUpload} disabled={submitting} title="上传到已配置的 Sub2API 号池">
              <Send size={16} />上传
            </button>
          )}
          {job.canRegenerate && (
            <button type="button" className="regenerate-button" onClick={regenerate} disabled={submitting} title="重新授权：优先使用刷新令牌，失效后自动重新登录">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              重新授权
            </button>
          )}
          {forceReloginAvailable && job.canForceRelogin && (
            <button type="button" className="relogin-button" onClick={forceRelogin} disabled={submitting} title="跳过刷新令牌和旧检查点，完整重新登录后自动授权">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
              重新登录并授权
            </button>
          )}
          {totpSetupAvailable && job.canSetupTotp && (
            <button type="button" className="icon-button" onClick={setupTotp} disabled={submitting} title="设置 2FA">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            </button>
          )}
          {passwordAddAvailable && job.canAddPassword && (
            <button type="button" className="icon-button" onClick={addPassword} disabled={submitting} title="添加密码">
              {submitting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
            </button>
          )}
          {job.canRetry && (
            <button type="button" className="retry-button" onClick={retry} disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
              {job.securityCheckRequired ? "手动重试" : job.canResume ? "继续流程" : "重新授权"}
            </button>
          )}
          <button type="button" className="icon-button" onClick={onToggleLogs} title={expanded ? "收起日志" : "查看日志"}>
            <FileText size={17} />
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {!terminal && (
            <button type="button" className="icon-button danger" onClick={cancel} disabled={submitting} title="取消任务">
              <Ban size={17} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function JobLogs({ token, jobId }) {
  const [logs, setLogs] = useState("正在读取日志...");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${jobId}/logs`);
        if (!stopped) setLogs(data.logs || "暂无日志");
      } catch (error) {
        if (!stopped) setLogs(`日志读取失败：${error.message}`);
      }
    };
    load();
    const timer = window.setInterval(load, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, token]);

  return (
    <div className="log-panel">
      <div className="log-title"><FileText size={15} />协议日志</div>
      <pre>{logs}</pre>
    </div>
  );
}

function CredentialDialog({ token, job, accountProxyUrl, totpReplaceAvailable, onClose, onError }) {
  const [details, setDetails] = useState(null);
  const [password, setPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [sub2apiJson, setSub2apiJson] = useState("");
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [totpDirty, setTotpDirty] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [totpSeconds, setTotpSeconds] = useState(0);
  const [totpCodeError, setTotpCodeError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setDialogError("");
    setNotice("");
    apiFetch(token, `/api/jobs/${job.id}/credentials`)
      .then((data) => {
        if (stopped) return;
        const next = data.credentials || {};
        setDetails(next);
        setPassword(next.password || "");
        setTotpSecret(next.totpSecret || "");
        setSub2apiJson(next.sub2apiJson || "");
        setPasswordDirty(false);
        setTotpDirty(false);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [job.id, token]);

  useEffect(() => {
    let stopped = false;
    async function refreshTotpCode() {
      const normalized = normalizeTotpForDisplay(totpSecret);
      const seconds = 30 - (Math.floor(Date.now() / 1000) % 30);
      if (!stopped) setTotpSeconds(seconds);
      if (!normalized) {
        if (!stopped) {
          setTotpCode("");
          setTotpCodeError("");
        }
        return;
      }
      try {
        const code = await generateTotpCode(normalized);
        if (!stopped) {
          setTotpCode(code);
          setTotpCodeError("");
        }
      } catch (error) {
        if (!stopped) {
          setTotpCode("");
          setTotpCodeError(error.message || "2FA 密钥无法生成动态验证码");
        }
      }
    }
    void refreshTotpCode();
    const timer = window.setInterval(refreshTotpCode, 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [totpSecret]);

  async function refreshCredentials() {
    setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/credentials`);
      const next = data.credentials || {};
      setDetails(next);
      setPassword(next.password || "");
      setTotpSecret(next.totpSecret || "");
      setSub2apiJson(next.sub2apiJson || "");
      setPasswordDirty(false);
      setTotpDirty(false);
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    const body = {};
    if (passwordDirty) body.password = password;
    if (totpDirty) {
      const normalized = totpSecret.toUpperCase().replace(/[\s=]/g, "");
      if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
        setDialogError("2FA 密钥必须是 16 到 128 位 Base32 字符");
        return;
      }
      body.totpSecret = normalized;
    }
    if (!Object.keys(body).length) {
      setNotice("没有需要保存的修改");
      return;
    }
    setSaving(true);
    setDialogError("");
    setNotice("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/credentials`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const next = data.credentials || {};
      setDetails(next);
      setPassword(next.password || "");
      setTotpSecret(next.totpSecret || "");
      setSub2apiJson(next.sub2apiJson || sub2apiJson);
      setPasswordDirty(false);
      setTotpDirty(false);
      setNotice(next.persisted === false
        ? "已更新当前进程凭据，但系统未提供持久凭据存储"
        : "凭据已更新并保存");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function replaceTotp() {
    const confirmed = window.confirm(
      "确定轮换该账号的 2FA 吗？服务会先停用旧 2FA，再创建并激活新密钥；如果远端创建失败，账号可能暂时没有 2FA，需要在本窗口重试。",
    );
    if (!confirmed) return;
    setReplacing(true);
    setDialogError("");
    setNotice("");
    try {
      const body = {};
      const proxyUrl = accountProxyUrl.trim();
      if (proxyUrl) body.proxyUrl = proxyUrl;
      await apiFetch(token, `/api/jobs/${job.id}/replace-2fa`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice("2FA 轮换已排队，请等待任务完成后重新读取凭据");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setReplacing(false);
    }
  }

  async function copySub2apiJson() {
    if (!sub2apiJson) return;
    try {
      await navigator.clipboard.writeText(sub2apiJson);
      setNotice("Sub2API JSON 已复制");
      onError("");
    } catch {
      setDialogError("无法自动复制 Sub2API JSON，请在滚动区域中手动选择");
    }
  }

  async function copyTotpCode() {
    if (!totpCode) return;
    try {
      await navigator.clipboard.writeText(totpCode);
      setNotice("动态验证码已复制");
      onError("");
    } catch {
      setDialogError("无法自动复制动态验证码，请手动选择验证码");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving && !replacing) onClose();
    }}>
      <form className="batch-dialog credential-dialog" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
        <div className="dialog-header">
          <div>
            <h2 id="credential-dialog-title">账号凭据</h2>
            <span>{job.email}</span>
          </div>
          <div className="dialog-header-actions">
            <button
              type="button"
              className="icon-button"
              onClick={refreshCredentials}
              disabled={loading || refreshing || saving || replacing || passwordDirty || totpDirty}
              title={passwordDirty || totpDirty ? "请先保存当前修改" : "重新读取凭据"}
              aria-label="重新读取凭据"
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} disabled={saving || replacing} title="关闭">
              <X size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="credential-loading"><LoaderCircle className="spin" size={18} />正在读取凭据</div>
        ) : (
          <>
            <div className="credential-field">
              <span>密码</span>
              <div className="secret-input-row">
                <KeyRound size={15} aria-hidden="true" />
                <input
                  aria-label="密码"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); setPasswordDirty(true); }}
                  placeholder={details?.passwordAvailable ? "凭据已保存" : details?.hasPassword ? "原文不可恢复，请重新录入" : "未保存密码"}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button type="button" className="secret-toggle" onClick={() => setShowPassword((value) => !value)} title={showPassword ? "隐藏密码" : "显示密码"}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {details?.hasPassword && !details?.passwordAvailable && (
              <div className="credential-warning credential-warning-block">
                该账号只保留了密码存在标记，旧版本没有保存密码原文。请重新录入并保存，之后即可查看。
              </div>
            )}
            <div className="credential-field">
              <span>2FA 密钥</span>
              <div className="secret-input-row">
                <ShieldCheck size={15} aria-hidden="true" />
                <input
                  aria-label="2FA 密钥"
                  type={showTotp ? "text" : "password"}
                  value={totpSecret}
                  onChange={(event) => { setTotpSecret(event.target.value); setTotpDirty(true); }}
                  placeholder={details?.totpSecretAvailable ? "密钥已保存" : details?.hasTotpKey ? "原文不可恢复，请重新录入" : "未保存 2FA 密钥"}
                  autoComplete="off"
                  spellCheck="false"
                  inputMode="text"
                />
                <button type="button" className="secret-toggle" onClick={() => setShowTotp((value) => !value)} title={showTotp ? "隐藏 2FA 密钥" : "显示 2FA 密钥"}>
                  {showTotp ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {details?.hasTotpKey && !details?.totpSecretAvailable && (
              <div className="credential-warning credential-warning-block">
                该账号只保留了 2FA 存在标记，旧版本没有保存密钥原文。请重新录入并保存，之后即可生成动态验证码。
              </div>
            )}
            <section className="totp-code-panel" aria-labelledby="totp-code-title">
              <div className="totp-code-heading">
                <div>
                  <strong id="totp-code-title">当前动态验证码</strong>
                  <span>每 30 秒自动更新</span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={copyTotpCode}
                  disabled={!totpCode}
                  title="复制动态验证码"
                  aria-label="复制动态验证码"
                >
                  <Copy size={16} />
                </button>
              </div>
              {totpCode ? (
                <div className="totp-code-value" aria-live="polite">
                  <code>{totpCode}</code>
                  <span className="totp-code-countdown">{totpSeconds} 秒后更新</span>
                </div>
              ) : totpCodeError ? (
                <div className="credential-warning credential-warning-block">{totpCodeError}</div>
              ) : (
                <div className="credential-json-empty">保存可读取的 2FA 密钥后，这里会显示动态验证码</div>
              )}
              <div className="totp-code-progress" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, (totpSeconds / 30) * 100))}%` }} />
              </div>
            </section>
            <section className="credential-json-section" aria-labelledby="sub2api-json-title">
              <div className="credential-json-heading">
                <div>
                  <strong id="sub2api-json-title">Sub2API JSON</strong>
                  <span>完整内容已放在可滚动区域中</span>
                </div>
                <button type="button" className="icon-button" onClick={copySub2apiJson} disabled={!sub2apiJson} title="复制 Sub2API JSON" aria-label="复制 Sub2API JSON">
                  <Copy size={16} />
                </button>
              </div>
              {sub2apiJson ? (
                <pre className="credential-json-viewer" tabIndex="0">{sub2apiJson}</pre>
              ) : (
                <div className="credential-json-empty">当前任务还没有可用的 Sub2API 导入 JSON</div>
              )}
            </section>
            <div className="credential-meta">
              <span>当前状态：{job.status}</span>
              {details?.persisted === false && <span className="credential-warning">系统未提供持久凭据存储</span>}
            </div>
            {job.totpRotationIncomplete && (
              <div className="credential-warning credential-warning-block">上次 2FA 轮换未完成：远端旧密钥状态可能已变化，请重试完成轮换后再继续登录。</div>
            )}
            {dialogError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{dialogError}</div>}
            {notice && <div className="credential-notice" role="status"><Check size={15} />{notice}</div>}
            <div className="dialog-actions credential-dialog-actions">
              {totpReplaceAvailable && job.canReplaceTotp && (
                <button type="button" className="danger-button" onClick={replaceTotp} disabled={saving || replacing}>
                  {replacing ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}轮换 2FA
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={onClose} disabled={saving || replacing}>关闭</button>
              <button type="submit" className="primary-button" disabled={loading || saving || replacing || (!passwordDirty && !totpDirty)}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存凭据
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function SessionDialog({ token, job, onClose, onError }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadSessions({ initial = false } = {}) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/sessions`);
      setDevices(data.sessions?.devices || []);
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setDialogError("");
    apiFetch(token, `/api/jobs/${job.id}/sessions`)
      .then((data) => {
        if (!stopped) setDevices(data.sessions?.devices || []);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [job.id, token]);

  async function logoutDevice(device) {
    if (device.isCurrentDevice) {
      setDialogError("当前设备不能在这里单独登出，请使用一键登出");
      return;
    }
    const label = device.description || device.displayName || "该设备";
    if (!window.confirm(`确定登出 ${label} 吗？`)) return;
    setAction(device.id);
    setDialogError("");
    setNotice("");
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sessions/logout`, {
        method: "POST",
        body: JSON.stringify(device.sessionId
          ? { sessionId: device.sessionId }
          : { deviceIdHash: device.deviceIdHash }),
      });
      setDevices((current) => current.filter((item) => item.id !== device.id));
      setNotice("设备已登出");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  async function logoutAll() {
    if (!window.confirm("确定登出该账号的所有设备和会话吗？当前会话也会失效，需要重新登录。")) return;
    setAction("all");
    setDialogError("");
    setNotice("");
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sessions/logout-all`, { method: "POST" });
      setDevices([]);
      setNotice("已提交全部设备登出请求，服务端可能需要几分钟完成传播");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !action) onClose();
    }}>
      <section className="batch-dialog session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title">
        <div className="dialog-header">
          <div>
            <h2 id="session-dialog-title">已登录设备与会话</h2>
            <span>{job.email}</span>
          </div>
          <div className="dialog-header-actions">
            <button type="button" className="icon-button" onClick={() => loadSessions()} disabled={loading || refreshing || Boolean(action)} title="刷新设备列表" aria-label="刷新设备列表">
              <RefreshCw className={refreshing ? "spin" : ""} size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} disabled={Boolean(action)} title="关闭">
              <X size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="credential-loading"><LoaderCircle className="spin" size={18} />正在读取设备和会话</div>
        ) : devices.length ? (
          <div className="session-list" aria-live="polite">
            {devices.map((device) => (
              <article className="session-item" key={device.id}>
                <div className="session-item-icon" aria-hidden="true"><MonitorSmartphone size={19} /></div>
                <div className="session-item-main">
                  <div className="session-item-heading">
                    <strong>{device.description || device.displayName}</strong>
                    {device.isCurrentDevice && <span className="session-badge current">当前会话</span>}
                    {!device.isCurrentDevice && device.isTrustedDevice && <span className="session-badge trusted">可信设备</span>}
                  </div>
                  <div className="session-item-meta">
                    {device.description && device.displayName !== device.description && <span>{device.displayName}</span>}
                    {formatSessionLocation(device) && <span>{formatSessionLocation(device)}</span>}
                    {device.lastSignedInTimestamp && <time dateTime={new Date(device.lastSignedInTimestamp * 1000).toISOString()}>最近登录 {formatDateTime(new Date(device.lastSignedInTimestamp * 1000).toISOString())}</time>}
                  </div>
                  {device.appSessions?.length > 0 && (
                    <div className="session-apps">应用：{device.appSessions.join("、")}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="icon-button danger session-logout-button"
                  onClick={() => logoutDevice(device)}
                  disabled={Boolean(action) || device.isCurrentDevice || (!device.sessionId && !device.deviceIdHash)}
                  title={device.isCurrentDevice ? "当前会话请使用一键登出" : "登出该设备"}
                  aria-label={`登出 ${device.displayName || "设备"}`}
                >
                  {action === device.id ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="session-empty"><MonitorSmartphone size={24} /><strong>没有可显示的设备或会话</strong><span>账号可能刚刚完成登出，刷新后会重新读取状态。</span></div>
        )}

        {dialogError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{dialogError}</div>}
        {notice && <div className="credential-notice" role="status"><Check size={15} />{notice}</div>}
        <div className="dialog-actions session-dialog-actions">
          <button type="button" className="danger-button" onClick={logoutAll} disabled={loading || Boolean(action)}>
            {action === "all" ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />}一键登出所有设备
          </button>
          <span className="dialog-actions-spacer" />
          <button type="button" className="cancel-button" onClick={onClose} disabled={Boolean(action)}>关闭</button>
        </div>
      </section>
    </div>
  );
}

function formatSessionLocation(device) {
  const parts = [device.lastSignedInCity, device.lastSignedInRegionCode, device.lastSignedInCountry]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(parts)].join(" · ");
}

function WorkspaceDialog({ token, job, planTypeMapping, onClose, onError, onJobUpdate, onWorkspaceSwitched }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadWorkspaces({ initial = false } = {}) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/workspaces`);
      setWorkspaces(data.workspaces?.workspaces || []);
      setCurrentWorkspaceId(data.workspaces?.currentWorkspaceId || null);
    } catch (error) {
      setDialogError(error.message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    apiFetch(token, `/api/jobs/${job.id}/workspaces`)
      .then((data) => {
        if (stopped) return;
        setWorkspaces(data.workspaces?.workspaces || []);
        setCurrentWorkspaceId(data.workspaces?.currentWorkspaceId || null);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => { stopped = true; };
  }, [job.id, token]);

  useEffect(() => {
    if (job.lastOperationType !== "workspace_switch" || job.status !== "completed") return;
    void loadWorkspaces();
  }, [job.lastOperationAt, job.lastOperationType, job.status]);

  async function switchWorkspace(workspace) {
    if (!workspace?.id || workspace.id === currentWorkspaceId || action) return;
    setAction(workspace.id);
    setDialogError("");
    setNotice("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/workspaces/switch`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      if (data.job) onJobUpdate(data.job);
      onWorkspaceSwitched?.();
      setCurrentWorkspaceId(workspace.id);
      setWorkspaces((current) => current.map((item) => ({ ...item, current: item.id === workspace.id })));
      if (data.sub2api?.error) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新；号池同步失败：${data.sub2api.error}`);
      } else if (data.sub2api?.statusRefreshError) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，号池中 ${data.sub2api.updated || 0} 条凭据已更新，但状态刷新失败：${data.sub2api.statusRefreshError}`);
      } else if (data.sub2api?.updated) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新，号池中 ${data.sub2api.updated} 条凭据已原地同步。`);
      } else if (data.sub2api?.configured) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新；号池中没有找到同邮箱账号。`);
      } else {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已同步更新。`);
      }
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !action) onClose();
    }}>
      <section className="batch-dialog workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
        <div className="dialog-header">
          <div>
            <h2 id="workspace-dialog-title">工作空间</h2>
            <span>{job.email}</span>
          </div>
          <div className="dialog-header-actions">
            <button type="button" className="icon-button" onClick={() => loadWorkspaces()} disabled={loading || refreshing || Boolean(action)} title="刷新工作空间" aria-label="刷新工作空间">
              <RefreshCw className={refreshing ? "spin" : ""} size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} disabled={Boolean(action)} title="关闭">
              <X size={18} />
            </button>
          </div>
        </div>
        {loading ? (
          <div className="credential-loading"><LoaderCircle className="spin" size={18} />正在读取工作空间</div>
        ) : workspaces.length ? (
          <div className="workspace-list" aria-live="polite">
            {workspaces.map((workspace) => {
              const selected = workspace.id === currentWorkspaceId;
              const disabled = workspace.canAccess === false || workspace.deactivated;
              return (
                <button
                  type="button"
                  className={`workspace-item ${selected ? "selected" : ""}`}
                  key={workspace.id}
                  onClick={() => switchWorkspace(workspace)}
                  disabled={disabled || selected || Boolean(action)}
                >
                  <span className="workspace-item-icon" aria-hidden="true"><BriefcaseBusiness size={18} /></span>
                  <span className="workspace-item-main">
                    <span className="workspace-item-heading">
                      <strong>{workspace.name || workspace.id}</strong>
                      {workspace.structure === "personal" && <span className="workspace-badge personal">个人</span>}
                      {selected && <span className="workspace-badge current">当前</span>}
                      {disabled && <span className="workspace-badge disabled">不可用</span>}
                    </span>
                    <span className="workspace-item-meta">
                      <span>{formatPlanTypeLabel(workspace.planType, planTypeMapping)}</span>
                      <code>{workspace.id}</code>
                    </span>
                  </span>
                  <span className="workspace-item-action">{action === workspace.id ? <LoaderCircle className="spin" size={16} /> : selected ? "当前" : "切换"}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="workspace-empty"><BriefcaseBusiness size={24} /><strong>没有可用的工作空间</strong><span>该账号当前没有返回可切换的个人或组织空间。</span></div>
        )}
        {dialogError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{dialogError}</div>}
        {notice && <div className="credential-notice" role="status"><Check size={15} />{notice}</div>}
        <div className="dialog-actions workspace-dialog-actions">
          <span className="dialog-actions-spacer" />
          <button type="button" className="cancel-button" onClick={onClose} disabled={Boolean(action)}>关闭</button>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    queued: ["排队中", <LoaderCircle size={14} />],
    starting: ["启动中", <LoaderCircle className="spin" size={14} />],
    working: ["处理中", <LoaderCircle className="spin" size={14} />],
    password: ["待密码", <KeyRound size={14} />],
    mfa_otp: ["待 2FA", <ShieldCheck size={14} />],
    totp_starting: ["准备 2FA", <LoaderCircle className="spin" size={14} />],
    password_add_starting: ["准备密码", <LoaderCircle className="spin" size={14} />],
    totp_setup_otp: ["激活 2FA", <ShieldCheck size={14} />],
    email_otp: ["待邮箱码", <Mail size={14} />],
    phone: ["待手机号", <Smartphone size={14} />],
    phone_otp: ["待手机码", <Smartphone size={14} />],
    finalizing: ["生成中", <LoaderCircle className="spin" size={14} />],
    refreshing: ["刷新授权", <RefreshCw className="spin" size={14} />],
    completed: ["已完成", <Check size={14} />],
    failed: ["失败", <CircleAlert size={14} />],
    canceled: ["已取消", <Ban size={14} />],
    reauth_required: ["待重新授权", <RefreshCw size={14} />],
    resume_available: ["可继续", <RotateCcw size={14} />],
  }[status] || [status, null];
  return <span className={`status-badge ${status}`}>{config[1]}{config[0]}</span>;
}

function AccountUsageCell({ usage, available, enabled, onRefresh }) {
  if (!enabled) {
    return <span className="usage-state muted" title="服务端尚未启用 Sub2API 用量同步">未启用</span>;
  }
  if (!available) {
    return <span className="usage-state muted">待授权</span>;
  }
  if (!usage || usage.status === "loading") {
    return <span className="usage-state muted">查询中...</span>;
  }
  if (usage.status === "error") {
    return (
      <button type="button" className="usage-retry" onClick={onRefresh} title={usage.error || "重新读取 Sub2API 用量"}>
        <RefreshCw size={13} />重试
      </button>
    );
  }
  const primary = usage.primary;
  const secondary = usage.secondary;
  const credits = usage.credits;
  const tokens = usage.tokens;
  const billing = usage.billing;
  const reset = usage.reset;
  const points = usage.points;
  if (!primary && !secondary && !credits && !tokens && !billing && !reset && !points && usage.allowed === null && usage.limitReached === null) {
    return (
      <span className="usage-empty">
        <span className="usage-state muted">暂无数据</span>
        {onRefresh && <button type="button" className="usage-refresh-icon" onClick={onRefresh} title="从 Sub2API 同步用量" aria-label="从 Sub2API 同步用量"><RefreshCw size={13} /></button>}
      </span>
    );
  }
  const restricted = usage.limitReached === true || usage.allowed === false || credits?.overageLimitReached === true;
  const windows = [
    { key: "primary", label: usageWindowLabel("5h", primary), value: primary, stats: primary?.stats || tokens?.byWindow?.primary },
    { key: "secondary", label: usageWindowLabel("7d", secondary), value: secondary, stats: secondary?.stats || tokens?.byWindow?.secondary },
  ].filter((item) => item.value);
  const detailItems = [
    credits && (credits.unlimited === true || credits.balance !== null)
      ? {
          label: "额度",
          value: credits.unlimited === true ? "无限" : `余额 ${formatUsageCount(credits.balance)}`,
          title: credits.unlimited === true ? "Sub2API 额度：无限" : `Sub2API 额度余额：${credits.balance}`,
          tone: credits.overageLimitReached === true ? "danger" : "",
        }
      : null,
    tokens ? { label: "Token", value: formatUsageTokenSummary(tokens), title: formatUsageTokenDetails(tokens) } : null,
    billing ? { label: "计费", value: formatUsageBillingSummary(billing), title: formatUsageBillingDetails(billing) } : null,
    reset ? { label: "重置卡", value: formatUsageResetSummary(reset), title: formatUsageResetDetails(reset) } : null,
    points ? { label: "点数", value: formatUsagePointsSummary(points), title: formatUsagePointsDetails(points) } : null,
  ].filter(Boolean);
  const statusLabel = restricted ? "受限" : usage.allowed === true ? "可用" : "已读取";
  return (
    <div className={`account-usage ${restricted ? "restricted" : ""}`} title={usage.fetchedAt ? `Sub2API 同步于 ${formatDateTime(usage.fetchedAt)}` : "Sub2API 用量"}>
      <div className="usage-head-row">
        <span className="usage-state"><span className="usage-state-dot" aria-hidden="true" />{statusLabel}</span>
        {usage.fetchedAt && <span className="usage-updated-at">{formatUsageUpdatedAt(usage.fetchedAt)}</span>}
        {onRefresh && <button type="button" className="usage-refresh-icon" onClick={onRefresh} title="从 Sub2API 同步用量" aria-label="从 Sub2API 同步用量"><RefreshCw size={13} /></button>}
      </div>
      {windows.length > 0 && <div className="usage-window-list">{windows.map((item) => <UsageWindowProgress key={item.key} tone={item.key} label={item.label} window={item.value} stats={item.stats} />)}</div>}
      {detailItems.length > 0 && <div className="usage-detail-grid">{detailItems.map((item) => <UsageDetailsCard key={item.label} {...item} />)}</div>}
    </div>
  );
}

function UsageDetailsCard({ label, value, title, tone = "" }) {
  if (!value) return null;
  return (
    <div className={`usage-detail-card ${tone}`} title={title || value}>
      <span className="usage-detail-label">{label}</span>
      <strong className="usage-detail-value">{value}</strong>
    </div>
  );
}

function formatUsageCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function formatUsageTokenSummary(tokens) {
  const parts = [];
  if (tokens.total !== null) parts.push(`总 ${formatUsageCount(tokens.total)}`);
  if (tokens.input !== null) parts.push(`入 ${formatUsageCount(tokens.input)}`);
  if (tokens.output !== null) parts.push(`出 ${formatUsageCount(tokens.output)}`);
  if (tokens.cached !== null) parts.push(`缓存 ${formatUsageCount(tokens.cached)}`);
  if (parts.length) return parts.join(" · ");
  return tokens.requests !== null ? `${formatUsageCount(tokens.requests)} 次请求` : "已同步";
}

function formatUsageTokenDetails(tokens) {
  const parts = [];
  if (tokens.total !== null) parts.push(`总量 ${formatUsageCount(tokens.total)}`);
  if (tokens.input !== null) parts.push(`输入 ${formatUsageCount(tokens.input)}`);
  if (tokens.output !== null) parts.push(`输出 ${formatUsageCount(tokens.output)}`);
  if (tokens.cached !== null) parts.push(`缓存 ${formatUsageCount(tokens.cached)}`);
  if (tokens.requests !== null) parts.push(`请求 ${formatUsageCount(tokens.requests)}`);
  return parts.join("，") || "Token 已同步";
}

function formatUsageBillingSummary(billing) {
  const parts = [];
  if (billing.cost !== null) parts.push(`A${formatUsageMoney(billing.cost, billing.currency)}`);
  if (billing.standardCost !== null) parts.push(`S${formatUsageMoney(billing.standardCost, billing.currency)}`);
  if (billing.userCost !== null) parts.push(`U${formatUsageMoney(billing.userCost, billing.currency)}`);
  return parts.join(" · ") || "已同步";
}

function formatUsageBillingDetails(billing) {
  const parts = [];
  if (billing.cost !== null) parts.push(`账号费用 ${formatUsageMoney(billing.cost, billing.currency)}`);
  if (billing.standardCost !== null) parts.push(`标准费用 ${formatUsageMoney(billing.standardCost, billing.currency)}`);
  if (billing.userCost !== null) parts.push(`用户费用 ${formatUsageMoney(billing.userCost, billing.currency)}`);
  if (billing.periodStart) parts.push(`开始 ${formatDateTime(billing.periodStart)}`);
  if (billing.periodEnd) parts.push(`结束 ${formatDateTime(billing.periodEnd)}`);
  return parts.join("，") || "计费数据已同步";
}

function formatUsageMoney(value, currency = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const prefix = currency ? `${currency} ` : "$";
  return `${prefix}${number.toFixed(4)}`;
}

function formatUsageResetSummary(reset) {
  const count = reset.available === null ? null : `${formatUsageCount(reset.available)} 张`;
  const next = reset.credits?.find((credit) => credit.expiresAt)?.expiresAt || reset.resetAt;
  if (count && next) return `${count} · ${formatUsageResetAt(next)}`;
  if (count) return count;
  return next ? `下次 ${formatUsageResetAt(next)}` : "已同步";
}

function formatUsageResetDetails(reset) {
  const parts = [];
  if (reset.available !== null) parts.push(`可用 ${formatUsageCount(reset.available)} 张`);
  if (reset.credits?.length) parts.push(`最近到期 ${formatUsageResetAt(reset.credits[0].expiresAt)}`);
  if (reset.resetAt) parts.push(`窗口 ${formatUsageResetAt(reset.resetAt)}`);
  return parts.join("，") || "重置卡数据已同步";
}

function formatUsagePointsSummary(points) {
  if (points.unlimited === true) return "无限";
  if (points.balance !== null) return formatUsageCount(points.balance);
  if (points.total !== null) return formatUsageCount(points.total);
  if (points.items?.length) return `${formatUsageCount(points.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0))}`;
  return "已同步";
}

function formatUsagePointsDetails(points) {
  const parts = [];
  if (points.balance !== null) parts.push(`余额 ${formatUsageCount(points.balance)}`);
  if (points.total !== null) parts.push(`总量 ${formatUsageCount(points.total)}`);
  if (points.items?.length) parts.push(points.items.map((item) => `${item.type || "点数"} ${formatUsageCount(item.amount)}`).join("、"));
  return parts.join("，") || "点数数据已同步";
}

function formatUsageUpdatedAt(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "已同步";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}小时前`;
}

function UsageWindowProgress({ tone, label, window, stats: statsOverride = null }) {
  const percent = usageWindowPercent(window);
  const percentText = percent === null ? "—" : `${Math.round(percent)}%`;
  const resetText = formatUsageReset(window);
  const stats = statsOverride || window?.stats;
  const statItems = [
    stats?.requests !== null && stats?.requests !== undefined ? `${formatUsageCount(stats.requests)} req` : null,
    stats?.tokens !== null && stats?.tokens !== undefined ? `${formatUsageCount(stats.tokens)} Token` : null,
    stats?.cost !== null && stats?.cost !== undefined ? `A ${formatUsageMoney(stats.cost)}` : null,
    stats?.standardCost !== null && stats?.standardCost !== undefined ? `S ${formatUsageMoney(stats.standardCost)}` : null,
    stats?.userCost !== null && stats?.userCost !== undefined ? `U ${formatUsageMoney(stats.userCost)}` : null,
  ].filter(Boolean);
  return (
    <div className="usage-window-block" title={`${label}窗口${percent === null ? "暂无百分比" : `已用 ${percentText}`}${resetText ? `，${resetText}` : ""}`}>
      <span className={`usage-window-label ${tone}`}>{label}</span>
      <div
        className={`usage-progress ${percent === null ? "empty" : percent >= 100 ? "critical" : percent >= 80 ? "warning" : ""}`}
        role="progressbar"
        aria-label={`${label}窗口用量`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
      >
        <span style={{ width: percent === null ? "0%" : `${percent}%` }} />
      </div>
      <strong className="usage-window-percent">{percentText}</strong>
      {resetText && <span className="usage-window-reset">{resetText}</span>}
      {statItems.length > 0 && <div className="usage-window-stats">{statItems.map((item) => <span key={item}>{item}</span>)}</div>}
    </div>
  );
}

function usageWindowPercent(window) {
  const direct = Number(window?.usedPercent);
  if (Number.isFinite(direct)) return Math.min(100, Math.max(0, direct));
  const used = Number(window?.used);
  const limit = Number(window?.limit);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return Math.min(100, Math.max(0, (used / limit) * 100));
  }
  const remaining = Number(window?.remaining);
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
  }
  return null;
}

function usageWindowLabel(fallback, window) {
  const seconds = Number(window?.limitWindowSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

function formatUsageReset(window) {
  if (window?.resetAt) return `${formatUsageResetAt(window.resetAt)}重置`;
  if (Number.isFinite(Number(window?.resetAfterSeconds))) {
    return `${formatUsageDuration(window.resetAfterSeconds)}后重置`;
  }
  return "";
}

function formatUsageDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}秒`;
  if (value < 3600) return `${Math.floor(value / 60)}分`;
  if (value < 86_400) return `${Math.floor(value / 3600)}小时`;
  return `${Math.floor(value / 86_400)}天`;
}

function formatUsageResetAt(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "待重置";
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds <= 0) return "现在";
  return seconds <= 86_400 ? `${formatUsageDuration(seconds)}后` : formatDateTime(value);
}

function Sub2ApiPoolBadge({ inPool }) {
  const state = inPool === true ? "added" : inPool === false ? "not-added" : "unknown";
  const label = inPool === true ? "已加入" : inPool === false ? "未加入" : "未同步";
  return <span className={`pool-badge ${state}`}>{label}</span>;
}

function Sub2ApiEnabledToggle({ inPool, enabled, available, busy, onChange }) {
  if (inPool !== true) {
    return <span className="pool-state-muted">{inPool === false ? "未加入号池" : "未同步"}</span>;
  }
  const known = typeof enabled === "boolean";
  const disabled = !available || !known || busy;
  return (
    <button
      type="button"
      role="switch"
      className={`status-toggle ${enabled === true ? "on" : ""}`}
      aria-checked={enabled === true}
      aria-label={known ? (enabled ? "停用号池账号" : "启用号池账号") : "号池启用状态未知"}
      title={!available ? "请先配置 Sub2API" : known ? (enabled ? "点击停用" : "点击启用") : "正在同步号池状态"}
      disabled={disabled}
      onClick={() => onChange?.(!enabled)}
    >
      <span className="status-toggle-track"><span className="status-toggle-thumb">{busy ? <LoaderCircle className="spin" size={11} /> : null}</span></span>
      <span className="status-toggle-label">{busy ? "更新中" : known ? (enabled ? "启用" : "停用") : "未知"}</span>
    </button>
  );
}

function LoginMethodBadge({ job }) {
  if (job.loginMode === "password") {
    const methods = ["密码", job.autoEmailOtp ? "自动收码" : "", job.hasTotpKey ? "2FA" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <KeyRound size={12} />}
        {methods.join(" + ")}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={12} /> : <MailCheck size={12} />}
        {job.hasTotpKey ? "自动收码 + 2FA" : "自动收码"}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={12} />旧任务资料未记录
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={12} />邮箱码 + 2FA
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: "输入账号密码", submitLabel: "提交密码", inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: "6 位 2FA 验证码", submitLabel: "提交 2FA 验证码", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: "新 2FA 的 6 位验证码", submitLabel: "激活新的 2FA", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: "6 位邮箱验证码", submitLabel: "提交邮箱验证码", inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: "发送手机验证码", inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? `${currentPhone} 的验证码` : "手机验证码", submitLabel: "提交手机验证码", inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function smsStatusText(job) {
  const providerName = job.smsProviderName || "接码平台";
  if (job.smsError) return `${providerName}：${job.smsError}`;
  return {
    requesting: `${providerName}：正在获取手机号`,
    number_acquired: `${providerName}：已获取手机号，正在发送验证码`,
    waiting_sms: `${providerName}：验证码已发送，正在等待短信`,
    submitting: `${providerName}：已收到验证码，正在自动提交`,
    submitted: `${providerName}：验证码已自动提交`,
    manual_submitted: `${providerName}：已停止自动读取，正在验证手动输入的验证码`,
    completed: `${providerName}：手机验证已通过，订单已完成`,
  }[job.smsStatus] || `${providerName}：处理中`;
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return "号池巡检已完成";
  const parts = [`检查 ${Number(result.checked || 0)} 条异常记录`];
  if (result.started) parts.push(`已启动自动修复 ${result.started} 条`);
  if (result.updated) parts.push(`已更新 ${result.updated} 条`);
  if (result.planTypeUpdated) parts.push(`已按订阅方案更新 ${result.planTypeUpdated} 条`);
  if (result.planTypeSkipped) parts.push(`订阅方案未绑定 ${result.planTypeSkipped} 条`);
  if (result.planTypeUpdateFailed) parts.push(`订阅方案更新失败 ${result.planTypeUpdateFailed} 条`);
  if (result.planTypeScanIncomplete) parts.push("订阅扫描不完整，已保留上次基线");
  if (result.blocked) parts.push(`永久跳过 ${result.blocked} 条`);
  if (result.ineligible) parts.push(`需人工 ${result.ineligible} 条`);
  if (result.missingTask) parts.push(`本地无任务 ${result.missingTask} 条`);
  if (result.busy) parts.push(`正在运行 ${result.busy} 条`);
  if (result.cooldown) parts.push(`冷却中 ${result.cooldown} 条`);
  return parts.join("，");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚检查";
  if (elapsed < 60_000) return "刚刚检查";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前检查`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前检查`;
}

async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function copyText(value) {
  const text = String(value ?? "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

function shortId(id) {
  return `任务 ${id.slice(0, 8)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function operationLabel(type) {
  return ({
    initial_authorization: "首次授权",
    reauthorize: "重新授权",
    relogin: "重新登录并授权",
    automatic_relogin: "号池自动重登并授权",
    resume: "继续中断流程",
    setup_2fa: "设置 2FA",
    replace_2fa: "更换 2FA",
    add_password: "添加密码",
    account_update: "更新账号资料",
    proxy_update: "更新代理 IP",
  })[type] || "账号操作";
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一个筛选邮箱");
  if (lines.length > 500) throw new Error("一次最多筛选 500 个邮箱");
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    }
  });
  return [...new Set(lines)];
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

function readLocalSetting(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function normalizeTotpForDisplay(secret) {
  let value = String(secret || "").trim();
  if (/^otpauth:\/\//i.test(value)) {
    try {
      value = new URL(value).searchParams.get("secret") || "";
    } catch {
      return "";
    }
  }
  const normalized = value.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized) ? normalized : "";
}

function decodeTotpBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const output = [];
  let buffer = 0;
  let bits = 0;
  for (const character of secret) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("2FA 密钥不是有效的 Base32 格式");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

async function generateTotpCode(secret, timestamp = Date.now()) {
  const normalized = normalizeTotpForDisplay(secret);
  if (!normalized) throw new Error("2FA 密钥不是有效的 Base32 格式");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前浏览器不支持生成动态验证码");
  const keyBytes = decodeTotpBase32(normalized);
  const counter = Math.floor(Number(timestamp) / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const counterView = new DataView(counterBytes);
  counterView.setUint32(0, Math.floor(counter / 0x100000000));
  counterView.setUint32(4, counter >>> 0);
  const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await subtle.sign("HMAC", key, counterBytes));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function normalizePlanTypeMapping(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  Object.entries(source).slice(0, 100).forEach(([raw, label]) => {
    const normalizedRaw = String(raw || "").trim();
    const normalizedLabel = String(label || "").trim();
    if (normalizedRaw && normalizedLabel && normalizedRaw.length <= 128 && normalizedLabel.length <= 128) {
      result[normalizedRaw] = normalizedLabel;
    }
  });
  return result;
}

function hasCustomPlanTypeMapping(value) {
  const mapping = normalizePlanTypeMapping(value);
  return Object.entries(mapping).some(([raw, label]) => DEFAULT_PLAN_TYPE_MAPPING[raw] !== label);
}

function readPlanTypeMapping() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PLAN_TYPE_MAPPING_STORAGE_KEY) || "null");
    const normalized = normalizePlanTypeMapping(stored);
    if (Object.keys(normalized).length) {
      const usageBasedLabel = normalized.self_serve_business_usage_based;
      if (usageBasedLabel && /business\s+pre(?:mium|nium)/i.test(usageBasedLabel)) {
        delete normalized.self_serve_business_usage_based;
      }
      return { ...DEFAULT_PLAN_TYPE_MAPPING, ...normalized };
    }
  } catch {}
  return { ...DEFAULT_PLAN_TYPE_MAPPING };
}

function planTypeMappingRows(mapping) {
  return Object.entries(normalizePlanTypeMapping(mapping)).map(([raw, label]) => ({ raw, label }));
}

function formatPlanTypeLabel(value, mapping = DEFAULT_PLAN_TYPE_MAPPING) {
  const raw = String(value || "").trim();
  if (!raw) return "未知";
  return normalizePlanTypeMapping(mapping)[raw] || raw;
}

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeMailRequestSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  let headersText = typeof stored.headersText === "string" ? stored.headersText : "";
  if (!headersText && stored.headers && typeof stored.headers === "object" && !Array.isArray(stored.headers)) {
    headersText = JSON.stringify(stored.headers, null, 2);
  }
  return {
    method: String(stored.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    url: typeof stored.url === "string" ? stored.url.trim() : "",
    headersText: headersText.trim() || "{}",
  };
}

function readMailRequestSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(MAIL_REQUEST_SETTINGS_KEY) || "null");
    return normalizeMailRequestSettings(stored);
  } catch {
    return normalizeMailRequestSettings({});
  }
}

function buildMailRequestConfig(settings) {
  const normalized = normalizeMailRequestSettings(settings);
  let headers;
  try {
    headers = JSON.parse(normalized.headersText || "{}");
  } catch {
    throw new Error("请求头必须是有效的 JSON 对象");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}");
  }
  if (normalized.method === "POST") {
    try {
      const parsedUrl = new URL(normalized.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      throw new Error("POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL");
    }
  }
  return {
    method: normalized.method,
    url: normalized.method === "POST" ? normalized.url : "",
    headers,
  };
}

function formatMailRequestSummary(settings) {
  try {
    const config = buildMailRequestConfig(settings);
    const headerCount = Object.keys(config.headers).length;
    return `${config.method === "POST" ? "已配置统一 URL · " : ""}${headerCount} 个请求头`;
  } catch {
    return "配置需要检查";
  }
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  const rawWsMode = stored.wsMode ?? stored.openaiWsMode ?? stored.openaiOAuthResponsesWebsocketsV2Mode;
  const wsMode = String(rawWsMode ?? "off").trim().toLowerCase();
  const legacyProfile = {
    id: "default",
    name: "默认方案",
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    accountNameTemplate: String(stored.accountNameTemplate || ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : "session",
    wsMode: SUB2API_WS_MODES.has(wsMode) ? wsMode : "off",
  };
  const rawProfiles = Array.isArray(stored.profiles) ? stored.profiles : [];
  const profiles = rawProfiles.length
    ? rawProfiles.map((profile, index) => normalizeSub2ApiProfile(profile, index, legacyProfile))
    : [legacyProfile];
  const activeProfileId = profiles.some((profile) => profile.id === String(stored.activeProfileId || ""))
    ? String(stored.activeProfileId)
    : profiles[0].id;
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
  const planTypeBindings = stored.planTypeBindings && typeof stored.planTypeBindings === "object"
    ? Object.fromEntries(Object.entries(stored.planTypeBindings)
      .map(([planType, profileId]) => [String(planType).trim(), String(profileId).trim()])
      .filter(([planType, profileId]) => planType && profiles.some((profile) => profile.id === profileId)))
    : {};
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    ...activeProfile,
    profiles,
    activeProfileId,
    planTypeBindings,
    hasStoredAdminApiKey: stored.hasStoredAdminApiKey === true,
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function normalizeSub2ApiProfile(value, index = 0, fallback = {}) {
  const stored = value && typeof value === "object" ? value : {};
  const fallbackProfile = fallback && typeof fallback === "object" ? fallback : {};
  const rawGroupIds = Array.isArray(stored.groupIds) ? stored.groupIds : fallbackProfile.groupIds || [];
  const rawProxyId = stored.proxyId ?? fallbackProfile.proxyId ?? "";
  const wsMode = String(stored.wsMode ?? fallbackProfile.wsMode ?? "off").trim().toLowerCase();
  return {
    id: String(stored.id || `profile-${index + 1}`).trim() || `profile-${index + 1}`,
    name: String(stored.name || `方案 ${index + 1}`),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: rawProxyId === 0 || String(rawProxyId).trim() === "0" ? "" : String(rawProxyId),
    concurrency: String(stored.concurrency ?? fallbackProfile.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? fallbackProfile.loadFactor ?? ""),
    priority: String(stored.priority ?? fallbackProfile.priority ?? ""),
    accountNameTemplate: String(stored.accountNameTemplate ?? fallbackProfile.accountNameTemplate ?? ""),
    modelWhitelist: String(stored.modelWhitelist ?? fallbackProfile.modelWhitelist ?? ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : fallbackProfile.codexFingerprintMode || "session",
    wsMode: SUB2API_WS_MODES.has(wsMode) ? wsMode : "off",
  };
}

function hasUsableSub2ApiSettings(settings) {
  return Boolean(settings?.baseUrl && (settings.adminApiKey || settings.hasStoredAdminApiKey));
}

function mergeServerSub2ApiSettings(current, serverState) {
  const serverConfig = serverState?.config && typeof serverState.config === "object"
    ? serverState.config
    : {};
  const serverHasSettingsState = typeof serverState?.hasAdminApiKey === "boolean"
    || serverState?.config !== undefined;
  const hasStoredAdminApiKey = serverHasSettingsState
    ? serverState?.hasAdminApiKey === true
    : current.hasStoredAdminApiKey === true;
  const serverProfiles = Array.isArray(serverState?.profiles)
    ? serverState.profiles
    : undefined;
  const serverPlanTypeBindings = serverState?.planTypeBindings
    && typeof serverState.planTypeBindings === "object"
    && !Array.isArray(serverState.planTypeBindings)
    ? serverState.planTypeBindings
    : undefined;
  return normalizeSub2ApiSettings({
    ...current,
    ...serverConfig,
    ...(typeof serverState?.baseUrl === "string" ? { baseUrl: serverState.baseUrl } : {}),
    ...(serverProfiles ? { profiles: serverProfiles } : {}),
    ...(serverPlanTypeBindings ? { planTypeBindings: serverPlanTypeBindings } : {}),
    ...(typeof serverState?.activeProfileId === "string" ? { activeProfileId: serverState.activeProfileId } : {}),
    adminApiKey: serverHasSettingsState ? "" : (hasStoredAdminApiKey ? "" : current.adminApiKey),
    hasStoredAdminApiKey,
    monitorEnabled: serverState?.monitorEnabled !== undefined
      ? serverState.monitorEnabled === true
      : serverState?.enabled !== undefined
        ? serverState.enabled === true
        : current.monitorEnabled,
  });
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : "地址未知";
  const ip = String(proxy.ipAddress || "").trim();
  return `${proxy.name || `代理 ${proxy.id}`} | ${endpoint}${ip ? ` | 出口 IP：${ip}` : ""}`;
}

function formatSub2ApiGroupPlatform(platform) {
  const value = String(platform || "").trim().toLowerCase();
  return value === "composite" ? "Composite" : value === "openai" ? "OpenAI" : value || "未知平台";
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "custom"
    ? (customEntries?.count ? `${customEntries.count} 个号码` : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => config[field.summaryKey || field.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: definition?.name || "",
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: "请粘贴至少一条手机号和接码 API" };
  if (lines.length > 500) return { count: 0, error: "自定义接码一次最多导入 500 条" };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: `第 ${index + 1} 行格式错误，请使用 手机号----接码API` };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: `第 ${index + 1} 行手机号必须使用 +861871291167 这种国际格式` };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: `第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址` };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  if (option.iso && REGION_NAMES) {
    try {
      return REGION_NAMES.of(option.iso) || option.title;
    } catch {}
  }
  return option.title || `国家 ${option.country}`;
}

function formatSmsPriceOption(option) {
  const name = formatSmsCountryName(option);
  return `${name} | 价格 ${option.price} | 库存 ${option.count}`;
}

function writeLocalJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    window.localStorage.setItem(key, String(value || ""));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function sub2ApiStatusJobFields(status) {
  const fields = {
    sub2apiInPool: status?.inPool ?? null,
    sub2apiEnabled: status?.enabled ?? null,
    sub2apiPriority: status?.priority ?? null,
    sub2apiAccountId: status?.accountId || null,
    sub2apiAccountIds: Array.isArray(status?.accountIds) ? status.accountIds : [],
    sub2apiGroupIds: Array.isArray(status?.groupIds) ? status.groupIds : [],
    sub2apiRemoteStatus: status?.remoteStatus || null,
    sub2apiUsage: status?.usage || null,
    // Keep the remote PlanType separate from the local account/workspace
    // PlanType. A workspace switch updates the local OAuth bundle first, while
    // Sub2API may still be serving its previous snapshot until the account
    // update completes. Overwriting `planType` here caused the table to
    // oscillate on every 15-second status refresh.
    sub2apiPlanType: String(status?.sub2apiPlanType || status?.planType || "").trim() || null,
  };
  return fields;
}

function mergeSub2ApiStatusIntoJob(job, state) {
  if (!state?.fetchedAt) return job;
  const key = String(job.email || "").toLowerCase();
  const status = state.accounts?.[key];
  if (!status) return { ...job, ...sub2ApiStatusJobFields({ inPool: false }), sub2apiPlanType: null };
  const fields = sub2ApiStatusJobFields(status);
  // `planType` is the account's currently selected workspace and is supplied
  // by the completed local OAuth output. Only use the remote value as a
  // fallback for legacy jobs that never persisted a local PlanType.
  const localPlanType = String(job.workspacePlanType || job.planType || "").trim();
  if (!localPlanType && fields.sub2apiPlanType) fields.planType = fields.sub2apiPlanType;
  return { ...job, ...fields };
}

function mergeJobs(...groups) {
  const unique = new Map();
  groups.flat().forEach((job) => {
    if (!unique.has(job.id)) unique.set(job.id, job);
  });
  return [...unique.values()];
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
appRoot.render(<App />);
