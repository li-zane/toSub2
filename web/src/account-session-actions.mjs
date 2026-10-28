// Keep bulk logout bounded; one account failing must not interrupt the others.
export async function logoutAccountSessions(jobs, request, onProgress = () => {}) {
  const results = new Array(jobs.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      try {
        await request(`/api/jobs/${encodeURIComponent(job.id)}/sessions/logout-all`, { method: "POST" });
        results[index] = { job, ok: true };
      } catch (error) {
        results[index] = { job, ok: false, error: error?.message || "请求失败" };
      }
      onProgress(++completed, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return results;
}
