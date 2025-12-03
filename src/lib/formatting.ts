import chalk from "chalk";

/**
 * Format markdown text with chalk styling
 */
export function formatMarkdown(text: string): string {
    return text
        .replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) =>
            chalk.bold.blue(`${hashes} ${content}`)
        )
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
