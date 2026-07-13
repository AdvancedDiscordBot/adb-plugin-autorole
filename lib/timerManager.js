const cron = require("node-cron");

/**
 * Simple in‑memory manager for role‑timer cron jobs per guild.
 * In the real plugin we store a reference to the scheduled task so we can
 * cancel/re‑schedule when the config changes. For the test harness we only need
 * start/stop functionality.
 */
class TimerManager {
	constructor() {
		/** @type {Map<string, cron.ScheduledTask>} guildId → task */
		this.tasks = new Map();
	}

	/**
	 * Start a periodic check for the given guild.
	 * "cronExpr" should be a standard node‑cron expression (e.g. "* * * * *").
	 */
	start(guildId, cronExpr, fn) {
		if (this.tasks.has(guildId)) this.stop(guildId);
		const task = cron.schedule(cronExpr, fn);
		this.tasks.set(guildId, task);
	}

	stop(guildId) {
		const task = this.tasks.get(guildId);
		if (task) {
			task.stop();
			this.tasks.delete(guildId);
		}
	}
}

module.exports = { TimerManager };
