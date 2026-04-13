#!/usr/bin/env node
'use strict';

// ── Self-detach ───────────────────────────────────────────────────────────────
// Claude Code hooks block until the process exits. Detach immediately so the
// parent returns in <10ms; the actual work runs in a background child.
if (!process.env.HUE_DETACHED) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HUE_DETACHED: '1' },
  });
  child.unref();
  process.exit(0);
}

const path  = require('path');
const fs    = require('fs');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ip       = process.env.HUE_BRIDGE_IP;
const username = process.env.HUE_USERNAME;
const agent    = new https.Agent({ rejectUnauthorized: false });

const maxBrightness = parseInt(process.env.HUE_MAX_BRIGHTNESS || '60', 10);
const MAX_BRI = Math.max(1, Math.round(maxBrightness / 100 * 254));
const MIN_BRI = Math.max(1, Math.round(MAX_BRI * 0.55));
const IDLE_BRI = Math.max(1, Math.round(MAX_BRI * 0.4));

const STATUS_STATES = {
  idle:       { on: true,  bri: IDLE_BRI, ct: 370 },
  success:    { on: true,  bri: MAX_BRI,  hue: 21845, sat: 229 },
  deployed:   { on: true,  bri: Math.max(1, Math.round(MAX_BRI * 0.7)), hue: 30838, sat: 203 },
  building:   { on: true,  bri: MAX_BRI,  hue: 6380,  sat: 229 },
  waiting:    { on: true,  bri: Math.max(1, Math.round(MAX_BRI * 0.5)), hue: 49151, sat: 178 },
  error:      { on: true,  bri: MAX_BRI,  hue: 0,     sat: 254 },
  alert:      { on: true,  bri: MAX_BRI,  hue: 0,     sat: 254, alert: 'lselect' },
  pulse_once: { on: true,  alert: 'select' },
  off:        { on: false },
};

const PULSE_HUE = { thinking: 185, working: 300, prompt: 0 }; // cyan, magenta, red
const HALF_CYCLE_MS = 400;
const HTTP_TIMEOUT_MS = 3000;

const status   = process.argv[2];
const lightId  = parseInt(process.argv[3] || process.env.HUE_HOOK_LIGHT || '6', 10);
const pidFile  = `/tmp/hue-pulse-${lightId}.pid`;
const saveFile = `/tmp/hue-saved-${lightId}.json`;

function put(state) {
  const body = JSON.stringify({ ...state, transitiontime: state.transitiontime ?? 5 });
  const req = https.request({
    hostname: ip,
    path: `/api/${username}/lights/${lightId}/state`,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    agent,
  }, res => res.resume());
  req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy());
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function get(cb) {
  const req = https.get({ hostname: ip, path: `/api/${username}/lights/${lightId}`, agent }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => { try { cb(JSON.parse(data)); } catch { cb(null); } });
  });
  req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); cb(null); });
  req.on('error', () => cb(null));
}

function killPulse() {
  try { process.kill(parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10), 'SIGTERM'); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
}

// Pulse runs in-process: write own PID so the next hook invocation can kill us.
function startPulse(hueDeg, maxMs = 0) {
  fs.writeFileSync(pidFile, String(process.pid));
  process.on('SIGTERM', () => process.exit(0));

  if (maxMs > 0) setTimeout(() => {
    put({ on: true, bri: IDLE_BRI, ct: 370, transitiontime: 5 });
    setTimeout(() => process.exit(0), 600);
  }, maxMs);

  let bright = true;
  const pulse = () => {
    bright = !bright;
    put({ on: true, bri: bright ? MAX_BRI : MIN_BRI, hue: Math.round(hueDeg / 360 * 65535), sat: 254, transitiontime: 3 });
  };
  pulse();
  setInterval(pulse, HALF_CYCLE_MS);
}

// ── Main ──────────────────────────────────────────────────────────────────────

killPulse();

if (status === 'thinking') {
  if (fs.existsSync(saveFile)) {
    startPulse(PULSE_HUE.thinking);
  } else {
    get(light => {
      if (light?.state) {
        const s = light.state;
        const saved = { on: s.on, bri: s.bri };
        if (s.colormode === 'ct') saved.ct = s.ct;
        if (s.colormode === 'hs') { saved.hue = s.hue; saved.sat = s.sat; }
        if (s.colormode === 'xy') saved.xy = s.xy;
        try { fs.writeFileSync(saveFile, JSON.stringify(saved)); } catch {}
      }
      startPulse(PULSE_HUE.thinking);
    });
  }

} else if (status === 'restore') {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(saveFile, 'utf8')); } catch {}
  try { fs.unlinkSync(saveFile); } catch {}
  put(saved ?? STATUS_STATES.idle);

} else if (PULSE_HUE[status] !== undefined) {
  startPulse(PULSE_HUE[status], status === 'prompt' ? 30000 : 0);

} else if (STATUS_STATES[status]) {
  put(STATUS_STATES[status]);

} else {
  process.stderr.write(`Unknown status: ${status}. Valid: thinking, working, prompt, restore, ${Object.keys(STATUS_STATES).join(', ')}\n`);
  process.exit(1);
}
