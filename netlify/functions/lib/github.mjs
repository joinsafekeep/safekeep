// The few GitHub REST calls the alert job needs: read files from main, and open a pull request with one new file.
// GITHUB_TOKEN is a fine-grained token for joinsafekeep/safekeep with Contents and Pull requests set to read/write.
export function github({ token, repo = 'joinsafekeep/safekeep', fetcher = globalThis.fetch }) {
 const call = async (path, init = {}) => {
  const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'safekeep-alerts', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
 };
 return {
  async read(path, ref = 'main') {
   const file = await call(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
   return file?.content ? Buffer.from(file.content, 'base64').toString('utf8') : null;
  },
  async list(path, ref = 'main') { return (await call(`/contents/${path}?ref=${encodeURIComponent(ref)}`)) || []; },
  async openPullRequest({ branch, path, content, message, title, body, base = 'main' }) {
   const head = await call(`/git/ref/heads/${base}`);
   if (!head) throw new Error(`No ${base} branch`);
   const exists = await call(`/git/ref/heads/${branch}`);
   if (!exists) await call('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }) });
   const current = await call(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
   await call(`/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message, branch, content: Buffer.from(content).toString('base64'), ...(current?.sha ? { sha: current.sha } : {}) }) });
   const open = await call(`/pulls?head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&state=open`);
   if (open?.length) return open[0].html_url;
   const pr = await call('/pulls', { method: 'POST', body: JSON.stringify({ title, head: branch, base, body, draft: false }) });
   return pr.html_url;
  }
 };
}
