const cron = require("node-cron");

const autoroleCommand = require("./commands/autorole");
const autoroleConfigSchema = require("./models/autoroleConfig");
const pendingRoleActionSchema = require("./models/pendingRoleAction");

async function load(ctx) {
	// --- Define namespaced DB models ----------------------------
	const AutoroleConfig = ctx.defineModel("autoroleConfig", autoroleConfigSchema);
	const PendingRoleAction = ctx.defineModel("pendingRoleAction", pendingRoleActionSchema);

	// --- Register slash command -----------------------------------------
	ctx.registerCommand({
		data: autoroleCommand.data,
		execute: (interaction) => autoroleCommand.execute(interaction, ctx),
	});

	// --- Listen to guildMemberAdd Discord event -------------------------------
	ctx.registerEvent("guildMemberAdd", async (member) => {
		try {
			// Read server autorole config
			const config = await ctx.db.getPluginConfig(member.guild.id, "adb-plugin-autorole");
			if (!config?.data?.enabled) return;

			if (member.user.bot) {
				// 🤖 Handle Bots
				const botRules = await AutoroleConfig.find({ guildId: member.guild.id, type: "bot" });
				for (const rule of botRules) {
					const role = member.guild.roles.cache.get(rule.roleId);
					if (role) {
						await member.roles.add(role).catch((err) => {
							ctx.logger.error(`Failed to assign bot role ${role.id} to ${member.id}:`, err);
						});
					}
				}
				return;
			}

			// 👤 Handle Humans
			// 1. Assign instant join roles
			const joinRules = await AutoroleConfig.find({ guildId: member.guild.id, type: "join" });
			for (const rule of joinRules) {
				const role = member.guild.roles.cache.get(rule.roleId);
				if (role) {
					await member.roles.add(role).catch((err) => {
						ctx.logger.error(`Failed to assign join role ${role.id} to ${member.id}:`, err);
					});
				}
			}

			// 2. Assign level roles based on existing XP level
			let currentLevel = 0;
			try {
				// Use the host connection and registered model, not a guessed collection
				// or this package's potentially separate npm-linked mongoose instance.
				const Level = AutoroleConfig.db?.models?.["plugin_adb-plugin-levels_Level"];
				if (Level) {
					const levelDoc = await Level.findOne({ guildId: member.guild.id, userId: member.id });
					if (levelDoc) {
						currentLevel = levelDoc.level ?? 0;
					}
				}
			} catch (err) {
				ctx.logger.warn(`Could not read the registered Levels model: ${err.message}`);
			}

			if (currentLevel > 0) {
				const levelRules = await AutoroleConfig.find({
					guildId: member.guild.id,
					type: "level",
					level: { $lte: currentLevel },
				});
				for (const rule of levelRules) {
					const role = member.guild.roles.cache.get(rule.roleId);
					if (role && !member.roles.cache.has(role.id)) {
						await member.roles.add(role).catch((err) => {
							ctx.logger.error(`Failed to assign join-level role ${role.id} to ${member.id}:`, err);
						});
					}
				}
			}

			// 3. Process delayed role rules
			const delayedRules = await AutoroleConfig.find({ guildId: member.guild.id, type: "delayed" });
			for (const rule of delayedRules) {
				if (rule.delayMs > 0) {
					await PendingRoleAction.create({
						guildId: member.guild.id,
						userId: member.id,
						roleId: rule.roleId,
						action: "add",
						executeAt: new Date(Date.now() + rule.delayMs),
					});
				}
			}

			// 4. Process remove-after role rules
			const removeAfterRules = await AutoroleConfig.find({ guildId: member.guild.id, type: "remove-after" });
			for (const rule of removeAfterRules) {
				const role = member.guild.roles.cache.get(rule.roleId);
				if (role) {
					await member.roles.add(role).catch((err) => {
						ctx.logger.error(`Failed to assign remove-after role ${role.id} to ${member.id}:`, err);
					});
				}
				if (rule.delayMs > 0) {
					await PendingRoleAction.create({
						guildId: member.guild.id,
						userId: member.id,
						roleId: rule.roleId,
						action: "remove",
						executeAt: new Date(Date.now() + rule.delayMs),
					});
				}
			}

		} catch (err) {
			ctx.logger.error("Error in guildMemberAdd event handler:", err);
		}
	});

	// --- Hook into level up events (integrate with XP system) ----------------
	const offLevelUp = ctx.hooks.on("onLevelUp", async ({ user, newLevel, guild } = {}) => {
		try {
			const guildId = guild?.id;
			const userId = user?.id;
			if (!guildId || !userId || !Number.isFinite(newLevel) || newLevel <= 0) return;
			const config = await ctx.db.getPluginConfig(guildId, "adb-plugin-autorole");
			if (!config?.data?.enabled) return;

			guild = ctx.client.guilds.cache.get(guildId) || (guild?.members?.fetch ? guild : await ctx.client.guilds.fetch(guildId));
			if (!guild || guild.available === false) return;
			const member = await guild.members.fetch(userId);
			if (!member) return;

			// Match rejoin behavior, including rewards skipped by a multi-level jump.
			const levelRules = await AutoroleConfig.find({
				guildId: guild.id,
				type: "level",
				level: { $lte: newLevel },
			});

			for (const rule of levelRules) {
				const role = guild.roles.cache.get(rule.roleId);
				if (role && !member.roles.cache.has(role.id)) {
					await member.roles.add(role).catch((err) => {
						ctx.logger.error(`Failed to assign level-up role ${role.id} to ${member.id}:`, err);
					});
				}
			}
		} catch (err) {
			ctx.logger.error("Error in onLevelUp hook:", err);
		}
	});

	// --- Scheduled/cron work for delayed & temporary roles -------------------
	const task = cron.schedule("* * * * *", async () => {
		await processPendingRoleActions(ctx, PendingRoleAction);
	});

	// Clean up task when plugin is unloaded
	const offUnload = ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
		if (pluginName === "adb-plugin-autorole") {
			task.stop();
			offLevelUp();
			offUnload();
		}
	});

	ctx.logger.info("Autorole plugin loaded");
}

