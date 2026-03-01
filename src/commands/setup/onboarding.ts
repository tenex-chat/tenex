import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory } from "@/lib/fs";
import { agentStorage } from "@/agents/AgentStorage";
import { installAgentFromNostrEvent } from "@/agents/agent-installer";
import { detectOpenClawStateDir, readOpenClawCredentials, readOpenClawAgents } from "@/commands/agent/import/openclaw-reader";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { ensureCacheLoaded, getModelInfo } from "@/llm/utils/models-dev-cache";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { runProviderSetup } from "@/llm/utils/provider-setup";
import type { AnyLLMConfiguration, TenexLLMs, TenexProviders } from "@/services/config/types";
import { isMetaModelConfiguration } from "@/services/config/types";
import { config } from "@/services/ConfigService";
import { type EmbeddingConfig, EmbeddingProviderFactory } from "@/services/rag/EmbeddingProviderFactory";
import { ImageGenerationService, OPENROUTER_IMAGE_MODELS, ASPECT_RATIOS, IMAGE_SIZES, type ImageConfig } from "@/services/image/ImageGenerationService";
import { inquirerTheme } from "@/utils/cli-theme";
import * as display from "./display";
import { createPrompt, useState, useKeypress, usePrefix, makeTheme, isUpKey, isDownKey, isEnterKey, isBackspaceKey } from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import NDK, { NDKEvent, NDKPrivateKeySigner, NDKProject, type NDKSubscription } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { nip19 } from "nostr-tools";

type RelayItem =
    | { type: "choice"; name: string; value: string; description?: string }
    | { type: "input" };

const relayPrompt = createPrompt<string, {
    message: string;
    items: RelayItem[];
    inputPrefix?: string;
    inputPlaceholder?: string;
    validate?: (url: string) => true | string;
}>((config, done) => {
    const { items, inputPrefix = "wss://", inputPlaceholder = "Type a relay URL", validate } = config;
    const theme = makeTheme(inquirerTheme);
    const [active, setActive] = useState(0);
    const [inputValue, setInputValue] = useState("");
    const [status, setStatus] = useState<"idle" | "done">("idle");
    const [error, setError] = useState<string | undefined>();
    const prefix = usePrefix({ status, theme });

    useKeypress((key, rl) => {
        rl.clearLine(0);

        if (isEnterKey(key)) {
            const item = items[active];
            if (item.type === "input") {
                const fullUrl = inputPrefix + inputValue;
                if (validate) {
                    const result = validate(fullUrl);
                    if (result !== true) {
                        setError(result);
                        return;
                    }
                }
                setStatus("done");
                done(fullUrl);
            } else {
                setStatus("done");
                done(item.value);
            }
        } else if (isUpKey(key) || isDownKey(key)) {
            setError(undefined);
            const offset = isUpKey(key) ? -1 : 1;
            let next = active + offset;
            if (next < 0) next = 0;
            if (next >= items.length) next = items.length - 1;
            setActive(next);
        } else if (items[active].type === "input") {
            setError(undefined);
            if (isBackspaceKey(key)) {
                setInputValue(inputValue.slice(0, -1));
            } else {
                const ch = (key as unknown as { sequence?: string }).sequence;
                if (ch && !key.ctrl && ch.length === 1 && ch.charCodeAt(0) >= 32) {
                    setInputValue(inputValue + ch);
                }
            }
        }
    });

    const message = theme.style.message(config.message, status);

    if (status === "done") {
        const item = items[active];
        const answer = item.type === "input" ? inputPrefix + inputValue : item.name;
        return `${prefix} ${message} ${theme.style.answer(answer)}`;
    }

    const lines = items.map((item, i) => {
        const isActive = i === active;
        const cursor = isActive ? theme.icon.cursor : " ";

        if (item.type === "input") {
            const label = `${cursor} ${inputPlaceholder}`;
            const typedUrl = inputPrefix + inputValue;
            const desc = isActive ? `  ${chalk.gray(typedUrl)}` : "";
            return isActive ? theme.style.highlight(label) + desc : label;
        }

        const label = `${cursor} ${item.name}`;
        const desc = item.description ? `  ${chalk.gray(item.description)}` : "";
        return isActive ? theme.style.highlight(label) + desc : label + desc;
    });

    const errorLine = error ? "\n" + chalk.red(error) : "";
    return `${prefix} ${message}\n${lines.join("\n")}${errorLine}`;
});

function decodeToPubkey(identifier: string): string {
    if (/^[a-f0-9]{64}$/i.test(identifier)) {
        return identifier;
    }
    const decoded = nip19.decode(identifier);
    switch (decoded.type) {
        case "npub":
            return decoded.data;
        case "nprofile":
            return decoded.data.pubkey;
        default:
            throw new Error(`Unsupported identifier type: ${decoded.type}`);
    }
}

/**
 * Roles that can be assigned to specific LLM configurations.
 * Each role falls back to the "default" configuration when not explicitly set.
 */
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
 * Skips meta model configs (no single model to look up).
 * Falls back to defaultConfig for any role it can't score.
 */
