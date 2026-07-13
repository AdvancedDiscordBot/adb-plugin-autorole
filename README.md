# adb-plugin-template

Clean starting point for building an external (npm-installable) plugin for
[Advanced Discord Bot](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot) (ADB).

See `adb-plugin-reminders` (sibling repo) for a complete, working example built from this template.

## Use this template

1. Copy this folder / use as a GitHub template repo, rename it to `adb-plugin-<your-name>`.
2. Find-and-replace `adb-plugin-REPLACE_ME` with your real package name in `plugin.json` and `package.json`.
3. **Naming rule**: the package name (and the folder name, if run as a local plugin) must start with `adb-plugin-` — that's the exact string `PluginManager` scans `node_modules/` for.
4. Implement your feature in `index.js` / `commands/` / `models/`.
5. Update this README.

## Plugin contract

Every plugin's entry file (default `index.js`) must export:

```js
async function load(ctx) { /* ... */ }
module.exports = { load };
```

`PluginManager` calls `load(ctx)` once at startup (or on hot-reload). Errors thrown here disable just this plugin — they don't crash the bot.

## `ctx` API reference

| Member | What it is |
|---|---|
| `ctx.client` | Raw discord.js `Client` — full Discord API access |
| `ctx.db` | Core `Database` singleton (server config, user profiles, etc.) |
| `ctx.commands` | Live `Collection` of all registered commands |
| `ctx.registerCommand(command)` | Register a `{ data, execute }` slash command |
| `ctx.overrideCommand(name, (originalExecute, command) => newExecute)` | Wrap an existing command (yours or core's) |
| `ctx.registerEvent(eventName, handler, { once? })` | Listen to a discord.js client event |
| `ctx.defineModel(modelName, mongooseSchema)` | Compile a Mongo model namespaced as `plugin_<your-plugin-name>_<modelName>` |
| `ctx.hooks.on(hookName, handler, priority?)` / `ctx.hooks.emitHook(hookName, payload)` | Bot lifecycle hook bus (`onPluginLoad`, `onPluginUnload`, `onLevelUp`, etc. — see ADB's `PLUGINS-ROADMAP.md`) |
| `ctx.config.env` | Read-only `process.env` |
| `ctx.logger` | `.info()` / `.warn()` / `.error()`, namespaced to your plugin |

**Gotcha**: `ctx.scheduler` exists (it's the bot's internal `TaskScheduler`) but has **no generic `.schedule(name, cron, fn)` method** — some ADB docs claim otherwise. If you need a periodic job, bundle your own `node-cron` dependency and call `cron.schedule(...)` directly inside `load()`, same as ADB core does internally.

## `plugin.json` fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | must start with `adb-plugin-` |
| `version` | yes | semver |
| `description` | yes | |
| `author` | yes | |
| `main` | no | defaults to `index.js` |
| `displayName` | no | shown in marketplace UI |
| `requiresRestart` | no | `true` disables hot-reload eligibility |
| `port` | no | declares a plugin-owned web dashboard port (see main repo's `CREATE-PLUGIN.md` for the fastify pattern) |
| `configSchema` | no | JSON Schema → auto-generated per-guild settings UI in the dashboard, read via `ctx.db.getPluginConfig(guildId, pluginName)` |
| `permissions` | no | declared for the marketplace install prompt (`db.read`, `db.write`, `commands.register`, `commands.override`, `scheduler`, ...) |

## Local testing (no bot, no Mongo required)

```bash
npm install
npm test
```

`test/local-harness.js` loads your plugin against `test/mock-ctx.js` — a fake in-memory `ctx` — and exercises registered commands directly. Extend both files as you add features. This catches logic bugs fast; it does **not** replace a real smoke test (see below).

## Testing inside a real bot

1. Have a working local checkout of Advanced Discord Bot.
2. Symlink or copy your plugin folder into its `plugins/` directory:
   ```bash
   ln -s $(pwd) /path/to/Advanced-Discord-Bot/plugins/adb-plugin-yourname
   ```
   or, to test the actual `node_modules/adb-plugin-*` discovery path a real npm install would use:
   ```bash
   npm link
   cd /path/to/Advanced-Discord-Bot && npm link adb-plugin-yourname
   ```
3. Start the bot, confirm your plugin's load-log line appears.
4. If you added slash commands, run `npm run deploy` in the bot repo — command *logic* hot-reloads, but Discord command *registration* needs an explicit deploy.
5. Exercise the feature for real in a Discord server.

## Publishing to npm

```bash
npm login
npm publish
```

Anyone installs it with `npm install adb-plugin-yourname` into their bot's root — ADB's `PluginManager` auto-discovers any `node_modules/adb-plugin-*` folder containing a `plugin.json`.

## Listing on the ADB plugin registry (optional)

See `REGISTRY-SETUP.md` in the main ADB repo — fork the registry repo, add an entry to `plugins.json` with your `npmPackage` name, open a PR.

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
