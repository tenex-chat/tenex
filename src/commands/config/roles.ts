import * as fileSystem from "@/lib/fs";
import { ensureCacheLoaded, getModelInfo } from "@/llm/utils/models-dev-cache";
import type { AnyLLMConfiguration, TenexLLMs } from "@/services/config/types";
import { isMetaModelConfiguration } from "@/services/config/types";
import { config } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import * as display from "@/commands/config/display";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { createPrompt, useState, useKeypress, usePrefix, makeTheme, isUpKey, isDownKey, isEnterKey } from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";

type LLMRoleKey = "default" | "summarization" | "supervision" | "search" | "promptCompilation" | "compression";

const MODEL_ROLES: Array<{ key: LLMRoleKey; label: string; recommendation: string }> = [
    { key: "default", label: "Default", recommendation: "The default model all agents get — pick your best all-rounder" },
    { key: "summarization", label: "Summarization", recommendation: "Used for conversation metadata (summaries, titles) — choose a cheap model with a large context window" },
    { key: "supervision", label: "Supervision", recommendation: "Evaluates agent work and decides next steps — choose a model with strong reasoning" },
    { key: "search", label: "Search", recommendation: "Powers search queries — choose a web-connected model like Perplexity Sonar, or leave as default" },
    { key: "promptCompilation", label: "Prompt Compilation", recommendation: "Distills lessons into system prompts — choose a smart model with a large context window" },
    { key: "compression", label: "Compression", recommendation: "Compresses conversation history to fit context — choose a cheap model with a large context window" },
];

/**
 * Score and auto-select the best config for each role based on models.dev metadata.
 */
function autoSelectRoles(llmsConfig: TenexLLMs, configNames: string[]): void {
    interface ScoredConfig {
        name: string;
        inputCost: number;
        contextWindow: number;
    }

    const scored: ScoredConfig[] = [];
    for (const name of configNames) {
        const cfg = llmsConfig.configurations[name] as AnyLLMConfiguration;
        if (isMetaModelConfiguration(cfg)) continue;

        const info = getModelInfo(cfg.provider, cfg.model);
        if (!info?.cost || !info?.limit?.context) continue;

        scored.push({
            name,
            inputCost: info.cost.input,
            contextWindow: info.limit.context,
        });
    }

    if (scored.length === 0) return;

    const cheapestWithContext = (minContext: number): string | undefined => {
        const eligible = scored.filter((c) => c.contextWindow >= minContext);
        if (eligible.length === 0) return undefined;
        eligible.sort((a, b) => a.inputCost - b.inputCost);
        return eligible[0].name;
    };

    const mostExpensive = (minContext?: number): string | undefined => {
        const eligible = minContext ? scored.filter((c) => c.contextWindow >= minContext) : scored;
        if (eligible.length === 0) return undefined;
        eligible.sort((a, b) => b.inputCost - a.inputCost);
        return eligible[0].name;
    };

    const summarization = cheapestWithContext(100_000);
    if (summarization) llmsConfig.summarization = summarization;

    const compression = cheapestWithContext(0);
    if (compression) llmsConfig.compression = compression;

    const supervision = mostExpensive();
    if (supervision) llmsConfig.supervision = supervision;

    const promptCompilation = mostExpensive(100_000);
    if (promptCompilation) llmsConfig.promptCompilation = promptCompilation;

    const sonarConfig = configNames.find((name) => {
        const cfg = llmsConfig.configurations[name] as AnyLLMConfiguration;
        if (isMetaModelConfiguration(cfg)) return false;
        return cfg.model.toLowerCase().includes("sonar");
    });
    if (sonarConfig) llmsConfig.search = sonarConfig;
}

/**
 * Run the model role assignment interactively.
 */
