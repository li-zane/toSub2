import assert from "node:assert/strict";
import { identifyWebPlan } from "../src/protocol-login.mjs";

let token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "team" } })).toString("base64url")}.signature`;
let payload = { accounts: { personal: { account: { account_id: "personal", plan_type: "free" } }, team: { account: { account_id: "team", plan_type: "self_serve_business_prolite" } } } };
const client = { async getJson(method, url, options) {
  if (url.endsWith("/api/auth/session")) return { data: { accessToken: token } };
  assert.equal(options.headers.authorization, `Bearer ${token}`);
  return { data: payload };
} };
assert.deepEqual(await identifyWebPlan(client, { chatgptBase: "http://fixture" }), { planType: "self_serve_business_prolite", workspaceId: "team" });
assert.deepEqual(await identifyWebPlan(client, { chatgptBase: "http://fixture", web: { workspaceId: "personal" } }), { planType: "free", workspaceId: "personal" });
token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "team", plan_type: "self_serve_business_usage_based" } })).toString("base64url")}.signature`;
assert.equal((await identifyWebPlan(client, { chatgptBase: "http://fixture" })).planType, "self_serve_business_usage_based", "same workspace uses the precise token PlanType, as the OAuth export does");
assert.equal((await identifyWebPlan(client, { chatgptBase: "http://fixture", web: { workspaceId: "personal" } })).planType, "free", "another workspace never inherits the token's plan");
payload.accounts.team.account.is_deactivated = true;
await assert.rejects(identifyWebPlan(client, { chatgptBase: "http://fixture" }), /WEB_PLAN_UNAVAILABLE/);
payload = { accounts: [{ id: "only", plan_type: "plus" }] };
assert.equal((await identifyWebPlan(client, { chatgptBase: "http://fixture" })).planType, "plus");
await assert.rejects(identifyWebPlan(client, { chatgptBase: "http://fixture", web: { workspaceId: "missing" } }), /WEB_PLAN_UNAVAILABLE/);
payload = { accounts: [{ id: "first", plan_type: "plus" }, { id: "other", plan_type: "free" }] };
await assert.rejects(identifyWebPlan(client, { chatgptBase: "http://fixture" }), /WEB_PLAN_UNAVAILABLE/);
payload = { accounts: [{ id: "only" }] };
await assert.rejects(identifyWebPlan(client, { chatgptBase: "http://fixture" }), /WEB_PLAN_UNAVAILABLE/);
console.log("PASS: web PlanType identity uses selected workspace, JWT account, object/array responses and rejects ambiguous, inactive or missing plans");
