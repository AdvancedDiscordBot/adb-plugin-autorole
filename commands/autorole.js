const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

// Simple parser for duration strings (e.g. "10s", "30m", "2h", "1d")
function parseDuration(input) {
	if (typeof input !== "string") return null;
	const m = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
	if (!m) return null;
	const [_, amount, unit] = m;
	const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit.toLowerCase()];
	return Number(amount) * multiplier;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName("autorole")
		.setDescription("Manage autorole configuration rules")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Add a new autorole rule")
				.addRoleOption((opt) =>
					opt.setName("role").setDescription("The role to assign").setRequired(true)
				)
				.addStringOption((opt) =>
					opt
						.setName("type")
						.setDescription("The rule type")
						.setRequired(true)
						.addChoices(
							{ name: "Join (Humans on Join)", value: "join" },
							{ name: "Bot (Bots on Join)", value: "bot" },
							{ name: "Level (XP Level Reached)", value: "level" }
						)
				)
				.addIntegerOption((opt) =>
					opt.setName("level").setDescription("XP level required (Level type only)").setRequired(false)
				)
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove")
				.setDescription("Remove an existing autorole rule")
				.addRoleOption((opt) =>
					opt.setName("role").setDescription("The role to remove from rules").setRequired(true)
				)
		)
		.addSubcommand((sub) =>
			sub
				.setName("list")
				.setDescription("List all autorole rules for the server")
		)
		.addSubcommand((sub) =>
			sub
				.setName("delayed")
				.setDescription("Assign a role to humans after a delay from joining")
				.addRoleOption((opt) =>
					opt.setName("role").setDescription("The role to assign").setRequired(true)
				)
				.addStringOption((opt) =>
					opt
						.setName("duration")
						.setDescription("Delay duration (e.g. 10m, 2h, 1d)")
						.setRequired(true)
				)
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove-after")
				.setDescription("Assign a role on join, then remove it after a duration")
				.addRoleOption((opt) =>
					opt.setName("role").setDescription("The role to assign and temporarily keep").setRequired(true)
				)
				.addStringOption((opt) =>
					opt
						.setName("duration")
						.setDescription("Duration to keep the role (e.g. 1h, 30m, 1d)")
						.setRequired(true)
				)
		)
		.addSubcommand((sub) =>
			sub
				.setName("enable")
				.setDescription("Enable the autorole plugin for this server")
		)
		.addSubcommand((sub) =>
			sub
				.setName("disable")
				.setDescription("Disable the autorole plugin for this server")
		),

	execute: async (interaction, ctx) => {
		// Ensure member has permission
		if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
			return interaction.reply({
				content: "❌ You need the **Manage Server** permission to use this command.",
				ephemeral: true,
			});
		}

		const subcommand = interaction.options.getSubcommand();
		const AutoroleConfig = ctx.defineModel("autoroleConfig", require("../models/autoroleConfig"));

		if (subcommand === "add") {
			const role = interaction.options.getRole("role") || { id: interaction.options.getString("role") };
			const roleId = role.id;
			const type = interaction.options.getString("type");
			const level = interaction.options.getInteger("level");

			if (type === "level" && (!level || level <= 0)) {
				return interaction.reply({
					content: "❌ You must specify a valid level option (greater than 0) for Level rules.",
					ephemeral: true,
				});
			}

			// Check if rule already exists
			const existing = await AutoroleConfig.findOne({ guildId: interaction.guildId, roleId });
			if (existing) {
				return interaction.reply({
					content: `❌ A rule already exists for the role <@&${roleId}> (Type: **${existing.type}**).`,
					ephemeral: true,
				});
			}

			const ruleData = {
				guildId: interaction.guildId,
				roleId,
				type,
				createdAt: new Date(),
			};

			if (type === "level") {
				ruleData.level = level;
			}

			await AutoroleConfig.create(ruleData);
			return interaction.reply({
				content: `✅ Autorole rule added: <@&${roleId}> will be assigned as a **${type}** rule${type === "level" ? ` at Level **${level}**` : ""}.`,
			});
		}

		if (subcommand === "remove") {
			const role = interaction.options.getRole("role") || { id: interaction.options.getString("role") };
			const roleId = role.id;

			const result = await AutoroleConfig.deleteOne({ guildId: interaction.guildId, roleId });
			if (result.deletedCount === 0) {
				return interaction.reply({
					content: `❌ No autorole rule found for the role <@&${roleId}>.`,
					ephemeral: true,
				});
			}
			const PendingRoleAction = ctx.defineModel("pendingRoleAction", require("../models/pendingRoleAction"));
			await PendingRoleAction.deleteMany({ guildId: interaction.guildId, roleId });

			return interaction.reply({
				content: `✅ Removed autorole rule for <@&${roleId}>.`,
			});
		}

		if (subcommand === "list") {
			const rules = await AutoroleConfig.find({ guildId: interaction.guildId });
			const config = await ctx.db.getPluginConfig(interaction.guildId, "adb-plugin-autorole");
			const status = config?.data?.enabled ? "✅ Enabled" : "❌ Disabled";

			if (rules.length === 0) {
				return interaction.reply({
					content: `⚙️ **Autorole Settings (Status: ${status}):**\n\nNo rules configured yet.`,
					ephemeral: true,
				});
			}

			const lines = rules.map((r) => {
				let details = "";
				if (r.type === "level") details = ` (Level ${r.level})`;
				else if (r.type === "delayed" || r.type === "remove-after") details = ` (${r.duration})`;
				return `- <@&${r.roleId}> ➔ **${r.type}**${details}`;
			});

			return interaction.reply({
				content: `⚙️ **Autorole Settings (Status: ${status}):**\n\n${lines.join("\n")}`,
				ephemeral: true,
			});
		}

		if (subcommand === "delayed" || subcommand === "remove-after") {
			const role = interaction.options.getRole("role") || { id: interaction.options.getString("role") };
			const roleId = role.id;
			const durationStr = interaction.options.getString("duration");
			const ms = parseDuration(durationStr);

			if (!ms || ms <= 0) {
				return interaction.reply({
					content: "❌ Invalid duration format. Use e.g. `10s`, `30m`, `2h`, `1d`.",
					ephemeral: true,
				});
			}

			// Check if rule already exists
			const existing = await AutoroleConfig.findOne({ guildId: interaction.guildId, roleId });
			if (existing) {
				return interaction.reply({
					content: `❌ A rule already exists for the role <@&${roleId}> (Type: **${existing.type}**).`,
					ephemeral: true,
				});
			}

			await AutoroleConfig.create({
				guildId: interaction.guildId,
				roleId,
				type: subcommand,
				duration: durationStr,
				delayMs: ms,
				createdAt: new Date(),
			});

			return interaction.reply({
				content: `✅ Scheduled rule added: <@&${roleId}> is configured as **${subcommand}** with a duration of **${durationStr}**.`,
			});
		}

		if (subcommand === "enable" || subcommand === "disable") {
			const enabled = subcommand === "enable";
			const config = await ctx.db.getPluginConfig(interaction.guildId, "adb-plugin-autorole");
			const data = config?.data || {};
			data.enabled = enabled;
			await ctx.db.updatePluginConfig(interaction.guildId, "adb-plugin-autorole", data);

			return interaction.reply({
				content: `✅ Autorole plugin has been **${enabled ? "enabled" : "disabled"}** for this server.`,
			});
		}
	},
};
