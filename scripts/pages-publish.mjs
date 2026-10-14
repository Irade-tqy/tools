#!/usr/bin/env node
// Publish dist/ to GitHub Pages without GitHub Actions.
//
// The repo's PAT has no "Workflows" permission, so the Actions workflow in
// .github/workflows/deploy.yml cannot be pushed yet. This script publishes the same
// build through classic Pages instead: dist/ is force-pushed to an orphan `gh-pages`
// branch and Pages is pointed at it.
//
//   node scripts/pages-publish.mjs [--build] [--message "…"]
//
// Once the PAT gains the Workflows permission, push .github/workflows and switch Pages to
// "GitHub Actions" in the dashboard; this script is then no longer needed.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { env, ghRepo } from './lib.mjs';

const token = (env.TOOLS_GH_TOKEN || '').trim();
const repo = ghRepo();
if (!token || !repo) {
  console.error('TOOLS_GH_TOKEN must be set in .env.local (and TOOLS_GH_REPO if there is no origin remote)');
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set(args);
const flagValue = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DIST = resolve(process.cwd(), 'dist');
const BRANCH = env.TOOLS_PAGES_BRANCH || 'gh-pages';
const AUTH_URL = `https://x-access-token:${token}@github.com/${repo}.git`;

if (flags.has('--build')) {
  console.log('building …');
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html not found — run `npm run build` or pass --build');
  process.exit(1);
}

const git = (cwd, ...gitArgs) =>
  execFileSync('git', gitArgs, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

const work = mkdtempSync(join(tmpdir(), 'tools-pages-'));
let published = false;

try {
  cpSync(DIST, work, { recursive: true });
  const message = flagValue('--message', `deploy ${git(process.cwd(), 'rev-parse', '--short', 'HEAD')}`);

  git(work, 'init', '-q');
  git(work, 'checkout', '-qb', BRANCH);
  git(work, 'config', 'user.name', 'tools-deploy');
  git(work, 'config', 'user.email', 'tools-deploy@localhost');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  git(work, 'push', '-f', AUTH_URL, `${BRANCH}:${BRANCH}`);
  published = true;
  console.log(`pushed dist/ to ${repo}@${BRANCH}`);
} catch (err) {
  const detail = err.stderr ? String(err.stderr).trim() : err.message;
  console.error(`publish failed: ${detail.slice(0, 400)}`);
  process.exit(1);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Enable / point Pages at the branch (idempotent).
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await res.text() };
};

let check = await api(`/repos/${repo}/pages`);
if (check.status === 404) {
  const created = await api(`/repos/${repo}/pages`, {
    method: 'POST',
    body: JSON.stringify({ source: { branch: BRANCH, path: '/' } }),
  });
  if (!created.status || created.status >= 300) {
    console.error(`enable Pages failed: HTTP ${created.status} ${created.body.slice(0, 200)}`);
    process.exit(1);
  }
  check = created;
  console.log(`enabled Pages from ${BRANCH}:/`);
} else if (check.status >= 300) {
  console.error(`cannot read Pages settings: HTTP ${check.status} ${check.body.slice(0, 200)}`);
  process.exit(1);
}

const info = JSON.parse(check.body);
console.log(`pages url: ${info.html_url}  (status ${info.status || 'building'})`);
if (published) console.log('give it ~30s to build, then open the URL');
