#!/usr/bin/env node
// Enable GitHub Pages (workflow build type) for this repo, and optionally push the branch.
// The workflow itself publishes dist/ with actions/deploy-pages.
//
//   node scripts/pages-deploy.mjs            # report Pages state (enable if missing)
//   node scripts/pages-deploy.mjs --workflow # switch an existing site to Actions builds
//   node scripts/pages-deploy.mjs --push     # …then git push origin <branch>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, ghRepo, rootDir } from './lib.mjs';

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

const apiCall = async (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

// api.github.com drops the TLS connection on us every so often, and a deploy script that dies
// with an ECONNRESET stack trace in front of the operator is a false alarm. Retry the transient
// ones, then fail with a sentence.
async function api(path, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await apiCall(path, init);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  console.error(`GitHub API unreachable after ${attempts} attempts: ${lastError?.message || lastError}`);
  process.exit(1);
}

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

let pages = await api(`/repos/${repo}/pages`);
const wantWorkflow = process.argv.includes('--workflow');
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
} else if (wantWorkflow) {
  // Switch an existing classic (branch-source) Pages site over to Actions builds.
  console.log('switching Pages to workflow builds …');
  pages = await api(`/repos/${repo}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ build_type: 'workflow' }),
  });
  if (!pages.ok) {
    const body = await pages.text();
    console.error(`switch failed: HTTP ${pages.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
}

// GitHub answers 204 (no body) for some of these calls, so re-read the settings instead of
// parsing the response body.
const fresh = await api(`/repos/${repo}/pages`);
const raw = await fresh.text();
let info = {};
try {
  info = raw ? JSON.parse(raw) : {};
} catch {
  info = {};
}
console.log(`pages url: ${info.html_url || '(unknown)'}  source: ${info.source?.build_type || info.build_type || 'classic'}  status: ${info.status || 'n/a'}`);
const workflowBuild = (info.source?.build_type || info.build_type) === 'workflow';
if (workflowBuild) {
  console.log('deploys now come from the “Deploy Pages” workflow (push to main or Actions → Run workflow)');
}

// --push used to be documented in the header but never implemented, so `npm run pages:deploy
// --push` reported the Pages state and left the commit local — the site kept serving the
// previous build. Push, then wait for the workflow that publishes it, because "deployed" is
// only true once the deployment job finishes.
if (process.argv.includes('--push')) {
  if (!workflowBuild) {
    console.log('pushing to origin …');
  }
  execFileSync('git', ['push', 'origin', `${branch}`], { stdio: 'inherit' });

  // Polling the workflow run by head_sha is unreliable: GitHub attributes the run to the newest
  // commit that touches non-ignored paths, so a script-only commit pushed alongside it leaves
  // the query waiting for a run that already finished under another sha. The artifact the CDN
  // serves cannot lie, so compare the live page against the entry file this checkout builds.
  const distIndex = join(rootDir, 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    console.log('building to know which bundle to expect …');
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  }
  const expected = readFileSync(distIndex, 'utf8').match(/assets\/index-[\w-]+\.js/)?.[0];
  if (!expected) {
    console.error('dist/index.html does not reference a hashed entry — run npm run build');
    process.exit(1);
  }

  if (!workflowBuild) process.exit(0);

  const site = (info.html_url || '').replace(/\/+$/, '');
  console.log(`waiting for ${site} to serve ${expected} …`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let served = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${site}/?deploycheck=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    served = res.ok ? (await res.text()).match(/assets\/index-[\w-]+\.js/)?.[0] || null : null;
    if (served === expected) break;
    if (served) console.log(`  still serving ${served}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }

  if (served !== expected) {
    console.error(`the live site never started serving ${expected} (last seen: ${served || 'nothing'})`);
    console.error('check Actions → Deploy Pages for a failed run');
    process.exit(1);
  }
  console.log(`published: ${site}/  (${expected})`);
}
