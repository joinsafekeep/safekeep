// Wednesday morning (10:30 UTC): start the weekly practice scam drafting job. It runs as a background function
// because drafting takes longer than a scheduled function's 30 seconds; the shared secret keeps anyone else out.
export async function startGenerateJob({ env = process.env, fetcher = globalThis.fetch } = {}) {
 if (!env.ALERTS_JOB_SECRET) return { skipped: 'ALERTS_JOB_SECRET is not set' };
 const site = (env.URL || env.APP_ORIGIN || 'https://joinsafekeep.com').replace(/\/$/, '');
 const response = await fetcher(`${site}/.netlify/functions/practice-generate-background`, { method: 'POST', headers: { 'x-safekeep-job': env.ALERTS_JOB_SECRET } });
 return { started: response.status === 202, status: response.status };
}
export default async () => {
 const result = await startGenerateJob();
 console.log('generate', JSON.stringify(result));
 return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
export const config = { schedule: '30 10 * * 3' };
