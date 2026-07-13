const { Schema } = require("mongoose");

module.exports = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true, index: true },
	roleId: { type: String, required: true, index: true },
	action: { type: String, enum: ["add", "remove"], required: true },
	executeAt: { type: Date, required: true, index: true },
	createdAt: { type: Date, default: Date.now },
});
