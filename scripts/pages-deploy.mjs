#!/usr/bin/env node
// Enable GitHub Pages (workflow build type) for this repo, and optionally push the branch.
// The workflow itself publishes dist/ with actions/deploy-pages.
//
//   node scripts/pages-deploy.mjs            # report Pages state (enable if missing)
//   node scripts/pages-deploy.mjs --workflow # switch an existing site to Actions builds
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
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  if (!workflowBuild) process.exit(0);

  console.log(`waiting for the Deploy Pages workflow to publish ${sha.slice(0, 7)} …`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let run = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const runs = await api(`/repos/${repo}/actions/workflows/deploy.yml/runs?head_sha=${sha}&per_page=1`);
    const body = await runs.json().catch(() => ({}));
    run = body?.workflow_runs?.[0];
    if (!run) continue;
    console.log(`  ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`);
    if (run.status === 'completed') break;
  }

  if (!run) {
    console.error('no Deploy Pages run appeared for this commit — check Actions → Deploy Pages');
    process.exit(1);
  }
  if (run.conclusion !== 'success') {
    console.error(`deploy ${run.conclusion}: ${run.html_url}`);
    process.exit(1);
  }
  console.log(`published: ${info.html_url || ''}`);
}
