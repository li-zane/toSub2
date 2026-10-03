import assert from "node:assert/strict";
import {
  normalizeAccountWorkspaces,
  normalizeSessionDevice,
  normalizeSessionDevices,
} from "../src/account-sessions.mjs";

const workspaceListing = normalizeAccountWorkspaces({
  default_account_id: "workspace-available",
  accounts: [
    {
      id: "workspace-available",
      name: "可用空间",
      structure: "workspace",
      status: "active",
      can_access_with_session: true,
    },
    {
      id: "workspace-removed",
      name: "被移出空间",
      structure: "workspace",
      can_access_with_session: false,
      error: { code: "account_removed_from_workspace", message: "You were removed from this workspace" },
    },
    {
      id: "workspace-banned",
      name: "被封禁空间",
      structure: "workspace",
      can_access_with_session: false,
      status_code: 402,
      error_message: "Workspace is unavailable",
    },
    {
      id: "workspace-deactivated",
      name: "停用空间",
      structure: "workspace",
      is_deactivated: true,
      error_code: "workspace_deactivated",
    },
    {
      id: "workspace-forbidden",
      name: "无权空间",
      structure: "workspace",
      can_access_with_session: false,
      error: { code: "forbidden", message: "Access denied" },
    },
  ],
});

assert.equal(workspaceListing.workspaces[0].availabilityReason, "available");
assert.equal(workspaceListing.workspaces[0].availabilityLabel, "");
assert.equal(workspaceListing.workspaces[1].availabilityReason, "removed");
assert.equal(workspaceListing.workspaces[1].availabilityCode, "account_removed_from_workspace");
assert.equal(workspaceListing.workspaces[1].availabilityLabel, "已移出空间（account_removed_from_workspace）");
assert.equal(workspaceListing.workspaces[2].availabilityReason, "banned");
assert.equal(workspaceListing.workspaces[2].availabilityCode, "402");
assert.equal(workspaceListing.workspaces[2].availabilityLabel, "空间封禁（402）");
assert.equal(workspaceListing.workspaces[3].availabilityReason, "deactivated");
assert.equal(workspaceListing.workspaces[4].availabilityReason, "inaccessible");
assert.equal(workspaceListing.workspaces[4].availabilityCode, "forbidden");
assert.equal(workspaceListing.workspaces[4].canAccess, false);

const staleCredentialListing = normalizeAccountWorkspaces({
  default_account_id: "workspace-available",
  accounts: [
    { id: "workspace-available", structure: "workspace", can_access_with_session: true },
    { id: "personal-account", structure: "personal", can_access_with_session: true },
  ],
}, "authsess_stale");
assert.equal(staleCredentialListing.currentWorkspaceId, "workspace-available");
assert.equal(staleCredentialListing.workspaces.find((item) => item.id === "workspace-available").current, true);
assert.equal(staleCredentialListing.workspaces.find((item) => item.id === "personal-account").current, false);

const devices = normalizeSessionDevices({
  show_session_manager: true,
  devices: [
    {
      render_id: "render-current",
      session_id: "us_current",
      display_name: "Mac",
      human_readable_description: "Mac · macOS 10.15.7",
      platform: "macos",
      os_version: "10.15.7",
      device_model: "Mac",
      is_current_device: true,
      is_trusted_device: false,
      can_untrust: false,
      last_signed_in_timestamp_second: 1_790_000_000,
      last_signed_in_city: "Los Angeles",
      last_signed_in_region_code: "CA",
      last_signed_in_country: "US",
      app_sessions: [{ client_name: "Codex" }, { client_name: "ChatGPT Web" }],
    },
    {
      render_id: "render-trusted",
      hashed_device_id: "device-hash",
      display_name: "Phone",
      human_readable_description: "Android phone",
      is_current_device: false,
      is_trusted_device: true,
      can_untrust: true,
    },
    { display_name: "ignored without an identifier" },
  ],
});

assert.equal(devices.length, 2);
assert.deepEqual(devices[0], {
  id: "render-current",
  sessionId: "us_current",
  deviceIdHash: null,
  displayName: "Mac",
  description: "Mac · macOS 10.15.7",
  platform: "macos",
  osVersion: "10.15.7",
  deviceModel: "Mac",
  isTrustedDevice: false,
  isCurrentDevice: true,
  canUntrust: false,
  lastSignedInTimestamp: 1_790_000_000,
  lastSignedInCity: "Los Angeles",
  lastSignedInRegionCode: "CA",
  lastSignedInCountry: "US",
  appSessions: ["Codex", "ChatGPT Web"],
});
assert.equal(devices[1].sessionId, null);
assert.equal(devices[1].deviceIdHash, "device-hash");
assert.equal(normalizeSessionDevice(null), null);
assert.equal(normalizeSessionDevice({ session_id: "" }), null);
console.log("account session normalization smoke passed");
