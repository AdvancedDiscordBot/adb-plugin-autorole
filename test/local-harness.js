// Run with: npm test  (or) node test/local-harness.js
const assert = require("node:assert");
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

// Mock mongoose.connection.db for the existing XP level checks
mongoose.connection = mongoose.connection || {};
let mockLevelsDb = {};
mongoose.connection.db = {
	collection: (name) => {
		if (name === "plugin_adb-plugin-levels_level") {
			return {
				findOne: async (query) => {
					return mockLevelsDb[`${query.guildId}:${query.userId}`] || null;
				},
			};
		}
		return null;
	},
};

// Helper to create a fake interaction
function fakeInteraction(options = {}) {
	const replies = [];
	return {
		guildId: options._guildId ?? "test-guild",
		user: options._user ?? { id: "test-user" },
		member: options._member ?? {
			permissions: {
				has: () => true, // bypass permission checks by default in test
			},
		},
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

	assert.ok(registeredCommands.has("autorole"), "expected /autorole command to be registered");
	assert.ok(registeredEvents.has("guildMemberAdd"), "expected guildMemberAdd event to be registered");

	console.log("🟢 1. Enable autorole for server");
	const enableInteraction = fakeInteraction({ _subcommand: "enable" });
	await registeredCommands.get("autorole").execute(enableInteraction, ctx);
	let config = await ctx.db.getPluginConfig("test-guild", "adb-plugin-autorole");
	assert.strictEqual(config.data.enabled, true, "autorole should be enabled in config");

	console.log("🟢 2. Add Join type role rule");
	const addJoinInteraction = fakeInteraction({
		_subcommand: "add",
		role: "role-join-1",
		type: "join",
	});
	await registeredCommands.get("autorole").execute(addJoinInteraction, ctx);
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
	await registeredCommands.get("autorole").execute(addBotInteraction, ctx);

	console.log("🟢 4. Add Level type role rule");
	const addLevelInteraction = fakeInteraction({
		_subcommand: "add",
		role: "role-level-5",
		type: "level",
		level: 5,
	});
	await registeredCommands.get("autorole").execute(addLevelInteraction, ctx);

	console.log("🟢 5. Add Delayed assignment role rule");
	const addDelayedInteraction = fakeInteraction({
		_subcommand: "delayed",
		role: "role-delayed-10m",
		duration: "10m",
	});
	await registeredCommands.get("autorole").execute(addDelayedInteraction, ctx);

	console.log("🟢 6. Add Remove-After assignment role rule");
	const addRemoveAfterInteraction = fakeInteraction({
		_subcommand: "remove-after",
		role: "role-temp-1h",
		duration: "1h",
	});
	await registeredCommands.get("autorole").execute(addRemoveAfterInteraction, ctx);

	console.log("🟢 7. List rules");
	const listInteraction = fakeInteraction({ _subcommand: "list" });
	await registeredCommands.get("autorole").execute(listInteraction, ctx);
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

	console.log("🟢 12. Test remove subcommand");
	const removeInteraction = fakeInteraction({
		_subcommand: "remove",
		role: "role-join-1",
	});
	await registeredCommands.get("autorole").execute(removeInteraction, ctx);
	rules = await AutoroleConfig.find({ guildId: "test-guild", roleId: "role-join-1" });
	assert.strictEqual(rules.length, 0, "join-role rule should be deleted");

	console.log("🟢 13. Disable autorole and verify it ignores join events");
	const disableInteraction = fakeInteraction({ _subcommand: "disable" });
	await registeredCommands.get("autorole").execute(disableInteraction, ctx);
	config = await ctx.db.getPluginConfig("test-guild", "adb-plugin-autorole");
	assert.strictEqual(config.data.enabled, false, "autorole should be disabled");

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

	console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
}

main().catch((error) => {
	console.error("❌ Test harness failed:", error);
	process.exit(1);
});