function autoSelectRoles(
    llmsConfig: TenexLLMs,
    configNames: string[],
): void {
    // Build scored config list: { name, cost, context }
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

    // Helper: find the config that minimizes inputCost among those with context >= threshold
    const cheapestWithContext = (minContext: number): string | undefined => {
        const eligible = scored.filter((c) => c.contextWindow >= minContext);
        if (eligible.length === 0) return undefined;
        eligible.sort((a, b) => a.inputCost - b.inputCost);
        return eligible[0].name;
    };

    // Helper: find the most expensive config (proxy for strongest reasoning)
    const mostExpensive = (minContext?: number): string | undefined => {
        const eligible = minContext ? scored.filter((c) => c.contextWindow >= minContext) : scored;
        if (eligible.length === 0) return undefined;
        eligible.sort((a, b) => b.inputCost - a.inputCost);
        return eligible[0].name;
    };

    // Summarization: cheap + large context (>= 100K)
    const summarization = cheapestWithContext(100_000);
    if (summarization) llmsConfig.summarization = summarization;

    // Compression: cheapest with largest context window
    const compression = cheapestWithContext(0);
    if (compression) llmsConfig.compression = compression;

    // Supervision: most expensive (strongest reasoning)
    const supervision = mostExpensive();
    if (supervision) llmsConfig.supervision = supervision;

    // Prompt Compilation: most expensive with large context (>= 100K)
    const promptCompilation = mostExpensive(100_000);
    if (promptCompilation) llmsConfig.promptCompilation = promptCompilation;

    // Search: prefer models with "sonar" in the model ID (Perplexity via OpenRouter)
    const sonarConfig = configNames.find((name) => {
        const cfg = llmsConfig.configurations[name] as AnyLLMConfiguration;
        if (isMetaModelConfiguration(cfg)) return false;
        return cfg.model.toLowerCase().includes("sonar");
    });
    if (sonarConfig) llmsConfig.search = sonarConfig;
}

/**
 * Run the model role assignment step.
 * If only one configuration exists, auto-assigns all roles.
 * If multiple exist, auto-selects based on models.dev metadata then shows
 * a rich two-line menu for manual overrides.
 */
async function runRoleAssignment(): Promise<void> {
    const globalPath = config.getGlobalPath();
    const llmsConfig = await config.loadTenexLLMs(globalPath);
    const configNames = Object.keys(llmsConfig.configurations);

    if (configNames.length === 0) {
        display.hint("No model configurations found. Skipping role assignment.");
        display.context("Run tenex setup llm to configure models first.");
        return;
    }

    if (configNames.length === 1) {
        const name = configNames[0];
        llmsConfig.default = name;
        await config.saveGlobalLLMs(llmsConfig);
        display.success(`All roles assigned to "${name}"`);
        return;
    }

    // Load models.dev metadata for auto-selection scoring
    await ensureCacheLoaded();

    const defaultConfig = llmsConfig.default || configNames[0];

    // Ensure all roles start with the default config
    for (const role of MODEL_ROLES) {
        if (!llmsConfig[role.key]) {
            llmsConfig[role.key] = defaultConfig;
        }
    }

    // Auto-select roles using models.dev cost/context metadata
    autoSelectRoles(llmsConfig, configNames);

    // Multiple configurations — show role menu, enter to pick model
    display.blank();

    const labelWidth = Math.max(...MODEL_ROLES.map((r) => r.label.length));

    // Build config choices with models.dev metadata once
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
        const itemCount = roleCount + 1; // roles + Done

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

/**
 * Auto-select and confirm embedding model based on available providers.
 * Priority: OpenAI → OpenRouter → Local Transformers
 */
async function runEmbeddingSetup(providers: TenexProviders): Promise<void> {
    const configuredProviders = Object.keys(providers.providers);
    const existing = await EmbeddingProviderFactory.loadConfiguration({ scope: "global" });

    // Auto-pick the best default
    let defaultProvider: string;
    let defaultModel: string;
    if (configuredProviders.includes(PROVIDER_IDS.OPENAI)) {
        defaultProvider = PROVIDER_IDS.OPENAI;
        defaultModel = "text-embedding-3-small";
    } else if (configuredProviders.includes(PROVIDER_IDS.OPENROUTER)) {
        defaultProvider = PROVIDER_IDS.OPENROUTER;
        defaultModel = "openai/text-embedding-3-small";
    } else {
        defaultProvider = "local";
        defaultModel = "Xenova/all-MiniLM-L6-v2";
    }

    // Use existing config if present, otherwise use auto-picked default
    const provider = existing?.provider || defaultProvider;
    const model = existing?.model || defaultModel;

    const providerLabel = provider === "local" ? "Local Transformers"
        : provider === PROVIDER_IDS.OPENAI ? "OpenAI"
        : provider === PROVIDER_IDS.OPENROUTER ? "OpenRouter"
        : provider;

    display.context(`Recommended: ${providerLabel} / ${model}`);
    display.blank();

    const { action } = await inquirer.prompt([{
        type: "select",
        name: "action",
        message: "Embedding model",
        choices: [
            { name: `Use ${providerLabel} / ${model}`, value: "accept" },
            { name: "Choose a different model", value: "change" },
        ],
        theme: inquirerTheme,
    }]);

    if (action === "accept") {
        await EmbeddingProviderFactory.saveConfiguration({ provider, model }, "global");
        display.success(`Embeddings: ${providerLabel} / ${model}`);
        return;
    }

    // Full provider + model selection (reuse logic from embed.ts)
    const providerChoices: Array<{ name: string; value: string }> = [
        { name: "Local Transformers (runs on your machine)", value: "local" },
    ];
    if (configuredProviders.includes(PROVIDER_IDS.OPENAI)) {
        providerChoices.push({ name: "OpenAI", value: PROVIDER_IDS.OPENAI });
    }
    if (configuredProviders.includes(PROVIDER_IDS.OPENROUTER)) {
        providerChoices.push({ name: "OpenRouter", value: PROVIDER_IDS.OPENROUTER });
    }

    const { chosenProvider } = await inquirer.prompt([{
        type: "select",
        name: "chosenProvider",
        message: "Embedding provider",
        choices: providerChoices,
        default: provider,
        theme: inquirerTheme,
    }]);

    let chosenModel: string;
    if (chosenProvider === "local") {
        const { localModel } = await inquirer.prompt([{
            type: "select",
            name: "localModel",
            message: "Local embedding model",
            choices: [
                { name: "all-MiniLM-L6-v2 (fast, good for general use)", value: "Xenova/all-MiniLM-L6-v2" },
                { name: "all-mpnet-base-v2 (larger, better quality)", value: "Xenova/all-mpnet-base-v2" },
                { name: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual)", value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" },
            ],
            default: "Xenova/all-MiniLM-L6-v2",
            theme: inquirerTheme,
        }]);
        chosenModel = localModel;
    } else {
        const models = chosenProvider === PROVIDER_IDS.OPENAI
            ? [
                { name: "text-embedding-3-small (fast, good quality)", value: "text-embedding-3-small" },
                { name: "text-embedding-3-large (slower, best quality)", value: "text-embedding-3-large" },
            ]
            : [
                { name: "openai/text-embedding-3-small", value: "openai/text-embedding-3-small" },
                { name: "openai/text-embedding-3-large", value: "openai/text-embedding-3-large" },
            ];
        const { apiModel } = await inquirer.prompt([{
            type: "select",
            name: "apiModel",
            message: "Embedding model",
            choices: models,
            theme: inquirerTheme,
        }]);
        chosenModel = apiModel;
    }

    const embeddingConfig: EmbeddingConfig = { provider: chosenProvider, model: chosenModel };
    await EmbeddingProviderFactory.saveConfiguration(embeddingConfig, "global");
    display.success(`Embeddings: ${chosenProvider} / ${chosenModel}`);
}

