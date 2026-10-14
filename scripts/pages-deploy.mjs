#!/usr/bin/env node
// Enable GitHub Pages (workflow build type) for this repo, and optionally push the branch.
// The workflow itself publishes dist/ with actions/deploy-pages.
//
//   node scripts/pages-deploy.mjs            # enable Pages if needed, report the URL
//   node scripts/pages-deploy.mjs --push     # …then git push origin <branch>
import { execFileSync } from 'node:child_process';
import { env, ghRepo } from './lib.mjs';

const token = (env.TOOLS_GH_TOKEN || '').trim();
if (!token) {
  console.error('TOOLS_GH_TOKEN is not set in .env.local (fine-grained PAT: repo + pages write)');
  process.exit(1);
}

const repo = ghRepo();
if (!repo) {
  console.error('cannot determine the repo — set TOOLS_GH_REPO=owner/name');
  process.exit(1);
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

let pages = await api(`/repos/${repo}/pages`);
if (pages.status === 404) {
  console.log(`Pages is not enabled for ${repo} — enabling (workflow build)`);
  pages = await api(`/repos/${repo}/pages`, {
    method: 'POST',
    body: JSON.stringify({ build_type: 'workflow' }),
  });
  if (!pages.ok) {
    const body = await pages.text();
    console.error(`enable failed: HTTP ${pages.status} ${body.slice(0, 300)}`);
    console.error('fallback: Dashboard → Settings → Pages → Build and deployment → GitHub Actions');
    process.exit(1);
  }
} else if (pages.status === 403 || pages.status === 401) {
  const body = await pages.text();
  console.error(`token cannot manage Pages: HTTP ${pages.status} ${body.slice(0, 200)}`);
  console.error('grant the PAT "Pages: write" or enable Pages by hand: Settings → Pages → Source: GitHub Actions');
  process.exit(1);
}

const info = await pages.json();
console.log(`pages url: ${info.html_url}`);
console.log(`status:    ${info.status || 'n/a'}  (builds appear as the "github-pages" check)`);

if (new Set(process.argv.slice(2)).has('--push')) {
  console.log(`pushing ${branch} …`);
  execFileSync('git', ['push', 'origin', branch], { stdio: 'inherit' });
  console.log('watch the Actions run, then open the URL above');
}
