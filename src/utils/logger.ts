import chalk from "chalk";

const levels: Record<string, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

// Helper to get current log level dynamically
function getCurrentLevel(): number {
  const LOG_LEVEL = process.env.LOG_LEVEL || "info";
  return levels[LOG_LEVEL] || levels.info;
}

// Helper to check if debug is enabled
function isDebugEnabled(): boolean {
  return process.env.DEBUG === "true";
}

// Color configuration for consistent output
const colors = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.blue,
  success: chalk.green,
  debug: chalk.gray,
};

const emojis = {
  error: "❌",
  warn: "⚠️",
  info: "ℹ️",
  success: "✅",
  debug: "🔍",
};

// Main logger object
export const logger = {
  error: (message: string, error?: unknown) => {
    if (getCurrentLevel() >= levels.error) {
      console.error(colors.error(`${emojis.error} ${message}`), error || "");
    }
  },

  warn: (message: string, ...args: unknown[]) => {
    if (getCurrentLevel() >= levels.warn) {
      console.warn(colors.warn(`${emojis.warn} ${message}`), ...args);
    }
  },

  warning: (message: string, ...args: unknown[]) => {
    logger.warn(message, ...args);
  },

  info: (message: string, ...args: unknown[]) => {
    if (getCurrentLevel() >= levels.info) {
      console.log(colors.info(`${emojis.info} ${message}`), ...args);
    }
  },

  success: (message: string, ...args: unknown[]) => {
    if (getCurrentLevel() >= levels.info) {
      console.log(colors.success(`${emojis.success} ${message}`), ...args);
    }
  },

  debug: (message: string, ...args: unknown[]) => {
    if (isDebugEnabled() && getCurrentLevel() >= levels.debug) {
      console.log(colors.debug(`${emojis.debug} ${message}`), ...args);
    }
  },
};