/**
 * Auto-select and confirm image generation model.
 * Only available when OpenRouter is configured.
 */
async function runImageGenSetup(providers: TenexProviders): Promise<void> {
    if (!providers.providers[PROVIDER_IDS.OPENROUTER]?.apiKey) {
        display.hint("Image generation requires OpenRouter. Skipping.");
        display.context("Run tenex setup providers to add OpenRouter, then tenex setup image.");
        return;
    }

    const existing = await ImageGenerationService.loadConfiguration({ scope: "global" });
    const defaultModel = existing?.model || "black-forest-labs/flux.2-pro";
    const modelInfo = OPENROUTER_IMAGE_MODELS.find((m) => m.value === defaultModel);
    const modelLabel = modelInfo ? modelInfo.name : defaultModel;

    display.context(`Recommended: ${modelLabel}`);
    display.blank();

    const { action } = await inquirer.prompt([{
        type: "select",
        name: "action",
        message: "Image generation model",
        choices: [
            { name: `Use ${modelLabel} (${defaultModel})`, value: "accept" },
            { name: "Choose a different model", value: "change" },
            { name: "Skip image generation", value: "skip" },
        ],
        theme: inquirerTheme,
    }]);

    if (action === "skip") {
        display.hint("Skipped. Run tenex setup image later to configure.");
        return;
    }

    let selectedModel = defaultModel;
    let selectedRatio = existing?.defaultAspectRatio || "1:1";
    let selectedSize = existing?.defaultImageSize || "2K";

    if (action === "change") {
        const modelChoices = OPENROUTER_IMAGE_MODELS.map((m) => ({
            name: `${m.name} — ${m.description}`,
            value: m.value,
        }));

        const { model } = await inquirer.prompt([{
            type: "select",
            name: "model",
            message: "Image generation model",
            choices: modelChoices,
            default: defaultModel,
            theme: inquirerTheme,
        }]);
        selectedModel = model;

        const { aspectRatio } = await inquirer.prompt([{
            type: "select",
            name: "aspectRatio",
            message: "Default aspect ratio",
            choices: ASPECT_RATIOS.map((r) => ({ name: r, value: r })),
            default: selectedRatio,
            theme: inquirerTheme,
        }]);
        selectedRatio = aspectRatio;

        const { imageSize } = await inquirer.prompt([{
            type: "select",
            name: "imageSize",
            message: "Default image size",
            choices: IMAGE_SIZES.map((s) => ({ name: s, value: s })),
            default: selectedSize,
            theme: inquirerTheme,
        }]);
        selectedSize = imageSize;
    }

    const imageConfig: ImageConfig = {
        provider: "openrouter",
        model: selectedModel,
        defaultAspectRatio: selectedRatio,
        defaultImageSize: selectedSize,
    };
    await ImageGenerationService.saveConfiguration(imageConfig, "global");

    const savedModelInfo = OPENROUTER_IMAGE_MODELS.find((m) => m.value === selectedModel);
    display.success(`Image generation: ${savedModelInfo?.name || selectedModel}`);
}

// ─── LLM Config Seeding ──────────────────────────────────────────────────────

/**
 * Seed default LLM configurations based on which providers are available.
 * Only runs when there are zero existing configurations.
 *
 * Priority: Anthropic if present, then OpenAI.
 * Creates a meta-model "Auto" config when Anthropic is available.
 */
