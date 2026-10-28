import assert from "node:assert/strict";
import { logoutAccountSessions } from "../web/src/account-session-actions.mjs";

const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `selected-${index}`, email: `selected-${index}@example.test` }));
const requests = [];
const progress = [];
let active = 0;
let peak = 0;
const results = await logoutAccountSessions(jobs, async (url, options) => {
  requests.push({ url, options });
  peak = Math.max(peak, ++active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes("selected-1/")) throw new Error("mock account failure");
  } finally {
    active--;
  }
}, (done, total) => progress.push([done, total]));
assert.equal(peak, 3);
assert.equal(requests.length, jobs.length);
assert.ok(requests.every(({ url, options }) => jobs.some((job) => url === `/api/jobs/${job.id}/sessions/logout-all`) && options.method === "POST"));
assert.deepEqual(results.map(({ job }) => job.id), jobs.map((job) => job.id));
assert.equal(results.filter(({ ok }) => ok).length, 7);
assert.equal(results[1].error, "mock account failure");
assert.deepEqual(progress, jobs.map((_, index) => [index + 1, jobs.length]));
assert.deepEqual(await logoutAccountSessions([], () => assert.fail("empty selection made request")), []);
await logoutAccountSessions([{ id: "id/with space" }], async (url) => {
  assert.equal(url, "/api/jobs/id%2Fwith%20space/sessions/logout-all");
});
console.log("account session bulk actions passed: selected-only, concurrency=3, partial failure, progress, empty selection, URL encoding");
