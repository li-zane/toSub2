import assert from "node:assert/strict";
import { normalizeSessionDevice, normalizeSessionDevices } from "../src/account-sessions.mjs";

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
