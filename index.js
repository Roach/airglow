#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const { Server }               = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// ── Brightness scaling ────────────────────────────────────────────────────────
const maxBrightness = parseInt(process.env.HUE_MAX_BRIGHTNESS ?? '60', 10) / 100;
const scaleBri = pct => Math.max(1, Math.round(pct * maxBrightness));

// ── Status → plain Hue v1 state objects ──────────────────────────────────────
const STATUS_STATES = {
  idle:       () => ({ on: true,  bri: scaleBri(40),  ct: 370,  transitiontime: 10 }),
  thinking:   () => ({ on: true,  bri: scaleBri(60),  hue: 40108, sat: 203, transitiontime: 5 }),
  working:    () => ({ on: true,  bri: scaleBri(75),  hue: 36408, sat: 152, transitiontime: 5 }),
  building:   () => ({ on: true,  bri: scaleBri(80),  hue: 6380,  sat: 229, transitiontime: 5 }),
  waiting:    () => ({ on: true,  bri: scaleBri(50),  hue: 49151, sat: 178, transitiontime: 10 }),
  success:    () => ({ on: true,  bri: scaleBri(80),  hue: 21845, sat: 229, transitiontime: 3 }),
  deployed:   () => ({ on: true,  bri: scaleBri(70),  hue: 30838, sat: 203, transitiontime: 5 }),
  error:      () => ({ on: true,  bri: scaleBri(100), hue: 0,     sat: 254, transitiontime: 2 }),
  alert:      () => ({ on: true,  bri: scaleBri(100), hue: 0,     sat: 254, alert: 'lselect' }),
  pulse_once: () => ({ on: true,  alert: 'select' }),
  off:        () => ({ on: false }),
};

// ── Single HTTP helper (v1 or v2 CLIP API) ───────────────────────────────────
const agent = new https.Agent({ rejectUnauthorized: false });