async function seedDefaultLLMConfigs(providers: TenexProviders): Promise<void> {
    const globalPath = config.getGlobalPath();
    const llmsConfig = await config.loadTenexLLMs(globalPath);

    if (Object.keys(llmsConfig.configurations).length > 0) return;

    const connected = Object.keys(providers.providers);
    const hasAnthropic = connected.includes(PROVIDER_IDS.ANTHROPIC);

    if (hasAnthropic) {
        llmsConfig.configurations["Sonnet"] = {
            provider: PROVIDER_IDS.ANTHROPIC,
            model: "claude-sonnet-4-6",
        };
        llmsConfig.configurations["Opus"] = {
            provider: PROVIDER_IDS.ANTHROPIC,
            model: "claude-opus-4-6",
        };
        llmsConfig.configurations["Auto"] = {
            provider: "meta",
            variants: {
                fast: {
                    model: "Sonnet",
                    keywords: ["quick", "fast"],
                    description: "Fast, lightweight tasks",
                },
                powerful: {
                    model: "Opus",
                    keywords: ["think", "ultrathink", "ponder"],
                    description: "Most capable, complex reasoning",
                },
            },
            default: "fast",
        };
        llmsConfig.default = "Auto";
    }

    if (connected.includes(PROVIDER_IDS.OPENAI)) {
        llmsConfig.configurations["GPT-4o"] = {
            provider: PROVIDER_IDS.OPENAI,
            model: "gpt-4o",
        };
        if (!llmsConfig.default) {
            llmsConfig.default = "GPT-4o";
        }
    }

    if (Object.keys(llmsConfig.configurations).length > 0) {
        await config.saveGlobalLLMs(llmsConfig);
        for (const [name, cfg] of Object.entries(llmsConfig.configurations)) {
            const detail = cfg.provider === "meta" ? "meta-model" : `${cfg.provider}/${(cfg as { model: string }).model}`;
            display.success(`Seeded: ${name} (${detail})`);
        }
    }
}

// ─── Provider Auto-Detection ─────────────────────────────────────────────────

/**
 * Check if a command exists on the system.
 */
function commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile("/bin/sh", ["-c", `command -v ${cmd}`], (err) => {
            resolve(!err);
        });
    });
}

/**
 * Check if Ollama is reachable at localhost:11434.
 */
async function ollamaReachable(): Promise<boolean> {
    try {
        const response = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        return response.ok;
    } catch {
        return false;
    }
}

interface DetectionResult {
    providers: TenexProviders;
    openClawStateDir: string | null;
    detectedSources: string[];
    claudeCliDetected: boolean;
}

/**
 * Auto-detect provider credentials from environment variables, local commands,
 * Ollama, and OpenClaw installations. Merges into existing providers.
 * Pass a pre-detected openClawStateDir to avoid redundant filesystem checks.
 */
async function autoDetectProviders(existing: TenexProviders, preDetectedOpenClawDir?: string | null): Promise<DetectionResult> {
    const providers = { ...existing, providers: { ...existing.providers } };
    const detectedSources: string[] = [];

    // 1. Detect local CLI commands
    const [hasClaude, hasCodex] = await Promise.all([
        commandExists("claude"),
        commandExists("codex"),
    ]);

    if (hasCodex && !providers.providers[PROVIDER_IDS.CODEX_APP_SERVER]) {
        providers.providers[PROVIDER_IDS.CODEX_APP_SERVER] = { apiKey: "none" };
        detectedSources.push("Codex CLI (codex-app-server)");
    }

    // 2. Detect Ollama
    if (!providers.providers[PROVIDER_IDS.OLLAMA]) {
        if (await ollamaReachable()) {
            providers.providers[PROVIDER_IDS.OLLAMA] = { apiKey: "http://localhost:11434" };
            detectedSources.push("Ollama (localhost:11434)");
        }
    }

    // 3. Environment variable API keys
    const envMap: Array<{ envVar: string; providerId: string; label: string }> = [
        { envVar: "ANTHROPIC_API_KEY", providerId: PROVIDER_IDS.ANTHROPIC, label: "Anthropic (from ANTHROPIC_API_KEY)" },
        { envVar: "OPENAI_API_KEY", providerId: PROVIDER_IDS.OPENAI, label: "OpenAI (from OPENAI_API_KEY)" },
        { envVar: "OPENROUTER_API_KEY", providerId: PROVIDER_IDS.OPENROUTER, label: "OpenRouter (from OPENROUTER_API_KEY)" },
    ];
    for (const { envVar, providerId, label } of envMap) {
        const value = process.env[envVar];
        if (value && !providers.providers[providerId]) {
            providers.providers[providerId] = { apiKey: value };
            detectedSources.push(label);
        }
    }

    // 4. Anthropic OAuth setup-token
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (authToken?.startsWith("sk-ant-oat") && !providers.providers[PROVIDER_IDS.ANTHROPIC]) {
        providers.providers[PROVIDER_IDS.ANTHROPIC] = { apiKey: authToken };
        detectedSources.push("Anthropic (from ANTHROPIC_AUTH_TOKEN)");
    }

    // 5. OpenClaw credentials
    const openClawStateDir = preDetectedOpenClawDir !== undefined
        ? preDetectedOpenClawDir
        : await detectOpenClawStateDir();
    if (openClawStateDir) {
        const credentials = await readOpenClawCredentials(openClawStateDir);
        for (const cred of credentials) {
            if (!providers.providers[cred.provider]) {
                providers.providers[cred.provider] = { apiKey: cred.apiKey };
                detectedSources.push(`${cred.provider} (from OpenClaw)`);
            }
        }
    }

    return { providers, openClawStateDir, detectedSources, claudeCliDetected: hasClaude };
}

