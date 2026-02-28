import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory } from "@/lib/fs";
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
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
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

interface OnboardingOptions {
    pubkey?: string[];
    localRelayAvailable?: boolean;
    json?: boolean;
    stepOffset?: string;
    totalSteps?: string;
}

/**
 * Delegated flow: called from Rust TUI with --pubkey --step-offset --total-steps.
 * Only runs Providers + Models steps, then exits.
 */
async function runDelegatedFlow(
    pubkeys: string[],
    stepOffset: number,
    totalSteps: number,
): Promise<void> {
    const globalPath = config.getGlobalPath();
    await ensureDirectory(globalPath);
    const existingConfig = await config.loadTenexConfig(globalPath);

    // Silently whitelist the pubkey
    const whitelistedPubkeys = pubkeys.map((pk) => decodeToPubkey(pk.trim()));

    // Generate tenex private key if missing
    let tenexPrivateKey = existingConfig.tenexPrivateKey;
    if (!tenexPrivateKey) {
        const signer = NDKPrivateKeySigner.generate();
        tenexPrivateKey = signer.privateKey;
        if (!tenexPrivateKey) {
            console.error(chalk.red("Failed to generate daemon key"));
            process.exit(1);
        }
    }

    // Save config with pubkey whitelisted
    await config.saveGlobalConfig({
        ...existingConfig,
        whitelistedPubkeys,
        tenexPrivateKey,
    });

    // Step N: AI Providers
    display.step(stepOffset, totalSteps, "AI Providers");
    display.context("Connect the AI services your agents will use. You need at least one.");
    display.blank();

    const existingProviders = await config.loadTenexProviders(globalPath);
    const updatedProviders = await runProviderSetup(existingProviders);
    await config.saveGlobalProviders(updatedProviders);
    display.success("Provider credentials saved");

    // Step N+1: Models
    if (Object.keys(updatedProviders.providers).length > 0) {
        display.step(stepOffset + 1, totalSteps, "Models");
        display.context("Configure which models your agents will use.");
        display.blank();

        const llmEditor = new LLMConfigEditor();
        await llmEditor.showMainMenu();

        // Step N+2: Model Roles
        display.step(stepOffset + 2, totalSteps, "Model Roles");
        await runRoleAssignment();

        // Step N+3: Embeddings
        display.step(stepOffset + 3, totalSteps, "Embeddings");
        display.context("Choose an embedding model for semantic search and RAG.");
        display.blank();
        await runEmbeddingSetup(updatedProviders);

        // Step N+4: Image Generation
        display.step(stepOffset + 4, totalSteps, "Image Generation");
        display.context("Configure image generation for your agents.");
        display.blank();
        await runImageGenSetup(updatedProviders);
    } else {
        display.blank();
        display.hint("Skipping model configuration (no providers configured)");
        display.context("Run tenex setup providers and tenex setup llm later to configure models.");
    }

    process.exit(0);
}

/**
 * Standalone flow: full onboarding when run directly (not from Rust TUI).
 */
async function runStandaloneFlow(options: OnboardingOptions): Promise<void> {
    const jsonMode = options.json === true;
    const globalPath = config.getGlobalPath();
    await ensureDirectory(globalPath);
    const existingConfig = await config.loadTenexConfig(globalPath);

    const totalSteps = 7;

    // Step 1: Identity
    if (!jsonMode) {
        display.step(1, totalSteps, "Identity");
        display.context("Your identity is how your agents know you, and how others can reach you.");
        display.blank();
    }

    let whitelistedPubkeys: string[];
    let generatedNsec: string | undefined;

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
            const privkey = signer.privateKey!;
            const user = await signer.user();
            const pubkey = user.pubkey;
            const npub = nip19.npubEncode(pubkey);
            const nsec = nip19.nsecEncode(Buffer.from(privkey, "hex"));

            whitelistedPubkeys = [pubkey];
            generatedNsec = nsec;

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

    let relays: string[];
    let installLocalRelay: number | undefined;

    const relayItems: RelayItem[] = [
        { type: "choice", name: "TENEX Community Relay", value: "wss://tenex.chat", description: "wss://tenex.chat" },
        { type: "input" },
    ];

    if (options.localRelayAvailable) {
        relayItems.push({
            type: "choice",
            name: "Install local relay",
            value: "__local__",
            description: "runs on localhost",
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

    if (relay === "__local__") {
        const port = 7000 + Math.floor(Math.random() * 2000);
        installLocalRelay = port;
        relays = [`ws://localhost:${port}`];
    } else {
        relays = [relay];
    }

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

    // Step 3: Providers
    display.step(3, totalSteps, "AI Providers");
    display.context("Connect the AI services your agents will use. You need at least one.");
    display.blank();

    const existingProviders = await config.loadTenexProviders(globalPath);
    const updatedProviders = await runProviderSetup(existingProviders);
    await config.saveGlobalProviders(updatedProviders);
    display.success("Provider credentials saved");

    // Step 4: Models
    if (Object.keys(updatedProviders.providers).length > 0) {
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
    } else {
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
        if (installLocalRelay) {
            output.installLocalRelay = installLocalRelay;
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
    .option("--local-relay-available", "Show option to install a local relay")
    .option("--json", "Output configuration as JSON")
    .option("--step-offset <n>", "Step number to start from (used when delegated from Rust TUI)")
    .option("--total-steps <n>", "Total steps in the parent flow (used when delegated from Rust TUI)")
    .action(async (options: OnboardingOptions) => {
        try {
            const isDelegated = options.stepOffset !== undefined && options.totalSteps !== undefined;

            if (isDelegated && options.pubkey) {
                await runDelegatedFlow(
                    options.pubkey,
                    parseInt(options.stepOffset!, 10),
                    parseInt(options.totalSteps!, 10),
                );
            } else {
                await runStandaloneFlow(options);
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                process.exit(0);
            }
            console.error(chalk.red(`Setup failed: ${error}`));
            process.exit(1);
        }
    });
