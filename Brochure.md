# ADB Plugin Template

The official starting point for building ADB plugins. Clone this, fill in your details, and implement your logic.

## Getting Started

1. Copy this template folder and rename it `adb-plugin-yourname`
2. Edit `plugin.json` — replace `REPLACE_ME` with your plugin name, fill in `displayName`, `description`, `author`, and `version`
3. Implement your logic inside `index.js` — export a `load(ctx)` function
4. Add configurable options to `configSchema` if needed
5. Add `Brochure.md` — describe your plugin for the dashboard

## Project Structure

```
adb-plugin-yourname/
├── plugin.json     # Manifest: name, version, permissions, config schema
├── index.js        # Entry point: exports load(ctx)
├── package.json    # npm metadata
└── Brochure.md     # Plugin description shown in the dashboard
```

## Plugin Context API

Your `load(ctx)` function receives a `PluginContext` with:

| API | Description |
|-----|-------------|
| `ctx.commands` | Register slash commands |
| `ctx.events` | Listen to Discord gateway events |
| `ctx.db` | Read/write the bot's database |
| `ctx.scheduler` | Schedule recurring tasks |
| `ctx.logger` | Namespaced logger |

## Publishing

When ready, publish to npm as `adb-plugin-yourname` and submit to the ADB plugin registry for marketplace listing.

> Package names must start with `adb-plugin-` to be discovered by the bot.
