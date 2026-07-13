const { Schema } = require("mongoose");

module.exports = new Schema({
	guildId: { type: String, required: true, index: true },
	roleId: { type: String, required: true, index: true },
	type: { type: String, enum: ["join", "bot", "level", "delayed", "remove-after"], required: true },
	level: { type: Number }, // Required only when type is "level"
	duration: { type: String }, // Required when type is "delayed" or "remove-after" (e.g., "1h", "30m")
	delayMs: { type: Number }, // Parsed duration in milliseconds
	createdAt: { type: Date, default: Date.now },
});
