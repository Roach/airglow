
```
        . * . * . * . * . * . * .
      *                           *
    .    _________________________    .
   *    |                         |    *
  .     |   * . * . * . * . * .   |     .
  *     |  .   A I R G L O W   .  |     *
  .     |   * . * . * . * . * .   |     .
  *     |  .   * . * . * . * .    |     *
   .    |_________________________|    .
    *                               *
      .    *   .   *   .   *   .   .
        * . * . * . * . * . * . * .
```

# airglow

**Watch Claude think.** A Philips Hue MCP server + Claude Code hooks that animate your lights in real time based on what Claude is doing — cyan while thinking, magenta while working, green on success, red on permission prompts. Every session, every tool call, every moment of focus: visible. Works even when your screen is locked or off — glance at the light to know if Claude needs your attention.

## Prerequisites

- Node.js 18 or later
- Philips Hue bridge (gen 2+) on your local network
- At least one color-capable Hue bulb

## Install

```bash
npm install
```

## Setup

The `setup` tool handles everything. Call it from Claude at any point — it checks your config and tells you exactly what to do next.

### 1. Add to Claude Code

Drop this into `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "hue": {
      "command": "node",
      "args": ["/path/to/airglow/index.js"]
    }
  }
}
```

### 2. Run guided setup

```
setup()
```

The tool will auto-discover your bridge, walk you through registering an API key (press the link button, call `create_user`), then list your lights and suggest one for animations — matched by name. Finish with one call:

```
setup({ default_group: 0, hook_light_id: 6 })
```

This saves everything to `.env` and returns a ready-to-paste hook block for your project's `.claude/settings.json`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HUE_BRIDGE_IP` | — | Bridge IP address |
| `HUE_USERNAME` | — | API key (from `create_user`) |
| `HUE_DEFAULT_GROUP` | `0` | Group ID for `set_status` (0 = all lights) |
| `HUE_HOOK_LIGHT` | — | Light ID for session animations |
| `HUE_MAX_BRIGHTNESS` | `60` | Brightness cap, 0–100% |

Copy `.env.example` to `.env` to configure manually, or let `setup()` write these for you.

## Claude Code Session Hooks

```
        thinking          working           prompt
      ~~~~~~~~~~~~      ~~~~~~~~~~      ~~~~~~~~~~~~~~
     ~ CYAN pulse ~    ~ MAGENTA  ~    ~  RED pulse   ~
     ~ slow breathe~   ~ pulse    ~    ~  30s then    ~
     ~~~~~~~~~~~~~     ~~ ~~~~~ ~~~    ~  idle        ~
                                       ~~~~~~~~~~~~~~
```

`hue-status.js` animates a single light based on Claude Code session events. Every hook invocation kills the previous pulse and starts fresh — no orphaned processes, no stuck colors.

| Event | Color | Behavior |
|-------|-------|----------|
| User submits prompt | cyan | pulse (thinking) |
| Tool starts | magenta | pulse (working) |
| Tool ends | cyan | pulse (thinking) |
| Plan approved | green | solid flash, then resumes |
| Permission prompt | red | pulse, 30s auto-expire → idle |
| Session ends | — | restores pre-session state |

The pre-session light state is saved on the first prompt of each session and restored when the session stops.

### Hook configuration

Generated automatically by `setup()`. To configure manually, add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js thinking" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js working" }] }
    ],
    "PostToolUse": [
      { "matcher": "exit_plan_mode", "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js success" }] },
      { "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js thinking" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js prompt" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/airglow/hue-status.js restore" }] }
    ]
  }
}
```

The light ID defaults to `HUE_HOOK_LIGHT` from `.env`. To pin a project to a specific light, pass the ID as the second argument:

```bash
node hue-status.js thinking 55
```

To bind different projects to different lights without git conflicts, use `settings.local.json` (automatically gitignored by Claude Code) in each project's `.claude/` directory.

## Available Tools

| Tool | Description |
|------|-------------|
| `setup` | Guided onboarding — discovers bridge, registers API key, selects animation light, returns hook config |
| `discover_bridge` | Find Hue bridges on the local network |
| `create_user` | Register a new API user (press the link button first) |
| `get_lights` | List lights — filterable by room, on/off state, or color capability |
| `get_groups` | List all groups and rooms |
| `get_scenes` | List all saved scenes |
| `get_sensors` | List motion sensors, temperature sensors, buttons, and remotes |
| `get_dynamic_scenes` | List animated smart scenes — Candle, Fireplace, etc. (v2 API) |
| `set_light` | Control a single light — on/off, brightness (0–100%), color temp (153–500 mired), RGB, HSL, flash alert, transition time |
| `set_group` | Control all lights in a group simultaneously — same params as `set_light` |
| `set_effect` | Apply a native animated effect to lights — candle, fire, prism, sparkle, opal, glisten, cosmos. Pass `no_effect` to clear. |
| `set_status` | Set lights to a semantic status color |
| `activate_scene` | Activate a saved scene by ID |
| `activate_dynamic_scene` | Activate an animated smart scene with optional speed control |
| `create_scene` | Snapshot current light state as a named scene |

## Status Colors

`set_status` maps named statuses to specific light states — great for CI pipelines, agents, or anything that has a "mood."

| Status | Color | Vibe |
|--------|-------|------|
| `idle` | warm white | nothing happening |
| `thinking` | soft blue | Claude is reasoning |
| `working` | bright blue | tools firing |
| `building` | amber | compiling / CI |
| `waiting` | purple | blocked on review |
| `success` | green | nailed it |
| `deployed` | teal | shipped |
| `error` | red | something broke |
| `alert` | red flash | wake up |
| `pulse_once` | one breathe cycle | gentle nudge, returns to prior state |
| `off` | off | done |

```
set_status({ status: "thinking" })
set_status({ status: "success", group_id: 3 })
set_status({ status: "pulse_once", light_id: 6 })
```

## Dynamic Scenes

`get_dynamic_scenes` and `activate_dynamic_scene` use the Hue v2 CLIP API to access animated smart scenes. Requires gen 2 bridge with current firmware and scenes created in the Hue app.

```
get_dynamic_scenes()
activate_dynamic_scene({ scene_id: "uuid-from-above" })
activate_dynamic_scene({ scene_id: "uuid", speed: 0.7 })   // speed: 0.0–1.0
```

## Scene Snapshots

`create_scene` captures exactly what your lights look like right now as a named scene you can recall anytime:

```
create_scene({ name: "Evening Work" })                      // captures HUE_DEFAULT_GROUP
create_scene({ name: "Office Focus", group_id: 3 })         // specific room
create_scene({ name: "Desk Only", light_ids: [6, 55] })     // specific lights
```

Returns a scene ID ready for `activate_scene`.