async function processPendingRoleActions(ctx, PendingRoleAction) {
	try {
		const now = new Date();
		const actions = await PendingRoleAction.find({ executeAt: { $lte: now } }).limit(100);

		for (const action of actions) {
			try {
				// Check if plugin is enabled
				const config = await ctx.db.getPluginConfig(action.guildId, "adb-plugin-autorole");
				if (!config?.data?.enabled) {
					// Plugin disabled, skip execution for now but keep task in DB
					continue;
				}

				const guild = ctx.client.guilds.cache.get(action.guildId) || await ctx.client.guilds.fetch(action.guildId);
				if (!guild) {
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}
				if (guild.available === false) continue;

				const member = await guild.members.fetch(action.userId);
				if (!member) {
					// Member left server, remove task
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}

				const role = guild.roles.cache.get(action.roleId) || await guild.roles.fetch(action.roleId);
				if (!role) {
					// Role was deleted, remove task
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}

				// Singular role PUT/DELETE calls are idempotent; the gateway cache can lag behind them.
				if (action.action === "add") {
					await member.roles.add(role);
				} else if (action.action === "remove") {
					await member.roles.remove(role);
				}

				// Clean up processed task
				await PendingRoleAction.deleteOne({ _id: action._id });

			} catch (actionErr) {
				// Only authoritative Unknown Guild/Member/Role errors cancel work.
				// Transient API and permission failures remain queued for the next tick.
				if ([10004, 10007, 10011].includes(actionErr.code)) {
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}
				ctx.logger.error(`Error processing pending role action ${action._id}:`, actionErr);
			}
		}
	} catch (err) {
		ctx.logger.error("Error in processPendingRoleActions cron task:", err);
	}
}

module.exports = { load };
