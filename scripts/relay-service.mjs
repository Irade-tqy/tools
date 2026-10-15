#!/usr/bin/env node
// Run the DeepSeek relay as a user service on this machine.
//
//   node scripts/relay-service.mjs install     # write the unit, enable + start
//   node scripts/relay-service.mjs start|stop|restart|status|logs [--lines 50]
//   node scripts/relay-service.mjs uninstall
//
// Why a service here at all: the browser queues a turn with deepseek_ask() and reads the
// answer out of deepseek_chunk, so the relay only needs outbound HTTPS — it does not have to
// be reachable. That makes this box a real production relay: a warm backup to the Edge Function
// (same protocol, supabase/functions/deepseek-chat, deployed to functions/v1/deepseek-chat).
// deepseek_health() counts whichever of them is heartbeating.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { env, rootDir } from './lib.mjs';

const UNIT = 'tools-relay';
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(UNIT_DIR, `${UNIT}.service`);
const LOG_PATH = join(rootDir, '.tmp', 'relay.log');
const NODE_BIN = process.execPath;
const WORKER_ID = (env.TOOLS_RELAY_ID || '').trim() || 'tools-box';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const systemctl = (...rest) => {
  try {
    const out = execFileSync('systemctl', ['--user', ...rest], { encoding: 'utf8' }).trim();
    return out;
  } catch (err) {
    const out = [(err.stdout && String(err.stdout).trim()), (err.stderr && String(err.stderr).trim())].filter(Boolean).join('\n');
    return out || `systemctl --user ${rest.join(' ')} failed: ${err.message}`;
  }
};

function unitFile() {
  // PATH matters: node must be findable and the log must land in the repo's .tmp/.
  const pathDir = dirname(NODE_BIN);
  return `[Unit]
Description=tools DeepSeek relay (claims the queue, calls the upstream, writes chunks)
Documentation=https://github.com/Irade-tqy/tools
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${rootDir}
ExecStart=${NODE_BIN} scripts/deepseek-worker.mjs --worker-id ${WORKER_ID}
Restart=always
RestartSec=3
# the relay is a background niceness, not a foreground service
Nice=10
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}
Environment=PATH=${pathDir}:/usr/local/bin:/usr/bin:/bin
Environment=NODE_NO_WARNINGS=1

[Install]
WantedBy=default.target
`;
}

function install() {
  mkdirSync(UNIT_DIR, { recursive: true });
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const before = existsSync(UNIT_PATH) ? readFileSync(UNIT_PATH, 'utf8') : '';
  const next = unitFile();
  if (before !== next) writeFileSync(UNIT_PATH, next);
  console.log(`${before === next ? 'unchanged' : 'wrote'} ${UNIT_PATH}`);
  console.log(`worker id: ${WORKER_ID}   log: ${LOG_PATH}`);
  console.log(systemctl('daemon-reload'));
  console.log(systemctl('enable', '--now', `${UNIT}.service`) || 'enabled + started');
  // Linger keeps the user manager (and the relay) alive after the last login session exits.
  try {
    execFileSync('loginctl', ['enable-linger', String(process.getuid())], { stdio: 'pipe' });
    console.log('linger enabled — the relay survives logout');
  } catch {
    console.log('note: loginctl enable-linger failed — the relay stops when this login session ends');
  }
  console.log('\n' + systemctl('status', `${UNIT}.service`, '--no-pager', '-n', '6'));
}

switch (cmd) {
  case 'install':
    install();
    break;
  case 'uninstall':
    console.log(systemctl('disable', '--now', `${UNIT}.service`));
    try {
      rmSync(UNIT_PATH);
      console.log(`removed ${UNIT_PATH}`);
    } catch {
      console.log('unit file was not there');
    }
    systemctl('daemon-reload');
    break;
  case 'start':
  case 'stop':
  case 'restart':
    console.log(systemctl(cmd, `${UNIT}.service`) || `${cmd}: done`);
    break;
  case 'logs': {
    const lines = flagValue('--lines', '40');
    if (!existsSync(LOG_PATH)) {
      console.log(`no log yet at ${LOG_PATH}`);
      break;
    }
    console.log(readFileSync(LOG_PATH, 'utf8').split('\n').slice(-Number(lines)).join('\n'));
    break;
  }
  case 'status': {
    console.log(systemctl('status', `${UNIT}.service`, '--no-pager', '-n', '10'));
    break;
  }
  default:
    console.log(`usage: ${process.argv[1]} install|uninstall|start|stop|restart|status|logs [--lines N]`);
    process.exit(2);
}
