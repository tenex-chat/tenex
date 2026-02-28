import chalk from "chalk";

// Match Rust TUI's xterm-256 color scheme exactly
const ACCENT = chalk.ansi256(214); // amber #FFC107
const INFO = chalk.ansi256(117); // sky blue
const SELECTED = chalk.ansi256(114); // bright green

/**
 * Print an onboarding step header with step number and color rule.
 *
 *   3/8  AI Providers
 *   ─────────────────────────────────────────────
 */
export function step(number: number, total: number, title: string): void {
    const rule = "─".repeat(45);
    console.log();
    console.log(`  ${ACCENT.bold(`${number}/${total}`)}  ${ACCENT.bold(title)}`);
    console.log(`  ${ACCENT(chalk.dim(rule))}`);
    console.log();
}

/**
 * Print dim context/explanation text, 2-space indent.
 */
export function context(text: string): void {
    for (const line of text.split("\n")) {
        console.log(`  ${chalk.dim(line)}`);
    }
}

/**
 * Print a success message: ✓ text
 */
export function success(text: string): void {
    console.log(`  ${chalk.green.bold("✓")} ${text}`);
}

/**
 * Print a hint/tip with a colored arrow.
 */
export function hint(text: string): void {
    console.log(`  ${ACCENT("→")} ${ACCENT(text)}`);
}

/**
 * Print a blank line.
 */
export function blank(): void {
    console.log();
}

/**
 * Print the welcome banner.
 */
export function welcome(): void {
    console.log();
    console.log(`  ${ACCENT.bold("▲ T E N E X")}`);
    console.log();
    console.log(`  ${chalk.bold("Your AI agent team, powered by Nostr.")}`);
    console.log(`  ${chalk.dim("Let's get everything set up.")}`);
    console.log();
}

/**
 * Print the final setup summary banner.
 */
export function setupComplete(): void {
    console.log();
    console.log(`  ${ACCENT.bold("▲")} ${ACCENT.bold("Setup complete!")}`);
    console.log();
}

/**
 * Print a summary line for the final recap.
 */
export function summaryLine(label: string, value: string): void {
    const paddedLabel = `${label}:`.padEnd(16);
    console.log(`    ${INFO(paddedLabel)}${value}`);
}

/**
 * Format a provider label with checkmark (for use in choices).
 */
export function providerCheck(text: string): string {
    return `${SELECTED.bold("[✓]")} ${text}`;
}

/**
 * Format a provider label with unchecked brackets (for use in choices).
 */
export function providerUncheck(text: string): string {
    return `${chalk.dim("[ ]")} ${text}`;
}

/**
 * Format a "Done" label in amber style.
 */
export function doneLabel(): string {
    return ACCENT.bold("  Done");
}