export async function runRoleAssignment(): Promise<void> {
    const globalPath = config.getGlobalPath();
    const llmsConfig = await config.loadTenexLLMs(globalPath);
    const configNames = Object.keys(llmsConfig.configurations);

    if (configNames.length === 0) {
        display.hint("No model configurations found. Skipping role assignment.");
        display.context("Run tenex config llm to configure models first.");
        return;
    }

    if (configNames.length === 1) {
        const name = configNames[0];
        llmsConfig.default = name;
        await config.saveGlobalLLMs(llmsConfig);
        display.success(`All roles assigned to "${name}"`);
        return;
    }

    await ensureCacheLoaded();

    const defaultConfig = llmsConfig.default || configNames[0];

    for (const role of MODEL_ROLES) {
        if (!llmsConfig[role.key]) {
            llmsConfig[role.key] = defaultConfig;
        }
    }

    autoSelectRoles(llmsConfig, configNames);

    display.blank();

    const labelWidth = Math.max(...MODEL_ROLES.map((r) => r.label.length));

    const configChoices = configNames.map((name) => {
        const cfg = llmsConfig.configurations[name] as AnyLLMConfiguration;
        if (isMetaModelConfiguration(cfg)) {
            const variantCount = Object.keys(cfg.variants).length;
            return { name: `${name}  ${chalk.dim(`(multi-modal, ${variantCount} variants)`)}`, value: name };
        }
        const info = getModelInfo(cfg.provider, cfg.model);
        const parts: string[] = [];
        if (info?.limit?.context) {
            parts.push(`${Math.round(info.limit.context / 1000)}K ctx`);
        }
        if (info?.cost) {
            parts.push(`$${info.cost.input}/M in`);
        }
        const meta = parts.length > 0 ? `  ${chalk.dim(parts.join(" · "))}` : "";
        return { name: `${name}${meta}`, value: name };
    });

    const roleCount = MODEL_ROLES.length;
    const doneIndex = roleCount;

    type RoleMenuResult =
        | { action: "edit"; roleKey: LLMRoleKey }
        | { action: "done" };

    const roleMenuPrompt = createPrompt<RoleMenuResult, {
        message: string;
        roles: typeof MODEL_ROLES;
        assignments: Record<string, string>;
    }>((promptConfig, done) => {
        const theme = makeTheme(inquirerTheme);
        const prefix = usePrefix({ status: "idle", theme });
        const [active, setActive] = useState(0);
        const itemCount = roleCount + 1;

        useKeypress((key, rl) => {
            rl.clearLine(0);
            if (isUpKey(key)) {
                setActive(Math.max(0, active - 1));
            } else if (isDownKey(key)) {
                setActive(Math.min(itemCount - 1, active + 1));
            } else if (isEnterKey(key)) {
                if (active < roleCount) {
                    const role = promptConfig.roles[active]!;
                    done({ action: "edit", roleKey: role.key });
                } else {
                    done({ action: "done" });
                }
            }
        });

        const cursor = chalk.hex("#FFC107")("›");
        const lines: string[] = [];
        lines.push(`${prefix} ${theme.style.message(promptConfig.message, "idle")}`);
        lines.push("");

        for (let i = 0; i < roleCount; i++) {
            const role = promptConfig.roles[i]!;
            const assigned = promptConfig.assignments[role.key] || defaultConfig;
            const isActive = i === active;
            const pfx = isActive ? `${cursor} ` : "  ";
            const label = role.label.padEnd(labelWidth);
            const hint = isActive
                ? chalk.hex("#FFC107").dim(role.recommendation)
                : chalk.ansi256(240)(role.recommendation);
            lines.push(`${pfx}${chalk.bold(label)}  ${chalk.dim(assigned)}`);
            lines.push(`  ${hint}`);
        }

        lines.push(`  ${"─".repeat(40)}`);
        const donePfx = active === doneIndex ? `${cursor} ` : "  ";
        lines.push(`${donePfx}${display.doneLabel()}`);

        const helpParts = [
            `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
            `${chalk.bold("⏎")} ${chalk.dim("change")}`,
        ];
        lines.push(chalk.dim(`  ${helpParts.join(chalk.dim(" • "))}`));

        return `${lines.join("\n")}${cursorHide}`;
    });

    while (true) {
        const assignments: Record<string, string> = {};
        for (const role of MODEL_ROLES) {
            assignments[role.key] = (llmsConfig[role.key] as string) || defaultConfig;
        }

        const result = await roleMenuPrompt({
            message: "Model roles",
            roles: MODEL_ROLES,
            assignments,
        });

        if (result.action === "done") break;

        const role = MODEL_ROLES.find((r) => r.key === result.roleKey)!;
        const currentValue = assignments[result.roleKey]!;

        const { config: picked } = await inquirer.prompt([{
            type: "select",
            name: "config",
            message: `${role.label}:`,
            choices: configChoices,
            default: currentValue,
            theme: inquirerTheme,
        }]);

        llmsConfig[result.roleKey] = picked;
    }

    await config.saveGlobalLLMs(llmsConfig);
    display.success("Model roles saved");
}

export const rolesCommand = new Command("roles")
    .description("Configure which model handles what task")
    .action(async () => {
        try {
            ensureCacheLoaded().catch(() => {});

            const globalConfigDir = config.getGlobalPath();
            await fileSystem.ensureDirectory(globalConfigDir);

            await runRoleAssignment();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Failed to configure roles: ${error}`));
            process.exitCode = 1;
        }
    });