function buildProviderHints(detection: DetectionResult): Record<string, string> {
    const hints: Record<string, string> = {};
    if (detection.claudeCliDetected && !detection.providers.providers[PROVIDER_IDS.ANTHROPIC]) {
        hints[PROVIDER_IDS.ANTHROPIC] = "via claude setup-token";
    }
    return hints;
}

// ─── Nostr Agent Discovery Types ─────────────────────────────────────────────

interface FetchedTeam {
    id: string;
    title: string;
    description: string;
    agentEventIds: string[];
}

interface FetchedAgent {
    id: string;
    name: string;
    role: string;
    description: string;
    event: NDKEvent;
}

interface FetchResults {
    teams: FetchedTeam[];
    agents: FetchedAgent[];
}

function agentsForTeam(results: FetchResults, team: FetchedTeam): FetchedAgent[] {
    const agentIndex = new Map(results.agents.map((a) => [a.id, a]));
    return team.agentEventIds
        .map((eid) => agentIndex.get(eid))
        .filter((a): a is FetchedAgent => a !== undefined);
}

// ─── Streaming Agent Discovery ──────────────────────────────────────────────

interface AgentDiscovery {
    ndk: NDK;
    subscription: NDKSubscription;
    events: Map<string, NDKEvent>;
}

function startAgentDiscovery(relays: string[]): AgentDiscovery {
    const ndk = new NDK({ explicitRelayUrls: relays, enableOutboxModel: false });
    ndk.connect(); // fire-and-forget — NDK handles reconnection, subscription queues until connected

    const events = new Map<string, NDKEvent>();
    const TEAM_KIND = 34199;

    const subscription = ndk.subscribe(
        { kinds: [...NDKAgentDefinition.kinds, TEAM_KIND] as number[] },
        { closeOnEose: false },
        { onEvent: (event: NDKEvent) => { events.set(event.id, event); } },
    );

    return { ndk, subscription, events };
}

// ─── Project & Agents Step ───────────────────────────────────────────────────

/**
 * Stop the streaming subscription and resolve accumulated events into
 * typed agents and teams with deduplication.
 */
function resolveAgentDiscovery(discovery: AgentDiscovery): FetchResults {
    discovery.subscription.stop();

    const TEAM_KIND = 34199;
    const teams: FetchedTeam[] = [];
    const agents: FetchedAgent[] = [];

    for (const event of discovery.events.values()) {
        const kind = event.kind;

        if (kind === TEAM_KIND) {
            const title = event.tagValue("title") || "";
            if (!title) continue;
            const description = event.content || event.tagValue("description") || "";
            const agentEventIds = event.tags
                .filter((t: string[]) => t[0] === "e" && t[1])
                .map((t: string[]) => t[1]);
            teams.push({ id: event.id, title, description, agentEventIds });
        } else if (kind !== undefined && NDKAgentDefinition.kinds.includes(kind)) {
            const name = event.tagValue("title") || "Unnamed Agent";
            const role = event.tagValue("role") || "";
            const description = event.tagValue("description") || event.content || "";
            agents.push({ id: event.id, name, role, description, event });
        }
    }

    // Dedup teams by title (keep first)
    const seenTeamTitles = new Set<string>();
    const dedupedTeams = teams.filter((t) => {
        if (seenTeamTitles.has(t.title)) return false;
        seenTeamTitles.add(t.title);
        return true;
    });

    // Dedup agents by pubkey+d-tag (keep newest)
    const latestAgents = new Map<string, FetchedAgent>();
    const noDtagAgents: FetchedAgent[] = [];
    for (const agent of agents) {
        const dTag = agent.event.tagValue("d") || "";
        if (!dTag) {
            noDtagAgents.push(agent);
            continue;
        }
        const key = `${agent.event.pubkey}:${dTag}`;
        const existing = latestAgents.get(key);
        if (!existing || (agent.event.created_at || 0) > (existing.event.created_at || 0)) {
            latestAgents.set(key, agent);
        }
    }
    const dedupedAgents = [...Array.from(latestAgents.values()), ...noDtagAgents];

    return { teams: dedupedTeams, agents: dedupedAgents };
}

/**
 * Run the Project & Agents onboarding step.
 *
 * Replicates the Rust TUI's step_first_project_and_agents:
 * 1. Ask about creating a Meta project
 * 2. Discover agents and teams from Nostr
 * 3. Two-tier selection: teams first, then individual agents
 * 4. Install selected agents
 * 5. Publish kind 31933 project event
 */
