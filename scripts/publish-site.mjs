import { cp, mkdir, readdir, rm } from 'node:fs/promises';
// Only website assets reach the CDN; backend source, tests and dependencies do not.
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const entry of await readdir('.')) {
 if (/\.(html|css|js|png|jpg|ico|svg|mp4|xml|txt)$/.test(entry) && entry !== 'README.txt') await cp(entry, `dist/${entry}`);
}
for (const folder of (await readdir('.')).filter(name => ['account','scam-alerts','og','terms','privacy'].includes(name))) await cp(folder, `dist/${folder}`, {recursive:true});