function hueReq(method, apiPath, body = null, v2 = false) {
  const ip       = process.env.HUE_BRIDGE_IP;
  const username = process.env.HUE_USERNAME;
  if (!ip || !username) return Promise.reject(new Error('Bridge not configured. Call setup() to get started.'));
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = v2
      ? { 'hue-application-key': username, ...(data && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) }
      : (data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {});
    const req = https.request({
      hostname: ip,
      path: v2 ? `/clip/v2${apiPath}` : `/api/${username}${apiPath}`,
      method,
      headers,
      agent,
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON from bridge')); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Convenience wrappers ──────────────────────────────────────────────────────
const v1Get  = p       => hueReq('GET',  p);
const v1Post = (p, b)  => hueReq('POST', p, b);
const v1Put  = (p, b)  => hueReq('PUT',  p, b);
const v2Get  = p       => hueReq('GET',  p, null, true);
const v2Put  = (p, b)  => hueReq('PUT',  p, b,    true);

// ── Color helpers ─────────────────────────────────────────────────────────────
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    switch (max) {
      case r: h = ((g - b) / d % 6) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
    if (h < 0) h += 1;
  }
  return { h: h * 360, sv: max === 0 ? 0 : d / max, v: max };
}

// Build a Hue v1 light state object from MCP tool arguments
function buildState(a) {
  const s = {};
  if (a.on !== undefined)         s.on  = a.on;
  if (a.brightness !== undefined) s.bri = Math.max(1, Math.round(a.brightness / 100 * 254));
  if (a.color_temp !== undefined) s.ct  = a.color_temp;
  if (a.rgb) {
    const { h, sv, v } = rgbToHsv(a.rgb.r, a.rgb.g, a.rgb.b);
    s.hue = Math.round(h  / 360 * 65535);
    s.sat = Math.round(sv * 254);
    if (a.brightness === undefined) s.bri = Math.max(1, Math.round(v * 254));
  }
  if (a.hsl) {
    s.hue = Math.round(a.hsl.h / 360 * 65535);
    s.sat = Math.round(a.hsl.s / 100 * 254);
    if (a.brightness === undefined) s.bri = Math.max(1, Math.round(a.hsl.l / 100 * 254));
  }
  if (a.alert)          s.alert          = a.alert;
  if (a.transition_ms !== undefined) s.transitiontime = Math.round(a.transition_ms / 100);
  return s;
}

// ── Build v1→v2 light ID map (for effects) ────────────────────────────────────
async function buildV1ToV2Map() {
  const map = new Map();
  try {
    const result = await v2Get('/resource/light');
    for (const l of (result.data ?? [])) {
      const m = l.id_v1?.match(/^\/lights\/(\d+)$/);
      if (m) map.set(parseInt(m[1], 10), l.id);
    }
  } catch { /* v2 unavailable */ }
  return map;
}

// ── Suggest best hook light based on name ─────────────────────────────────────
function suggestHookLight(lights) {
  const kws = ['desk', 'office', 'monitor', 'computer', 'claude', 'work', 'hue go'];
  for (const kw of kws) {
    const m = lights.find(l => l.name.toLowerCase().includes(kw));
    if (m) return m;
  }
  return lights[0] ?? null;
}

// ── Discover bridges via meethue N-UPnP ───────────────────────────────────────
function discoverBridges() {
  return new Promise((resolve, reject) => {
    https.get('https://discovery.meethue.com/', res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

// ── Create bridge user (link button must be pressed first) ────────────────────
function registerUser(ip) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ devicetype: 'airglow#claude' });
    const req = https.request({
      hostname: ip, path: '/api', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      agent,
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Shared JSON schemas ────────────────────────────────────────────────────────
const RGB_SCHEMA = {
  type: 'object',
  properties: { r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' } },
  description: 'RGB color (each 0–255)',
};
const HSL_SCHEMA = {
  type: 'object',
  properties: {
    h: { type: 'number', description: '0–359' },
    s: { type: 'number', description: '0–100' },
    l: { type: 'number', description: '0–100' },
  },
};
const LIGHT_CONTROL_PROPS = {
  on:            { type: 'boolean' },
  brightness:    { type: 'number', description: '0–100 percent' },
  color_temp:    { type: 'number', description: 'Color temperature: 153 (cool) to 500 (warm)' },
  rgb:           RGB_SCHEMA,
  hsl:           HSL_SCHEMA,
  alert:         { type: 'string', enum: ['none', 'select', 'lselect'], description: 'Flash: select=single, lselect=15s cycle' },
  transition_ms: { type: 'number', description: 'Transition time in milliseconds' },
};

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'setup',
    description: 'Smart onboarding tool. Checks configuration state, auto-discovers the bridge if needed, lists lights and zones for selection, and returns the exact next step required. Always call this first if you are unsure whether the bridge is configured.',
    inputSchema: {
      type: 'object',
      properties: {
        default_group: { type: 'number', description: 'Set the default zone/room group ID for status colors. Pass 0 to use all lights.' },
        hook_light_id: { type: 'number', description: 'Light ID to animate during Claude Code sessions. Call setup() first to see available lights and the suggested default.' },
      },
    },
  },
  {
    name: 'discover_bridge',
    description: 'Discover Philips Hue bridges on the local network via N-UPnP.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_user',
    description: 'Register a new user on the Hue bridge. Press the physical link button first, then call this within 30 seconds.',
    inputSchema: {
      type: 'object', required: ['bridge_ip'],
      properties: { bridge_ip: { type: 'string', description: 'IP address of the Hue bridge' } },
    },
  },
  {
    name: 'get_lights',
    description: 'List lights on the bridge with their current state. Filterable by room, on/off state, or color capability.',
    inputSchema: {
      type: 'object',
      properties: {
        room:       { type: 'string',  description: 'Filter by room or zone name (case-insensitive).' },
        on:         { type: 'boolean', description: 'Filter by on/off state.' },
        color_only: { type: 'boolean', description: 'Only return color-capable lights.' },
      },
    },
  },
  {
    name: 'get_groups',
    description: 'List all groups and rooms on the bridge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_scenes',
    description: 'List all saved scenes on the bridge.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_light',
    description: 'Control an individual light — on/off, brightness (0–100%), color temp, RGB, HSL, flash alert, transition time.',
    inputSchema: {
      type: 'object', required: ['light_id'],
      properties: { light_id: { type: 'number', description: 'Light ID from get_lights' }, ...LIGHT_CONTROL_PROPS },
    },
  },
  {
    name: 'set_group',
    description: 'Control all lights in a group/room simultaneously — same params as set_light.',
    inputSchema: {
      type: 'object', required: ['group_id'],
      properties: { group_id: { type: 'number', description: 'Group ID (0 = all lights). Use get_groups to list.' }, ...LIGHT_CONTROL_PROPS },
    },
  },
  {
    name: 'activate_scene',
    description: 'Activate a saved Hue scene by ID.',
    inputSchema: {
      type: 'object', required: ['scene_id', 'group_id'],
      properties: {
        scene_id: { type: 'string', description: 'Scene ID from get_scenes' },
        group_id: { type: 'number', description: 'Group ID the scene belongs to' },
      },
    },
  },
  {
    name: 'create_scene',
    description: 'Snapshot the current light state as a named scene. Captures a group or specific lights.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: {
        name:      { type: 'string', description: 'Name for the new scene' },
        group_id:  { type: 'number', description: 'Capture lights from this group. Defaults to HUE_DEFAULT_GROUP.' },
        light_ids: { type: 'array', items: { type: 'number' }, description: 'Capture specific lights by ID instead of a group.' },
      },
    },
  },
  {
    name: 'get_sensors',
    description: 'List all sensors — motion detectors, temperature, light level, buttons, and remotes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_effect',
    description: 'Apply a native Hue v2 animated effect to one or more lights. Use "no_effect" to clear.',
    inputSchema: {
      type: 'object', required: ['effect'],
      properties: {
        effect:   { type: 'string', enum: ['candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten', 'cosmos', 'no_effect'] },
        light_id: { type: 'number', description: 'Apply to a single light.' },
        group_id: { type: 'number', description: 'Apply to all lights in a group.' },
      },
    },
  },
  {
    name: 'get_dynamic_scenes',
    description: 'List animated smart scenes from the Hue v2 API — Candle, Fireplace, Colorloop, etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'activate_dynamic_scene',
    description: 'Activate a Hue smart scene with full animation. Use get_dynamic_scenes to find IDs.',
    inputSchema: {
      type: 'object', required: ['scene_id'],
      properties: {
        scene_id: { type: 'string', description: 'Smart scene UUID from get_dynamic_scenes' },
        speed:    { type: 'number', description: 'Animation speed 0.0–1.0 (optional)' },
      },
    },
  },
  {
    name: 'set_status',
    description: 'Set lights to a semantic status color — idle, thinking, working, building, waiting, success, deployed, error, alert, pulse_once, off.',
    inputSchema: {
      type: 'object', required: ['status'],
      properties: {
        status:   { type: 'string', enum: Object.keys(STATUS_STATES) },
        group_id: { type: 'number', description: 'Group to apply status to. Defaults to HUE_DEFAULT_GROUP.' },
        light_id: { type: 'number', description: 'Apply to a single light instead of a group.' },
      },
    },
  },
];

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'airglow', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args ?? {};

  try {
    switch (name) {

      case 'setup': {
        const ip       = process.env.HUE_BRIDGE_IP;
        const username = process.env.HUE_USERNAME;
        const envPath  = path.join(__dirname, '.env');

        // Save config params if provided
        if (a.default_group !== undefined || a.hook_light_id !== undefined) {
          let envContent = '';
          try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env yet */ }

          const parts = [];
          if (a.default_group !== undefined) {
            const g = a.default_group;
            envContent = envContent.includes('HUE_DEFAULT_GROUP=')
              ? envContent.replace(/HUE_DEFAULT_GROUP=.*/g, `HUE_DEFAULT_GROUP=${g}`)
              : envContent.trimEnd() + `\nHUE_DEFAULT_GROUP=${g}\n`;
            process.env.HUE_DEFAULT_GROUP = String(g);
            parts.push(`default zone → ${g === 0 ? 'all lights' : `group ${g}`}`);
          }
          if (a.hook_light_id !== undefined) {
            const lid = a.hook_light_id;
            envContent = envContent.includes('HUE_HOOK_LIGHT=')
              ? envContent.replace(/HUE_HOOK_LIGHT=.*/g, `HUE_HOOK_LIGHT=${lid}`)
              : envContent.trimEnd() + `\nHUE_HOOK_LIGHT=${lid}\n`;
            process.env.HUE_HOOK_LIGHT = String(lid);
            parts.push(`hook light → ${lid}`);
          }
          fs.writeFileSync(envPath, envContent);

          let msg = `Saved: ${parts.join(', ')}.\n\nSetup complete! Try: set_status({ status: "idle" })`;
          if (a.hook_light_id !== undefined) {
            const scriptPath = path.join(__dirname, 'hue-status.js');
            const hookConfig = {
              hooks: {
                UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${scriptPath} thinking` }] }],
                PreToolUse:       [{ hooks: [{ type: 'command', command: `node ${scriptPath} working` }] }],
                PostToolUse: [
                  { matcher: 'exit_plan_mode', hooks: [{ type: 'command', command: `node ${scriptPath} success` }] },
                  { hooks: [{ type: 'command', command: `node ${scriptPath} thinking` }] },
                ],
                Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: `node ${scriptPath} prompt` }] }],
                Stop: [{ hooks: [{ type: 'command', command: `node ${scriptPath} restore` }] }],
              },
            };
            msg += `\n\nAdd to your project's .claude/settings.json:\n\n${JSON.stringify(hookConfig, null, 2)}`;
          }
          return { content: [{ type: 'text', text: msg }] };
        }

        // Fully configured — verify connectivity
        if (ip && username) {
          try {
            const [lightsObj, groupsObj] = await Promise.all([v1Get('/lights'), v1Get('/groups')]);
            const lights = Object.entries(lightsObj).map(([id, l]) => ({ id: parseInt(id), ...l }));
            const groups = Object.entries(groupsObj).map(([id, g]) => ({ id: parseInt(id), ...g }));

            const defaultGroup = parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
            const hookLightId  = process.env.HUE_HOOK_LIGHT ? parseInt(process.env.HUE_HOOK_LIGHT, 10) : null;
            const zones     = groups.filter(g => ['Room', 'Zone', 'LightGroup'].includes(g.type));
            const zoneList  = zones.map(g => `  ${g.id}: ${g.name} (${g.type}, ${(g.lights ?? []).length} lights)`).join('\n');
            const suggested = suggestHookLight(lights);
            const lightList = lights.map(l =>
              `  ${l.id}: ${l.name} (${l.type})${suggested && l.id === suggested.id ? ' ← suggested for hooks' : ''}`
            ).join('\n');

            const needsGroup     = defaultGroup === 0;
            const needsHookLight = hookLightId === null;
            const params = [];
            if (needsGroup) params.push('default_group: <zone id or 0 for all>');
            if (needsHookLight && suggested) params.push(`hook_light_id: ${suggested.id}`);

            if (needsGroup || needsHookLight) {
              return { content: [{ type: 'text', text: `Connected to bridge at ${ip}. ${lights.length} lights found.\n\nAvailable lights:\n${lightList}\n\nAvailable zones/rooms:\n${zoneList}\n\nCall setup({ ${params.join(', ')} }) to finish setup.` }] };
            }

            const selected  = zones.find(g => g.id === defaultGroup);
            const hookLight = lights.find(l => l.id === hookLightId);
            return { content: [{ type: 'text', text: `Connected and fully configured.\nBridge: ${ip}\nLights: ${lights.length}\nDefault zone: ${defaultGroup}${selected ? ` — ${selected.name}` : ''}\nHook light: ${hookLightId}${hookLight ? ` — ${hookLight.name}` : ''}\n\nTry set_status({ status: "idle" }) or get_lights.` }] };
          } catch {
            return { content: [{ type: 'text', text: `HUE_BRIDGE_IP and HUE_USERNAME are set, but the bridge at ${ip} is unreachable or the credentials are invalid.\n\nCheck that the bridge is online, or call create_user({ bridge_ip: "${ip}" }) after pressing the link button.` }] };
          }
        }

        // Have IP, no username
        if (ip && !username) {
          return { content: [{ type: 'text', text: `Bridge IP configured (${ip}) but no username set.\n\n1. Press the link button on your Hue bridge.\n2. Within 30 seconds, call: create_user({ bridge_ip: "${ip}" })\n3. Set the returned username as HUE_USERNAME.` }] };
        }

        // Nothing configured — auto-discover
        try {
          const results = await discoverBridges();
          if (results && results.length > 0) {
            const foundIp = results[0].internalipaddress;
            const others  = results.slice(1).map(b => b.internalipaddress);
            const othersNote = others.length > 0 ? `\nOther bridges found: ${others.join(', ')}` : '';
            return { content: [{ type: 'text', text: `Bridge discovered at ${foundIp}.${othersNote}\n\n1. Press the link button on your Hue bridge.\n2. Within 30 seconds, call: create_user({ bridge_ip: "${foundIp}" })\n3. Set in your environment:\n   HUE_BRIDGE_IP=${foundIp}\n   HUE_USERNAME=<returned username>` }] };
          }
        } catch { /* discovery failed, fall through */ }

        return { content: [{ type: 'text', text: `No Hue bridges found on the network.\n\nTroubleshooting:\n- Make sure the bridge is on and connected via ethernet\n- Confirm this machine is on the same network\n\nIf you know the bridge IP: create_user({ bridge_ip: "x.x.x.x" }) after pressing the link button.` }] };
      }

      case 'discover_bridge': {
        const results = await discoverBridges();
        if (!results || results.length === 0) return { content: [{ type: 'text', text: 'No bridges found via N-UPnP.' }] };
        return { content: [{ type: 'text', text: JSON.stringify(results.map(b => ({ id: b.id, ip: b.internalipaddress })), null, 2) }] };
      }

      case 'create_user': {
        const resp = await registerUser(a.bridge_ip);
        const entry = resp[0];
        if (entry?.error) return { content: [{ type: 'text', text: `Error: ${entry.error.description}` }] };
        const username = entry?.success?.username;
        return { content: [{ type: 'text', text: `User created!\nUsername: ${username}\nSet HUE_BRIDGE_IP=${a.bridge_ip} and HUE_USERNAME=${username} in your .env file.` }] };
      }

      case 'get_lights': {
        const lightsObj = await v1Get('/lights');
        let lights = Object.entries(lightsObj).map(([id, l]) => ({ id: parseInt(id), ...l }));

        if (a.room) {
          const groupsObj = await v1Get('/groups');
          const room = Object.values(groupsObj).find(g => g.name.toLowerCase() === a.room.toLowerCase());
          if (room) { const ids = new Set(room.lights); lights = lights.filter(l => ids.has(String(l.id))); }
        }
        if (a.on !== undefined)  lights = lights.filter(l => l.state.on === a.on);
        if (a.color_only)        lights = lights.filter(l => ['Extended color light', 'Color light'].includes(l.type));

        return { content: [{ type: 'text', text: JSON.stringify(lights.map(l => ({
          id: l.id, name: l.name, type: l.type, on: l.state.on, brightness: l.state.bri, reachable: l.state.reachable, colorMode: l.state.colormode,
        })), null, 2) }] };
      }

      case 'get_groups': {
        const groupsObj = await v1Get('/groups');
        return { content: [{ type: 'text', text: JSON.stringify(
          Object.entries(groupsObj).map(([id, g]) => ({ id: parseInt(id), name: g.name, type: g.type, lights: g.lights })),
          null, 2) }] };
      }

      case 'get_scenes': {
        const scenesObj = await v1Get('/scenes');
        return { content: [{ type: 'text', text: JSON.stringify(
          Object.entries(scenesObj).map(([id, s]) => ({ id, name: s.name, group: s.group, lights: s.lights })),
          null, 2) }] };
      }

      case 'get_sensors': {
        const TYPE_LABEL = {
          ZLLPresence: 'motion', ZLLTemperature: 'temperature', ZLLLightLevel: 'light_level',
          ZLLSwitch: 'dimmer_switch', ZGPSwitch: 'tap_switch', ZLLRelativeRotary: 'rotary',
        };
        const sensorsObj = await v1Get('/sensors');
        return { content: [{ type: 'text', text: JSON.stringify(
          Object.entries(sensorsObj)
            .filter(([, s]) => TYPE_LABEL[s.type])
            .map(([id, s]) => ({ id: parseInt(id), name: s.name, type: TYPE_LABEL[s.type], state: s.state, reachable: s.config?.reachable ?? null })),
          null, 2) }] };
      }

      case 'set_light': {
        await v1Put(`/lights/${a.light_id}/state`, buildState(a));
        return { content: [{ type: 'text', text: `Light ${a.light_id} updated.` }] };
      }

      case 'set_group': {
        await v1Put(`/groups/${a.group_id}/action`, buildState(a));
        return { content: [{ type: 'text', text: `Group ${a.group_id} updated.` }] };
      }

      case 'activate_scene': {
        await v1Put(`/groups/${a.group_id}/action`, { scene: a.scene_id });
        return { content: [{ type: 'text', text: `Scene ${a.scene_id} activated on group ${a.group_id}.` }] };
      }

      case 'create_scene': {
        let lightIds;
        if (Array.isArray(a.light_ids) && a.light_ids.length > 0) {
          lightIds = a.light_ids.map(String);
        } else {
          const groupId = a.group_id ?? parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          if (groupId === 0) {
            const lightsObj = await v1Get('/lights');
            lightIds = Object.keys(lightsObj);
          } else {
            const group = await v1Get(`/groups/${groupId}`);
            lightIds = group.lights ?? [];
          }
        }
        const createResp = await v1Post('/scenes', { name: a.name, lights: lightIds, recycle: false });
        const sceneId = createResp[0]?.success?.id;
        if (!sceneId) return { content: [{ type: 'text', text: `Failed to create scene: ${JSON.stringify(createResp)}` }] };
        await v1Put(`/scenes/${sceneId}`, { storelightstate: true });
        return { content: [{ type: 'text', text: `Scene "${a.name}" created (ID: ${sceneId}) with ${lightIds.length} lights. Activate: activate_scene({ scene_id: "${sceneId}", group_id: <group> })` }] };
      }

      case 'set_effect': {
        const v1ToV2 = await buildV1ToV2Map();
        let v1Ids = [];
        if (a.light_id !== undefined) {
          v1Ids = [a.light_id];
        } else {
          const groupId = a.group_id ?? parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          if (groupId === 0) {
            const lightsObj = await v1Get('/lights');
            v1Ids = Object.keys(lightsObj).map(Number);
          } else {
            const group = await v1Get(`/groups/${groupId}`);
            v1Ids = (group.lights ?? []).map(Number);
          }
        }
        const results = [];
        for (const v1Id of v1Ids) {
          const v2Id = v1ToV2.get(v1Id);
          if (!v2Id) { results.push(`light ${v1Id}: no v2 ID, skipped`); continue; }
          const res = await v2Put(`/resource/light/${v2Id}`, { effects: { effect: a.effect } });
          results.push(res.errors?.length ? `light ${v1Id}: ${res.errors[0]?.description ?? 'error'}` : `light ${v1Id}: ${a.effect}`);
        }
        return { content: [{ type: 'text', text: results.join('\n') }] };
      }

      case 'get_dynamic_scenes': {
        const result = await v2Get('/resource/smart_scene');
        if (result.errors?.length) return { content: [{ type: 'text', text: `v2 API error: ${JSON.stringify(result.errors)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(
          (result.data ?? []).map(s => ({ id: s.id, name: s.metadata?.name ?? 'Unknown', group_id: s.group?.rid, speed: s.speed })),
          null, 2) }] };
      }

      case 'activate_dynamic_scene': {
        const body = { recall: { action: 'activate' } };
        if (a.speed !== undefined) body.speed = a.speed;
        const result = await v2Put(`/resource/smart_scene/${a.scene_id}`, body);
        if (result.errors?.length) return { content: [{ type: 'text', text: `v2 API error: ${JSON.stringify(result.errors)}` }] };
        return { content: [{ type: 'text', text: `Dynamic scene ${a.scene_id} activated.` }] };
      }

      case 'set_status': {
        const stateFn = STATUS_STATES[a.status];
        if (!stateFn) return { content: [{ type: 'text', text: `Unknown status: ${a.status}` }] };
        const state = stateFn();
        if (a.light_id !== undefined) {
          await v1Put(`/lights/${a.light_id}/state`, state);
          return { content: [{ type: 'text', text: `Light ${a.light_id} set to "${a.status}".` }] };
        } else {
          const groupId = a.group_id ?? parseInt(process.env.HUE_DEFAULT_GROUP ?? '0', 10);
          await v1Put(`/groups/${groupId}/action`, state);
          return { content: [{ type: 'text', text: `Group ${groupId} set to "${a.status}".` }] };
        }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('airglow MCP server running\n');
}

main().catch(err => { process.stderr.write(`Fatal: ${err.message}\n`); process.exit(1); });
