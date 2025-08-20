import chalk from "chalk";

/**
 * Format duration in human-readable format
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  // Handle invalid input
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }

  // Round to nearest integer to avoid floating point issues
  const duration = Math.round(ms);

  if (duration < 1000) {
    return `${duration}ms`;
  }

  if (duration < 60000) {
    return `${(duration / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(duration / 60000);
  const seconds = Math.round((duration % 60000) / 1000);

  // Handle edge case where rounding seconds results in 60
  if (seconds === 60) {
    return `${minutes + 1}m 0s`;
  }

  return `${minutes}m ${seconds}s`;
}

/**
 * Format markdown text with chalk styling
 */
export function formatMarkdown(text: string): string {
  return text
    .replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => chalk.bold.blue(`${hashes} ${content}`))
    .replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"))
    .replace(/\*([^*]+)\*/g, chalk.italic("$1"))
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      return `${chalk.gray(`\`\`\`${lang || ""}`)}\n${chalk.green(code)}${chalk.gray("```")}`;
    })
    .replace(/`([^`]+)`/g, chalk.yellow("`$1`"))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, chalk.cyan("[$1]") + chalk.gray("($2)"))
    .replace(
      /^(\s*)([-*+])\s+(.+)$/gm,
      (_, spaces, bullet, content) => `${spaces}${chalk.yellow(bullet)} ${content}`
    )
    .replace(
      /^(\s*)(\d+\.)\s+(.+)$/gm,
      (_, spaces, num, content) => `${spaces}${chalk.yellow(num)} ${content}`
    );
}

/**
 * Colorize JSON string with chalk styling
 */
export function colorizeJSON(json: string): string {
  return json
    .replace(/"([^"]+)":/g, chalk.cyan('"$1":'))
    .replace(/: "([^"]+)"/g, `: ${chalk.green('"$1"')}`)
    .replace(/: (\d+)/g, `: ${chalk.yellow("$1")}`)
    .replace(/: (true|false)/g, `: ${chalk.magenta("$1")}`)
    .replace(/: null/g, `: ${chalk.gray("null")}`);
}
