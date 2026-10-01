// Run with: npm test  (or) node test/local-harness.js
const assert = require("node:assert");
const { Client, ChatInputCommandInteraction, PermissionFlagsBits } = require("discord.js");
const mongoose = require("mongoose");
const cron = require("node-cron");

// Capture the cron callback to execute it manually in tests
let cronCallback = null;
cron.schedule = (expr, cb) => {
	cronCallback = cb;
	return {
		stop: () => {
			cronCallback = null;
		},
	};
};

const { load } = require("../index.js");
const { createMockCtx } = require("./mock-ctx");

const mockLevelsDb = {};

// Helper to create a fake interaction
function fakeInteraction(options = {}) {
	const replies = [];
	const member = options._member ?? { permissions: { has: () => true } };
	return {
		guildId: options._guildId ?? "test-guild",
		user: options._user ?? { id: "test-user" },
		member,
		memberPermissions: member.permissions,
		options: {
			getString: (name) => options[name] ?? null,
			getInteger: (name) => options[name] ?? null,
			getUser: (name) => options[name] ?? null,
			getRole: (name) => (options[name] ? { id: options[name] } : null),
			getSubcommand: () => options._subcommand ?? null,
		},
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

async function main() {
	const { ctx, registeredCommands, registeredEvents, models, hooks, emitEvent } = createMockCtx({
		pluginName: "adb-plugin-autorole",
	});

	// Load the plugin
	await load(ctx);

	// Retrieve models compiled by load()
	const AutoroleConfig = models.get("plugin_adb-plugin-autorole_autoroleConfig");
	const PendingRoleAction = models.get("plugin_adb-plugin-autorole_pendingRoleAction");
	// npm-linked plugins can have a different mongoose instance from the host.
	const hostMongoose = new mongoose.Mongoose();
	const Level = hostMongoose.model("plugin_adb-plugin-levels_Level", new hostMongoose.Schema({
		guildId: String, userId: String, level: Number,
	}));
	assert.strictEqual(Level.collection.name, "plugin_adb-plugin-levels_levels");
	assert.strictEqual(mongoose.models[Level.modelName], undefined);
	Level.findOne = async (query) => mockLevelsDb[`${query.guildId}:${query.userId}`] || null;
	AutoroleConfig.db.models[Level.modelName] = Level;

	assert.ok(registeredCommands.has("autorole"), "expected /autorole command to be registered");
	assert.ok(registeredEvents.has("guildMemberAdd"), "expected guildMemberAdd event to be registered");

	console.log("🟢 1. Enable autorole for server");
	await ctx.db.updatePluginConfig("test-guild", "adb-plugin-autorole", { customSetting: { keep: true } });
	const enableInteraction = fakeInteraction({ _subcommand: "enable" });
	await registeredCommands.get("autorole").execute(enableInteraction, ctx.client);
	let config = await ctx.db.getPluginConfig("test-guild", "adb-plugin-autorole");
	assert.strictEqual(config.data.enabled, true, "autorole should be enabled in config");
	assert.deepStrictEqual(config.data.customSetting, { keep: true }, "enable preserves other settings");

	console.log("🟢 2. Add Join type role rule");
	const addJoinInteraction = fakeInteraction({
		_subcommand: "add",
		role: "role-join-1",
		type: "join",
	});
	await registeredCommands.get("autorole").execute(addJoinInteraction, ctx.client);
	let rules = await AutoroleConfig.find({ guildId: "test-guild" });
	assert.strictEqual(rules.length, 1);
	assert.strictEqual(rules[0].roleId, "role-join-1");
	assert.strictEqual(rules[0].type, "join");

	console.log("🟢 3. Add Bot type role rule");
	const addBotInteraction = fakeInteraction({
		_subcommand: "add",
		role: "role-bot-1",
		type: "bot",
	});
	await registeredCommands.get("autorole").execute(addBotInteraction, ctx.client);

	console.log("🟢 4. Add Level type role rule");
	const addLevelInteraction = fakeInteraction({
		_subcommand: "add",
		role: "role-level-5",
		type: "level",
		level: 5,
	});
	await registeredCommands.get("autorole").execute(addLevelInteraction, ctx.client);

	console.log("🟢 5. Add Delayed assignment role rule");
	const addDelayedInteraction = fakeInteraction({
		_subcommand: "delayed",
		role: "role-delayed-10m",
		duration: "10m",
	});
	await registeredCommands.get("autorole").execute(addDelayedInteraction, ctx.client);

	console.log("🟢 6. Add Remove-After assignment role rule");
	const addRemoveAfterInteraction = fakeInteraction({
		_subcommand: "remove-after",
		role: "role-temp-1h",
		duration: "1h",
	});
	await registeredCommands.get("autorole").execute(addRemoveAfterInteraction, ctx.client);

	console.log("🟢 7. List rules");
	const listInteraction = fakeInteraction({ _subcommand: "list" });
	await registeredCommands.get("autorole").execute(listInteraction, ctx.client);
	assert.ok(listInteraction.replies[0].content.includes("role-join-1"), "list should contain role-join-1");
	assert.ok(listInteraction.replies[0].content.includes("role-level-5"), "list should contain role-level-5");
	assert.ok(listInteraction.replies[0].content.includes("role-delayed-10m"), "list should contain role-delayed-10m");
	assert.ok(listInteraction.replies[0].content.includes("role-temp-1h"), "list should contain role-temp-1h");

	console.log("🟢 8. Test Join Event for Humans (mock existing level: 5)");
	mockLevelsDb["test-guild:human-user"] = { guildId: "test-guild", userId: "human-user", level: 5 };

	const humanMember = {
		id: "human-user",
		user: { id: "human-user", bot: false },
		guild: {
			id: "test-guild",
			roles: {
				cache: new Map([
					["role-join-1", { id: "role-join-1", name: "JoinRole" }],
					["role-level-5", { id: "role-level-5", name: "Level5Role" }],
					["role-temp-1h", { id: "role-temp-1h", name: "TempRole" }],
					["role-delayed-10m", { id: "role-delayed-10m", name: "DelayedRole" }],
				]),
			},
		},
		roles: {
			cache: new Set(),
			add: async (role) => {
				const id = typeof role === "string" ? role : role.id;
				humanMember.roles.cache.add(id);
			},
			remove: async (role) => {
				const id = typeof role === "string" ? role : role.id;
				humanMember.roles.cache.delete(id);
			},
		},
	};

	// Emit join event
	await emitEvent("guildMemberAdd", humanMember);

	// Human should receive join-role, level-role, and remove-after role instantly
	assert.ok(humanMember.roles.cache.has("role-join-1"), "should have join-role");
	assert.ok(humanMember.roles.cache.has("role-level-5"), "should have level-5 role");
	assert.ok(humanMember.roles.cache.has("role-temp-1h"), "should have remove-after role");
	assert.ok(!humanMember.roles.cache.has("role-bot-1"), "should not have bot-role");
	assert.ok(!humanMember.roles.cache.has("role-delayed-10m"), "should not have delayed-role yet");

	// Verify pending actions were scheduled in DB
	const pendingActions = await PendingRoleAction.find({ userId: "human-user" });
	assert.strictEqual(pendingActions.length, 2, "should have scheduled 2 pending role actions");

	const delayedAdd = pendingActions.find((a) => a.action === "add");
	assert.ok(delayedAdd, "should have a pending add action");
	assert.strictEqual(delayedAdd.roleId, "role-delayed-10m");

	const tempRemove = pendingActions.find((a) => a.action === "remove");
	assert.ok(tempRemove, "should have a pending remove action");
	assert.strictEqual(tempRemove.roleId, "role-temp-1h");

	console.log("🟢 9. Test Join Event for Bots");
	const botMember = {
		id: "bot-user",
		user: { id: "bot-user", bot: true },
		guild: {
			id: "test-guild",
			roles: {
				cache: new Map([["role-bot-1", { id: "role-bot-1", name: "BotRole" }]]),
			},
		},
		roles: {
			cache: new Set(),
			add: async (role) => {
				const id = typeof role === "string" ? role : role.id;
				botMember.roles.cache.add(id);
			},
		},
	};

	await emitEvent("guildMemberAdd", botMember);
	assert.ok(botMember.roles.cache.has("role-bot-1"), "bot should have bot-role");
	assert.ok(!botMember.roles.cache.has("role-join-1"), "bot should not get human join-role");

	console.log("🟢 10. Test Level Up Hook");
	const levelUpMember = {
		id: "levelup-user",
		user: { id: "levelup-user", bot: false },
		guild: {
			id: "test-guild",
			roles: {
				cache: new Map([["role-level-5", { id: "role-level-5", name: "Level5Role" }]]),
			},
			members: {
				fetch: async (id) => {
					if (id === "levelup-user") return levelUpMember;
					return null;
				},
			},
		},
		roles: {
			cache: new Set(),
			add: async (role) => {
				const id = typeof role === "string" ? role : role.id;
				levelUpMember.roles.cache.add(id);
			},
		},
	};

	await hooks.emitHook("onLevelUp", {
		user: { id: "levelup-user", tag: "levelup#1234" },
		newLevel: 5,
		guild: levelUpMember.guild,
	});

	assert.ok(levelUpMember.roles.cache.has("role-level-5"), "should receive level-5 role upon level-up");
	levelUpMember.roles.cache.clear();
	await hooks.emitHook("onLevelUp", {
		user: levelUpMember.user, newLevel: 7, guild: levelUpMember.guild,
	});
	assert.ok(levelUpMember.roles.cache.has("role-level-5"), "skipped levels must grant all eligible rewards, just like a rejoin");
	levelUpMember.roles.cache.clear();
	ctx.client.guilds.cache.set("test-guild", levelUpMember.guild);
	await hooks.emitHook("onLevelUp", {
		user: { id: levelUpMember.id }, newLevel: 8, guild: { id: "test-guild" },
	});
	assert.ok(levelUpMember.roles.cache.has("role-level-5"), "serialized level hooks must resolve the live guild");

	console.log("🟢 11. Test Cron Job Processing for Delayed and Temporary Roles");
	// Setup the mock client guilds structure so that processPendingRoleActions can fetch the guild and member
	ctx.client.guilds.cache.set("test-guild", {
		id: "test-guild",
		roles: {
			cache: new Map([
				["role-delayed-10m", { id: "role-delayed-10m", name: "DelayedRole" }],
				["role-temp-1h", { id: "role-temp-1h", name: "TempRole" }],
			]),
		},
		members: {
			fetch: async (id) => {
				if (id === "human-user") return humanMember;
				return null;
			},
		},
	});

	// Fast-forward executeAt times in pending actions to be due
	await PendingRoleAction.updateMany({}, { executeAt: new Date(Date.now() - 1000) });

	// Trigger the cron callback manually
	assert.ok(cronCallback, "cronCallback should be registered");
	await cronCallback();

	// Verify roles have been updated
	assert.ok(humanMember.roles.cache.has("role-delayed-10m"), "delayed-role should be added by cron");
	assert.ok(!humanMember.roles.cache.has("role-temp-1h"), "temporary role should be removed by cron");

	// Verify pending actions are cleared from DB
	const remainingActions = await PendingRoleAction.find({});
	assert.strictEqual(remainingActions.length, 0, "all pending actions should be processed and cleared");

	console.log("Testing pending action retries and authoritative missing cases");
	const pendingGuild = ctx.client.guilds.cache.get("test-guild");
	ctx.client.guilds.fetch = async () => pendingGuild;
	pendingGuild.roles.fetch = async (id) => pendingGuild.roles.cache.get(id) || null;
	const enqueue = (overrides = {}) => PendingRoleAction.create({
		guildId: "test-guild", userId: humanMember.id, roleId: "role-delayed-10m",
		action: "add", executeAt: new Date(0), ...overrides,
	});
	const errors = [];
	ctx.logger.error = (...args) => errors.push(args);

	for (const action of ["add", "remove"]) {
		if (action === "add") humanMember.roles.cache.delete("role-delayed-10m");
		else humanMember.roles.cache.add("role-delayed-10m");
		const original = humanMember.roles[action];
		humanMember.roles[action] = async () => { throw new Error("Discord temporarily unavailable"); };
		const queued = await enqueue({ action });
		await cronCallback();
		assert.ok(await PendingRoleAction.findById(queued._id), `failed ${action} must remain queued`);
		humanMember.roles[action] = original;
		await cronCallback();
		assert.strictEqual(await PendingRoleAction.findById(queued._id), null, `successful ${action} clears the queue`);
		assert.strictEqual(humanMember.roles.cache.has("role-delayed-10m"), action === "add");
	}

	const fetchMember = pendingGuild.members.fetch;
	pendingGuild.members.fetch = async () => { throw new Error("member fetch timeout"); };
	const retryFetch = await enqueue();
	await cronCallback();
	assert.ok(await PendingRoleAction.findById(retryFetch._id), "transient member fetch failure must retain work");
	pendingGuild.members.fetch = fetchMember;
	await cronCallback();
	assert.strictEqual(await PendingRoleAction.findById(retryFetch._id), null);

	humanMember.roles.cache.delete("role-delayed-10m");
	ctx.client.guilds.cache.delete("test-guild");
	const uncachedGuild = await enqueue();
	ctx.client.guilds.fetch = async () => { throw new Error("guild fetch timeout"); };
	await cronCallback();
	assert.ok(await PendingRoleAction.findById(uncachedGuild._id), "a cache miss is not proof that the guild was deleted");
	ctx.client.guilds.fetch = async () => pendingGuild;
	await cronCallback();
	assert.ok(humanMember.roles.cache.has("role-delayed-10m"), "fetch uncached guilds before executing work");
	ctx.client.guilds.cache.set("test-guild", pendingGuild);

	const role = pendingGuild.roles.cache.get("role-delayed-10m");
	pendingGuild.roles.cache.delete(role.id);
	pendingGuild.roles.fetch = async () => { throw new Error("role fetch timeout"); };
	const uncachedRole = await enqueue();
	await cronCallback();
	assert.ok(await PendingRoleAction.findById(uncachedRole._id), "transient role fetch failure must retain work");
	pendingGuild.roles.fetch = async () => role;
	await cronCallback();
	assert.strictEqual(await PendingRoleAction.findById(uncachedRole._id), null, "already-applied actions are idempotent");
	pendingGuild.roles.cache.set(role.id, role);

	pendingGuild.available = false;
	const unavailable = await enqueue();
	await cronCallback();
	assert.ok(await PendingRoleAction.findById(unavailable._id), "temporary guild outages must not drop work");
	pendingGuild.available = true;
	await cronCallback();

	for (const code of [10004, 10007, 10011]) {
		const queued = await enqueue();
		const missing = async () => { throw Object.assign(new Error("not found"), { code }); };
		if (code === 10004) {
			ctx.client.guilds.cache.delete("test-guild");
			ctx.client.guilds.fetch = missing;
		} else if (code === 10007) {
			pendingGuild.members.fetch = missing;
		} else {
			pendingGuild.roles.cache.delete(role.id);
			pendingGuild.roles.fetch = missing;
		}
		await cronCallback();
		assert.strictEqual(await PendingRoleAction.findById(queued._id), null, `confirmed Discord missing resource ${code} drops the task`);
		ctx.client.guilds.cache.set("test-guild", pendingGuild);
		ctx.client.guilds.fetch = async () => pendingGuild;
		pendingGuild.members.fetch = fetchMember;
		pendingGuild.roles.cache.set(role.id, role);
	}
	assert.ok(errors.length >= 4, "transient failures should be logged");

	console.log("Testing pending role changes before Discord gateway caches catch up");
	const roleClient = new Client({ intents: [] });
	const guildId = "111111111111111111";
	const userId = "222222222222222222";
	const roleId = "333333333333333333";
	const roleGuild = roleClient.guilds._add({
		id: guildId, name: "Role Test", features: [], channels: [],
		roles: [
			{ id: guildId, name: "@everyone", permissions: "0", position: 0 },
			{ id: roleId, name: "Temporary", permissions: "0", position: 1 },
		],
		members: [{ user: { id: userId, username: "Member", discriminator: "0", bot: false }, roles: [], joined_at: new Date().toISOString() }],
	});
	ctx.client.guilds.cache.set(guildId, roleGuild);
	await ctx.db.updatePluginConfig(guildId, "adb-plugin-autorole", { enabled: true });
	await AutoroleConfig.create({ guildId, roleId, type: "remove-after", delayMs: 1 });
	let serverHasRole = false;
	roleClient.rest.put = async () => { serverHasRole = true; };
	roleClient.rest.delete = async () => { serverHasRole = false; };
	try {
		const member = await roleGuild.members.fetch(userId);
		await emitEvent("guildMemberAdd", member);
		await PendingRoleAction.updateMany({ guildId }, { executeAt: new Date(0) });
		assert.strictEqual(serverHasRole, true);
		assert.strictEqual(member.roles.cache.has(roleId), false, "Discord.js role PUT does not update the gateway cache");
		await cronCallback();
		assert.strictEqual(serverHasRole, false, "a due removal must reach Discord even when the cache says the role is absent");
		assert.strictEqual(await PendingRoleAction.countDocuments({ guildId }), 0);

		member._patch({ roles: [roleId] });
		await member.roles.remove(roleId);
		await PendingRoleAction.create({ guildId, userId, roleId, action: "add", executeAt: new Date(0) });
		assert.strictEqual(member.roles.cache.has(roleId), true, "Discord.js role DELETE also leaves the gateway cache unchanged");
		await cronCallback();
		assert.strictEqual(serverHasRole, true, "a due addition must reach Discord even when the cache says the role is present");
		assert.strictEqual(await PendingRoleAction.countDocuments({ guildId }), 0);
	} finally {
		ctx.client.guilds.cache.delete(guildId);
		await roleClient.destroy();
	}

	console.log("Testing missing and failing optional Levels reads");
	for (const levelSource of [null, { findOne: async () => { throw new Error("Levels read failed"); } }, Level]) {
		AutoroleConfig.db.models[Level.modelName] = levelSource;
		delete mockLevelsDb["test-guild:human-user"];
		humanMember.roles.cache.clear();
		await emitEvent("guildMemberAdd", humanMember);
		assert.ok(humanMember.roles.cache.has("role-join-1"), "optional Levels data must not block normal join roles");
		assert.ok(!humanMember.roles.cache.has("role-level-5"), "no Levels data must not grant a level role");
		assert.strictEqual(await PendingRoleAction.countDocuments({ userId: humanMember.id }), 2, "optional Levels data must not block scheduling");
		await PendingRoleAction.deleteMany({});
	}

	console.log("🟢 12. Test remove subcommand");
	await enqueue({ roleId: "role-join-1" });
	const otherGuildAction = await enqueue({ guildId: "other-guild", roleId: "role-join-1" });
	const removeInteraction = fakeInteraction({
		_subcommand: "remove",
		role: "role-join-1",
	});
	await registeredCommands.get("autorole").execute(removeInteraction, ctx.client);
	rules = await AutoroleConfig.find({ guildId: "test-guild", roleId: "role-join-1" });
	assert.strictEqual(rules.length, 0, "join-role rule should be deleted");
	assert.strictEqual(await PendingRoleAction.countDocuments({ guildId: "test-guild", roleId: "role-join-1" }), 0, "removing a rule cancels its pending work");
	assert.ok(await PendingRoleAction.findById(otherGuildAction._id), "rule removal stays guild-scoped");
	await PendingRoleAction.deleteMany({});

	console.log("🟢 13. Disable autorole and verify it ignores join events");
	const disableInteraction = fakeInteraction({ _subcommand: "disable" });
	await registeredCommands.get("autorole").execute(disableInteraction, ctx.client);
	config = await ctx.db.getPluginConfig("test-guild", "adb-plugin-autorole");
	assert.strictEqual(config.data.enabled, false, "autorole should be disabled");
	assert.deepStrictEqual(config.data.customSetting, { keep: true }, "disable preserves other settings");
	const paused = await enqueue();
	await cronCallback();
	assert.ok(await PendingRoleAction.findById(paused._id), "disabled autorole pauses pending tasks");
	levelUpMember.roles.cache.clear();
	await hooks.emitHook("onLevelUp", { user: levelUpMember.user, newLevel: 9, guild: levelUpMember.guild });
	assert.strictEqual(levelUpMember.roles.cache.size, 0, "disabled autorole ignores level hooks");

	const newHuman = {
		id: "new-human",
		user: { id: "new-human", bot: false },
		guild: {
			id: "test-guild",
			roles: {
				cache: new Map([["role-bot-1", { id: "role-bot-1" }]]),
			},
		},
		roles: {
			cache: new Set(),
			add: async () => {},
		},
	};
	await emitEvent("guildMemberAdd", newHuman);
	assert.strictEqual(newHuman.roles.cache.size, 0, "should not assign roles when plugin is disabled");
	for (const member of [null, {}, { permissions: { has: () => false } }]) {
		const denied = fakeInteraction({ _subcommand: "enable" });
		denied.member = member;
		denied.memberPermissions = member?.permissions ?? null;
		await registeredCommands.get("autorole").execute(denied, ctx.client);
		assert.match(denied.replies[0].content, /Manage Server/);
		assert.strictEqual((await ctx.db.getPluginConfig("test-guild", "adb-plugin-autorole")).data.enabled, false, "unverified permissions cannot change settings");
	}
	await registeredCommands.get("autorole").execute(fakeInteraction({ _subcommand: "enable" }), ctx.client);
	await cronCallback();
	assert.strictEqual(await PendingRoleAction.findById(paused._id), null, "re-enabled autorole resumes pending tasks");

	console.log("Testing resolved permissions on a native uncached guild interaction");
	const client = new Client({ intents: [] });
	try {
		const interaction = new ChatInputCommandInteraction(client, {
			id: "111111111111111111", application_id: "222222222222222222", token: "offline", type: 2,
			guild_id: "333333333333333333", channel: { id: "444444444444444444", type: 0 }, locale: "en-US", entitlements: [],
			member: { user: { id: "555555555555555555", username: "Admin", discriminator: "0" }, roles: [], permissions: String(PermissionFlagsBits.ManageGuild) },
			data: { id: "666666666666666666", name: "autorole", type: 1, options: [{ type: 1, name: "enable" }] },
		});
		const replies = [];
		interaction.reply = async (payload) => replies.push(payload);
		assert.strictEqual(typeof interaction.member.permissions, "string");
		assert.ok(interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild));
		await registeredCommands.get("autorole").execute(interaction, ctx.client);
		assert.strictEqual((await ctx.db.getPluginConfig(interaction.guildId, "adb-plugin-autorole")).data.enabled, true);
		assert.match(replies[0].content, /enabled/);
	} finally {
		await client.destroy();
	}

	await hooks.emitHook("onPluginUnload", { pluginName: "other-plugin" });
	assert.ok(cronCallback, "unloading another plugin must not stop autorole");
	await hooks.emitHook("onPluginUnload", { pluginName: "adb-plugin-autorole" });
	assert.strictEqual(cronCallback, null, "unloading autorole stops cron");
	ctx.client.guilds.cache.set("test-guild", levelUpMember.guild);
	await hooks.emitHook("onLevelUp", { user: levelUpMember.user, newLevel: 5, guild: levelUpMember.guild });
	assert.strictEqual(levelUpMember.roles.cache.size, 0, "unloading autorole removes the level hook");

	const manifest = require("../plugin.json");
	assert.deepStrictEqual(manifest.capabilities.system, ["raw-client"]);
	assert.deepStrictEqual(manifest.permissions.system, manifest.capabilities.system);
	assert.strictEqual(manifest.process.model, "persistent");
	assert.match(manifest.process.persistentReason, /raw-client/);

	console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
}

main().catch((error) => {
	console.error("❌ Test harness failed:", error);
	process.exit(1);
});
