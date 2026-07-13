const cron = require("node-cron");
const mongoose = require("mongoose");

const autoroleCommand = require("./commands/autorole");
const autoroleConfigSchema = require("./models/autoroleConfig");
const pendingRoleActionSchema = require("./models/pendingRoleAction");

async function load(ctx) {
	// --- Define namespaced DB models ----------------------------
	const AutoroleConfig = ctx.defineModel("autoroleConfig", autoroleConfigSchema);
	const PendingRoleAction = ctx.defineModel("pendingRoleAction", pendingRoleActionSchema);

	// --- Register slash command -----------------------------------------
	ctx.registerCommand(autoroleCommand);

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
				if (mongoose.connection && mongoose.connection.db) {
					const levelDoc = await mongoose.connection.db
						.collection("plugin_adb-plugin-levels_level")
						.findOne({ guildId: member.guild.id, userId: member.id });
					if (levelDoc) {
						currentLevel = levelDoc.level ?? 0;
					}
				}
			} catch (err) {
				ctx.logger.warn(`Could not read level from plugin_adb-plugin-levels_level: ${err.message}`);
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
	ctx.hooks.on("onLevelUp", async ({ user, newLevel, guild }) => {
		try {
			const config = await ctx.db.getPluginConfig(guild.id, "adb-plugin-autorole");
			if (!config?.data?.enabled) return;

			const member = await guild.members.fetch(user.id).catch(() => null);
			if (!member) return;

			// Find rules for this exact level
			const levelRules = await AutoroleConfig.find({
				guildId: guild.id,
				type: "level",
				level: newLevel,
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
	ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
		if (pluginName === "adb-plugin-autorole") {
			task.stop();
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
				const guild = ctx.client.guilds.cache.get(action.guildId);
				if (!guild) {
					// Guild is no longer accessible, remove task
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}

				// Check if plugin is enabled
				const config = await ctx.db.getPluginConfig(action.guildId, "adb-plugin-autorole");
				if (!config?.data?.enabled) {
					// Plugin disabled, skip execution for now but keep task in DB
					continue;
				}

				const member = await guild.members.fetch(action.userId).catch(() => null);
				if (!member) {
					// Member left server, remove task
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}

				const role = guild.roles.cache.get(action.roleId);
				if (!role) {
					// Role was deleted, remove task
					await PendingRoleAction.deleteOne({ _id: action._id });
					continue;
				}

				if (action.action === "add") {
					if (!member.roles.cache.has(role.id)) {
						await member.roles.add(role).catch((err) => {
							ctx.logger.error(`Failed to assign delayed role ${role.id} to ${member.id}:`, err);
						});
					}
				} else if (action.action === "remove") {
					if (member.roles.cache.has(role.id)) {
						await member.roles.remove(role).catch((err) => {
							ctx.logger.error(`Failed to remove role ${role.id} from ${member.id}:`, err);
						});
					}
				}

				// Clean up processed task
				await PendingRoleAction.deleteOne({ _id: action._id });

			} catch (actionErr) {
				ctx.logger.error(`Error processing pending role action ${action._id}:`, actionErr);
			}
		}
	} catch (err) {
		ctx.logger.error("Error in processPendingRoleActions cron task:", err);
	}
}

module.exports = { load };
