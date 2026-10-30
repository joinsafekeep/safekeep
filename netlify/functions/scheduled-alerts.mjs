// Monday morning (10:30 UTC, which is 6:30 ET in summer and 5:30 in winter): start the weekly alert job. Scheduled
// functions stop after 30 seconds, and drafting takes minutes, so this only starts alerts-draft-background, which
// can run for up to 15. The shared secret keeps anyone else from starting it.
export async function startAlertJob({ env = process.env, fetcher = globalThis.fetch, force = false } = {}) {
 if (!env.ALERTS_JOB_SECRET) return { skipped: 'ALERTS_JOB_SECRET is not set' };
 const site = (env.URL || env.APP_ORIGIN || 'https://joinsafekeep.com').replace(/\/$/, '');
 const response = await fetcher(`${site}/.netlify/functions/alerts-draft-background${force ? '?force=1' : ''}`, { method: 'POST', headers: { 'x-safekeep-job': env.ALERTS_JOB_SECRET } });
 return { started: response.status === 202, status: response.status };
}
export default async () => {
 const result = await startAlertJob();
 console.log('alerts', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '30 10 * * 1' };