async function runProjectAndAgentsStep(
    discovery: AgentDiscovery,
    userPrivateKeyHex: string,
    openClawStateDir: string | null,
): Promise<void> {
    // ── Part A: Ask about Meta project ──────────────────────────────────────
    display.context(
        "Projects organize what your agents work on. We suggest starting with a\n" +
        "\"Meta\" project — a command center where agents track everything else.",
    );
    display.blank();

    const { createMeta } = await inquirer.prompt([{
        type: "confirm",
        name: "createMeta",
        message: "Create a Meta project?",
        default: true,
        theme: inquirerTheme,
    }]);

    if (!createMeta) {
        display.blank();
        display.context("Sure thing. You can create projects anytime from the dashboard.");
        return;
    }

    // ── Part B: Agent selection ─────────────────────────────────────────────
    display.blank();
    display.context("Pick a pre-built agent team or choose individual agents.");
    display.blank();

    const { ndk } = discovery;
    const fetchResults = resolveAgentDiscovery(discovery);

    const hasNostrAgents = fetchResults.agents.length > 0;

    if (!openClawStateDir && !hasNostrAgents) {
        display.context("No agents available right now.");
        display.hint("You can browse and hire agents later from the dashboard.");
    }

    let installedCount = 0;
    const nostrAgentEventIds: string[] = [];

    // ── Section B.1: OpenClaw agents ────────────────────────────────────────
    if (openClawStateDir) {
        const openClawAgents = await readOpenClawAgents(openClawStateDir);

        if (openClawAgents.length > 0) {
            display.hint("Found your OpenClaw agents:");
            display.blank();

            const { selected } = await inquirer.prompt([{
                type: "checkbox",
                name: "selected",
                message: "Import your OpenClaw agents? (space to toggle, enter to confirm)",
                choices: openClawAgents.map((a) => ({
                    name: chalk.ansi256(214)(a.id),
                    value: a.id,
                    checked: true,
                })),
                theme: inquirerTheme,
            }]);

            if (selected.length > 0) {
                display.context("Importing agents (this may take a moment)...");
                display.blank();

                const slugsArg = (selected as string[]).join(",");
                await new Promise<void>((resolve) => {
                    const binPath = process.argv[1];
                    execFile(process.argv[0], [binPath, "agent", "import", "openclaw", "--slugs", slugsArg], (err, stdout, stderr) => {
                        if (stdout) process.stdout.write(stdout);
                        if (stderr) process.stderr.write(stderr);
                        if (err) {
                            display.context("OpenClaw import encountered an issue — check daemon logs.");
                        } else {
                            installedCount += selected.length;
                        }
                        resolve();
                    });
                });

                display.blank();
            }
        }
    }

    // ── Section B.2: Nostr agents (team + individual selection) ─────────────
    if (fetchResults.agents.length > 0) {
        const results = fetchResults;
        const installedAgentIds: string[] = [];

        while (true) {
            // Only show teams that still have uninstalled agents
            const availableTeams = results.teams.filter((team) =>
                agentsForTeam(results, team).some((a) => !installedAgentIds.includes(a.id)),
            );

            const hasRemainingAgents = results.agents.some(
                (a) => !installedAgentIds.includes(a.id),
            );

            // Nothing left to offer
            if (availableTeams.length === 0 && !hasRemainingAgents) break;

            // Build menu choices
            const menuChoices: Array<{ name: string; value: string }> = [];

            // Team entries
            for (const team of availableTeams) {
                const agentCount = agentsForTeam(results, team)
                    .filter((a) => !installedAgentIds.includes(a.id)).length;
                const label = team.description
                    ? `${team.title} — ${team.description} (${agentCount} agents)`
                    : `${team.title} (${agentCount} agents)`;
                menuChoices.push({ name: label, value: `team:${team.id}` });
            }

            // "Add individual agents" entry
            if (hasRemainingAgents) {
                menuChoices.push({ name: "Add individual agents", value: "__individual__" });
            }

            // "Done" entry
            menuChoices.push({ name: "Done", value: "__done__" });

            const { selection } = await inquirer.prompt([{
                type: "select",
                name: "selection",
                message: "Add agents",
                choices: menuChoices,
                theme: inquirerTheme,
            }]);

            if (selection === "__done__") break;

            if (selection === "__individual__") {
                // Individual agent multi-select
                const remaining = results.agents.filter(
                    (a) => !installedAgentIds.includes(a.id),
                );

                const { selected } = await inquirer.prompt([{
                    type: "checkbox",
                    name: "selected",
                    message: "Select agents (space to toggle, enter to confirm)",
                    choices: remaining.map((a) => {
                        const label = a.role
                            ? `${a.name.padEnd(20)} ${a.role} — ${a.description}`
                            : `${a.name.padEnd(20)} ${a.description}`;
                        return { name: label, value: a.id };
                    }),
                    theme: inquirerTheme,
                }]);

                if ((selected as string[]).length > 0) {
                    const selectedAgents = remaining.filter((a) => (selected as string[]).includes(a.id));

                    for (const agent of selectedAgents) {
                        try {
                            await installAgentFromNostrEvent(agent.event, undefined, ndk);
                            nostrAgentEventIds.push(agent.id);
                            installedAgentIds.push(agent.id);
                            installedCount++;
                        } catch (err) {
                            display.context(`Failed to install "${agent.name}": ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }

                    display.blank();
                    const names = selectedAgents.map((a) => a.name).join(", ");
                    display.success(`Installed ${selectedAgents.length} agent(s): ${names}`);
                }
                continue;
            }

            // Team selected
            const teamId = selection.replace("team:", "");
            const team = results.teams.find((t) => t.id === teamId);
            if (!team) continue;

            const teamAgents = agentsForTeam(results, team)
                .filter((a) => !installedAgentIds.includes(a.id));

            if (teamAgents.length === 0) continue;

            display.blank();
            display.hint(`Agents in ${team.title}:`);
            for (const a of teamAgents) {
                console.log(`    ${chalk.ansi256(117)("●")} ${chalk.bold(a.name.padEnd(20))} ${chalk.dim(a.role)}`);
            }

            for (const agent of teamAgents) {
                try {
                    await installAgentFromNostrEvent(agent.event, undefined, ndk);
                    nostrAgentEventIds.push(agent.id);
                    installedAgentIds.push(agent.id);
                    installedCount++;
                } catch (err) {
                    display.context(`Failed to install "${agent.name}": ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            display.blank();
            const names = teamAgents.map((a) => a.name).join(", ");
            display.success(`Team "${team.title}" installed: ${names}`);
        }
    }

    if (installedCount > 0) {
        display.blank();
        display.success(`${installedCount} agent(s) ready.`);
    }

    // ── Part C: Publish kind 31933 project event ──────────────────────────
    // The daemon handles directory creation, git init, and agent loading on boot.
    // We just publish the event with agent tags — the daemon discovers it from relays.
    try {
        const signer = new NDKPrivateKeySigner(userPrivateKeyHex);
        ndk.signer = signer;

        const project = new NDKProject(ndk);
        project.dTag = "meta";
        project.title = "Meta";
        project.tags.push(["client", "tenex-setup"]);

        for (const eid of nostrAgentEventIds) {
            project.tags.push(["agent", eid]);
        }

        await project.sign();
        await project.publish();

        display.success("Published \"Meta\" project to relays.");

        // Give relays a moment to propagate
        await new Promise((r) => setTimeout(r, 2_000));
    } catch {
        display.context("Could not publish project event — the daemon will pick it up later.");
    }

    // Locally associate non-Nostr agents (e.g. OpenClaw imports) with the meta project.
    // These don't have event IDs so they aren't referenced in the project event's agent tags;
    // the daemon needs the local storage association to find them.
    await agentStorage.initialize();
    const allStoredAgents = await agentStorage.getAllAgents();
    for (const agent of allStoredAgents) {
        if (agent.eventId) continue; // Nostr agents are associated via project event tags
        const signer = new NDKPrivateKeySigner(agent.nsec);
        await agentStorage.addAgentToProject(signer.pubkey, "meta");
    }

    display.blank();
    display.success("Created \"Meta\" project.");
}

interface OnboardingOptions {
    pubkey?: string[];
    localRelayUrl?: string;
    json?: boolean;
}

/**
 * Full onboarding flow — identity, relay, providers, models, project & agents.
 */
async function runOnboarding(options: OnboardingOptions): Promise<void> {
    const jsonMode = options.json === true;
    const globalPath = config.getGlobalPath();
    await ensureDirectory(globalPath);
    const existingConfig = await config.loadTenexConfig(globalPath);

    // Quick OpenClaw detection so we can compute total steps upfront
    const earlyOpenClawDir = await detectOpenClawStateDir();
    // Steps: Identity, Communication, Providers, Models, Roles, Embeddings, Image Gen, Project & Agents
    const totalSteps = 8;

    // Step 1: Identity
    if (!jsonMode) {
        display.step(1, totalSteps, "Identity");
        display.context("Your identity is how your agents know you, and how others can reach you.");
        display.blank();
    }

    let whitelistedPubkeys: string[];
    let generatedNsec: string | undefined;
    let userPrivateKeyHex: string | undefined;

    if (options.pubkey) {
        whitelistedPubkeys = options.pubkey.map((pk) => decodeToPubkey(pk.trim()));
    } else {
        const { identityChoice } = await inquirer.prompt([
            {
                type: "select",
                name: "identityChoice",
                message: "How do you want to set up your identity?",
                choices: [
                    { name: "Create a new identity", value: "create" },
                    { name: "I have an existing one (import nsec)", value: "import" },
                ],
                theme: inquirerTheme,
            },
        ]);

        if (identityChoice === "create") {
            const signer = NDKPrivateKeySigner.generate();
            if (!signer.privateKey) throw new Error("Failed to generate private key");
            const privkey = signer.privateKey;
            const user = await signer.user();
            const pubkey = user.pubkey;
            const npub = nip19.npubEncode(pubkey);
            const nsec = nip19.nsecEncode(Buffer.from(privkey, "hex"));

            whitelistedPubkeys = [pubkey];
            generatedNsec = nsec;
            userPrivateKeyHex = privkey;

            if (!jsonMode) {
                display.blank();
                display.success("Identity created");
                display.blank();
                display.summaryLine("npub", npub);
                display.summaryLine("nsec", nsec);
                display.blank();
                display.hint("Save your nsec somewhere safe. You won't be able to recover it.");
                display.blank();
            }
        } else {
            const { nsecInput } = await inquirer.prompt([
                {
                    type: "password",
                    name: "nsecInput",
                    message: "Paste your nsec (hidden)",
                    mask: "*",
                    validate: (input: string) => {
                        if (!input.trim()) return "nsec is required";
                        try {
                            const decoded = nip19.decode(input.trim());
                            if (decoded.type !== "nsec") return "Invalid nsec";
                            return true;
                        } catch {
                            return "Invalid nsec format";
                        }
                    },
                    theme: inquirerTheme,
                },
            ]);

            const decoded = nip19.decode(nsecInput.trim());
            const privkeyBytes = decoded.data as unknown as Uint8Array;
            const privkeyHex = Buffer.from(privkeyBytes).toString("hex");
            const signer = new NDKPrivateKeySigner(privkeyHex);
            const user = await signer.user();
            const pubkey = user.pubkey;
            const npub = nip19.npubEncode(pubkey);

            whitelistedPubkeys = [pubkey];
            userPrivateKeyHex = privkeyHex;

            if (!jsonMode) {
                display.blank();
                display.success("Identity imported");
                display.summaryLine("npub", npub);
                display.blank();
            }
        }
    }

    // Daemon private key (auto-generated, no UI)
    let tenexPrivateKey = existingConfig.tenexPrivateKey;
    if (!tenexPrivateKey) {
        const signer = NDKPrivateKeySigner.generate();
        tenexPrivateKey = signer.privateKey;
        if (!tenexPrivateKey) {
            if (jsonMode) {
                console.log(JSON.stringify({ error: "Failed to generate daemon key" }));
            } else {
                console.error(chalk.red("Failed to generate daemon key"));
            }
            process.exit(1);
        }
    }

    // Projects directory (default ~/tenex)
    const projectsBase = existingConfig.projectsBase || path.join(os.homedir(), "tenex");

    // Step 2: Communication
    if (!jsonMode) {
        display.step(2, totalSteps, "Communication");
        display.context("Choose a relay for your agents to communicate through.");
        display.blank();
    }

    const relayItems: RelayItem[] = [
        { type: "choice", name: "TENEX Community Relay", value: "wss://tenex.chat", description: "wss://tenex.chat" },
        { type: "input" },
    ];

    if (options.localRelayUrl) {
        relayItems.push({
            type: "choice",
            name: "Local relay",
            value: options.localRelayUrl,
            description: options.localRelayUrl,
        });
    }

    const relay = await relayPrompt({
        message: "Relay",
        items: relayItems,
        validate: (url: string) => {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
                    return "URL must use ws:// or wss:// protocol";
                }
                if (!parsed.hostname || !parsed.hostname.includes(".")) {
                    return "Enter a relay hostname";
                }
                return true;
            } catch {
                return "Invalid URL format";
            }
        },
    });

    const relays = [relay];

    // Start agent discovery early — NDK connects and streams events in the
    // background while the user configures providers, models, etc. (steps 3-7).
    // By step 8, agents have already accumulated.
    const agentDiscovery = startAgentDiscovery(relays);

    // Save configuration
    const newConfig = {
        ...existingConfig,
        whitelistedPubkeys,
        tenexPrivateKey,
        projectsBase: path.resolve(projectsBase),
        relays,
    };

    await config.saveGlobalConfig(newConfig);
    await ensureDirectory(path.resolve(projectsBase));

    // Auto-detect providers from env vars, local commands, Ollama, and OpenClaw
    const existingProviders = await config.loadTenexProviders(globalPath);
    const detection = await autoDetectProviders(existingProviders, earlyOpenClawDir);

    if (detection.detectedSources.length > 0) {
        for (const source of detection.detectedSources) {
            display.success(`Detected: ${source}`);
        }
        display.blank();
    }

    // Step 3: Providers
    display.step(3, totalSteps, "AI Providers");
    display.context("Connect the AI services your agents will use. You need at least one.");
    display.blank();

    const providerHints = buildProviderHints(detection);
    const updatedProviders = await runProviderSetup(detection.providers, { providerHints });
    await config.saveGlobalProviders(updatedProviders);
    display.success("Provider credentials saved");

    // Step 4: Models
    if (Object.keys(updatedProviders.providers).length > 0) {
        await seedDefaultLLMConfigs(updatedProviders);

        display.step(4, totalSteps, "Models");
        display.context("Configure which models your agents will use.");
        display.blank();

        const llmEditor = new LLMConfigEditor();
        await llmEditor.showMainMenu();

        // Step 5: Model Roles
        display.step(5, totalSteps, "Model Roles");
        await runRoleAssignment();

        // Step 6: Embeddings
        display.step(6, totalSteps, "Embeddings");
        display.context("Choose an embedding model for semantic search and RAG.");
        display.blank();
        await runEmbeddingSetup(updatedProviders);

        // Step 7: Image Generation
        display.step(7, totalSteps, "Image Generation");
        display.context("Configure image generation for your agents.");
        display.blank();
        await runImageGenSetup(updatedProviders);

        // Step 8: Project & Agents
        if (userPrivateKeyHex) {
            display.step(8, totalSteps, "Project & Agents");
            await runProjectAndAgentsStep(
                agentDiscovery,
                userPrivateKeyHex,
                detection.openClawStateDir,
            );
        } else {
            agentDiscovery.subscription.stop();
        }
    } else {
        agentDiscovery.subscription.stop();
        display.blank();
        display.hint("Skipping model configuration (no providers configured)");
        display.context("Run tenex setup providers and tenex setup llm later to configure models.");
        display.blank();
    }

    // Final summary
    if (jsonMode) {
        const output: Record<string, unknown> = {
            npub: nip19.npubEncode(whitelistedPubkeys[0]),
            pubkey: whitelistedPubkeys[0],
            projectsBase: path.resolve(projectsBase),
            relays,
        };
        if (generatedNsec) {
            output.nsec = generatedNsec;
        }
        console.log(JSON.stringify(output, null, 2));
    } else {
        display.setupComplete();
        display.summaryLine("Identity", nip19.npubEncode(whitelistedPubkeys[0]));
        display.summaryLine("Projects", path.resolve(projectsBase));
        display.summaryLine("Relays", relays.join(", "));
        display.blank();
        display.hint("You can now start using TENEX!");
        display.blank();
    }

    process.exit(0);
}

export const onboardingCommand = new Command("init")
    .description("Initial setup wizard for TENEX")
    .option("--pubkey <pubkeys...>", "Pubkeys to whitelist (npub, nprofile, or hex)")
    .option("--local-relay-url <url>", "URL of a running local relay to offer as an option")
    .option("--json", "Output configuration as JSON")
    .action(async (options: OnboardingOptions) => {
        try {
            await runOnboarding(options);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                process.exit(0);
            }
            console.error(chalk.red(`Setup failed: ${error}`));
            process.exit(1);
        }
    });
