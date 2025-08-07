import chalk from "chalk";

/**
 * TENEX Logging System
 *
 * Environment Variables:
 * - LOG_LEVEL: Sets default verbosity (silent|normal|verbose|debug)
 * - TENEX_LOG: Enable specific modules with optional verbosity
 *   Format: module1:level,module2:level
 *   Example: TENEX_LOG=agent:debug,llm:verbose,tools
 *   If no level specified, defaults to debug
 *
 * Available modules:
 * - agent: Agent execution and behavior
 * - conversation: Conversation management
 * - llm: LLM interactions
 * - nostr: Nostr protocol operations
 * - tools: Tool execution
 * - general: General/miscellaneous logging
 *
 * Tracing (execution flow debugging) is only enabled for modules
 * with verbose or debug verbosity levels.
 */

export type VerbosityLevel = "silent" | "normal" | "verbose" | "debug";

export type LogModule = "agent" | "conversation" | "llm" | "nostr" | "tools" | "general";

export interface ModuleVerbosityConfig {
    default: VerbosityLevel;
    modules?: {
        [moduleName: string]: VerbosityLevel;
    };
}

export interface LoggerConfig {
    useEmoji?: boolean;
    useLabels?: boolean;
    debugEnabled?: boolean;
    moduleVerbosity?: ModuleVerbosityConfig;
}

const verbosityLevels: Record<VerbosityLevel, number> = {
    silent: 0,
    normal: 1,
    verbose: 2,
    debug: 3,
};

let globalConfig: LoggerConfig = {
    useEmoji: true,
    useLabels: false,
    debugEnabled: typeof process !== "undefined" && process.env?.DEBUG === "true",
    moduleVerbosity: parseModuleVerbosity(),
};

export function parseModuleVerbosity(): ModuleVerbosityConfig {
    const config: ModuleVerbosityConfig = {
        default: "normal" as VerbosityLevel,
        modules: {},
    };

    // Only try to parse environment variables in Node.js environment
    if (typeof process !== "undefined" && process.env) {
        // Set default level from environment
        const logLevel = process.env.LOG_LEVEL as VerbosityLevel;
        if (logLevel && verbosityLevels[logLevel] !== undefined) {
            config.default = logLevel;
        }

        // Parse TENEX_LOG environment variable
        // Format: TENEX_LOG=module1:level,module2:level
        // Example: TENEX_LOG=agent:debug,llm:verbose,tools:debug
        // If no level specified, defaults to debug
        // Example: TENEX_LOG=agent,llm,tools (all set to debug)
        const tenexLog = process.env.TENEX_LOG;
        if (tenexLog) {
            const modules = tenexLog.split(",").map((s) => s.trim());
            for (const moduleSpec of modules) {
                if (moduleSpec) {
                    const [moduleName, level] = moduleSpec.split(":");
                    if (moduleName) {
                        const moduleKey = moduleName.toLowerCase();
                        const verbosityLevel = (level as VerbosityLevel) || "debug";

                        if (verbosityLevels[verbosityLevel] !== undefined) {
                            if (!config.modules) {
                                config.modules = {};
                            }
                            config.modules[moduleKey] = verbosityLevel;
                        }
                    }
                }
            }
        }
    }

    return config;
}

export function configureLogger(config: Partial<LoggerConfig>): void {
    globalConfig = { ...globalConfig, ...config };
    if (!globalConfig.moduleVerbosity) {
        globalConfig.moduleVerbosity = parseModuleVerbosity();
    }
}

// Agent color assignment for consistent coloring
const agentColors = [
    chalk.red,
    chalk.green,
    chalk.yellow,
    chalk.blue,
    chalk.magenta,
    chalk.cyan,
    chalk.white,
    chalk.gray,
    chalk.redBright,
    chalk.greenBright,
    chalk.yellowBright,
    chalk.blueBright,
    chalk.magentaBright,
    chalk.cyanBright,
];

const agentColorMap = new Map<string, typeof chalk.red>();

function getAgentColor(agentName: string): typeof chalk.red {
    if (!agentColorMap.has(agentName)) {
        const index = agentColorMap.size % agentColors.length;
        const color = agentColors[index] || chalk.white;
        agentColorMap.set(agentName, color);
    }
    return agentColorMap.get(agentName) || chalk.white;
}

function shouldLog(
    level: string,
    module?: LogModule,
    verbosityRequired: VerbosityLevel = "normal"
): boolean {
    // Always show errors and warnings
    if (level === "error" || level === "warning") return true;

    // Debug logs respect the debug flag
    if (level === "debug" && !globalConfig.debugEnabled) return false;

    // Get module-specific verbosity
    const moduleConfig = globalConfig.moduleVerbosity;
    const moduleVerbosity =
        module && moduleConfig?.modules?.[module]
            ? moduleConfig.modules[module]
            : moduleConfig?.default || "normal";

    const currentLevel = verbosityLevels[moduleVerbosity];
    const requiredLevel = verbosityLevels[verbosityRequired];

    return currentLevel >= requiredLevel;
}

function formatModulePrefix(module?: LogModule): string {
    if (!module || !globalConfig.moduleVerbosity?.modules?.[module]) return "";
    return chalk.dim(`[${module.toUpperCase()}] `);
}

type LogLevel = "error" | "info" | "success" | "warning" | "debug";

interface LogConfig {
    emoji: string;
    label: string;
    color: typeof chalk.red;
    consoleFn: typeof console.log;
}

const logConfigs: Record<LogLevel, LogConfig> = {
    error: { emoji: "❌", label: "[ERROR]", color: chalk.redBright, consoleFn: console.error },
    info: { emoji: "ℹ️", label: "[INFO]", color: chalk.blueBright, consoleFn: console.log },
    success: { emoji: "✅", label: "[SUCCESS]", color: chalk.greenBright, consoleFn: console.log },
    warning: { emoji: "⚠️", label: "[WARNING]", color: chalk.yellowBright, consoleFn: console.warn },
    debug: { emoji: "🔍", label: "[DEBUG]", color: chalk.magentaBright, consoleFn: console.log },
};

function formatLogMessage(
    level: LogLevel,
    message: string,
    module?: LogModule
): string {
    const config = logConfigs[level];
    const prefix = globalConfig.useEmoji ? config.emoji : globalConfig.useLabels ? config.label : "";
    const modulePrefix = formatModulePrefix(module);
    const fullMessage = prefix
        ? `${prefix} ${modulePrefix}${message}`
        : `${modulePrefix}${message}`;
    return config.color(fullMessage);
}

export function logError(message: string, error?: unknown, module?: LogModule): void {
    if (!shouldLog("error", module)) return;
    const formatted = formatLogMessage("error", message, module);
    console.error(formatted, error || "");
}

export function logInfo(
    message: string,
    module?: LogModule,
    verbosity: VerbosityLevel = "normal",
    ...args: unknown[]
): void {
    if (!shouldLog("info", module, verbosity)) return;
    const formatted = formatLogMessage("info", message, module);
    console.log(formatted, ...args);
}

export function logSuccess(
    message: string,
    module?: LogModule,
    verbosity: VerbosityLevel = "normal"
): void {
    if (!shouldLog("success", module, verbosity)) return;
    const formatted = formatLogMessage("success", message, module);
    console.log(formatted);
}

export function logWarning(
    message: string,
    module?: LogModule,
    verbosity: VerbosityLevel = "normal",
    ...args: unknown[]
): void {
    if (!shouldLog("warning", module, verbosity)) return;
    const formatted = formatLogMessage("warning", message, module);
    console.warn(formatted, ...args);
}

export function logDebug(
    message: string,
    module?: LogModule,
    verbosity: VerbosityLevel = "debug",
    ...args: unknown[]
): void {
    if (!shouldLog("debug", module, verbosity)) return;
    const formatted = formatLogMessage("debug", message, module);
    console.log(formatted, ...args);
}

// Agent Logger class for contextual logging
export class AgentLogger {
    private projectName?: string;
    private agentName: string;
    private color: typeof chalk.red;
    private module: LogModule = "agent";

    constructor(agentName: string, projectName?: string) {
        this.agentName = agentName;
        this.projectName = projectName;
        this.color = getAgentColor(agentName);
    }

    setModule(module: LogModule): void {
        this.module = module;
    }

    private formatMessage(
        emoji: string,
        message: string,
        colorFn: typeof chalk.red,
        verbosity: VerbosityLevel
    ): string {
        if (!shouldLog("info", this.module, verbosity)) return "";
        const projectPrefix = this.projectName ? `${chalk.gray(`[${this.projectName}]`)} ` : "";
        const agentPrefix = `${this.color(`[${this.agentName}]`)} `;
        const emojiPrefix = globalConfig.useEmoji ? `${emoji} ` : "";
        const modulePrefix = formatModulePrefix(this.module);
        const coloredMessage = colorFn(message);
        return `${projectPrefix}${agentPrefix}${modulePrefix}${emojiPrefix}${coloredMessage}`;
    }

    info(message: string, verbosity: VerbosityLevel = "normal", ...args: unknown[]): void {
        if (!shouldLog("info", this.module, verbosity)) return;
        const formatted = this.formatMessage("ℹ️", message, chalk.blueBright, verbosity);
        if (formatted) console.log(formatted, ...args);
    }

    success(message: string, verbosity: VerbosityLevel = "normal", ...args: unknown[]): void {
        if (!shouldLog("success", this.module, verbosity)) return;
        const formatted = this.formatMessage("✅", message, chalk.greenBright, verbosity);
        if (formatted) console.log(formatted, ...args);
    }

    warning(message: string, verbosity: VerbosityLevel = "normal", ...args: unknown[]): void {
        if (!shouldLog("warning", this.module, verbosity)) return;
        const formatted = this.formatMessage("⚠️", message, chalk.yellowBright, verbosity);
        if (formatted) console.warn(formatted, ...args);
    }

    error(message: string, error?: unknown): void {
        // Errors always show
        const formatted = this.formatMessage("❌", message, chalk.redBright, "normal");
        console.error(formatted, error || "");
    }

    debug(message: string, verbosity: VerbosityLevel = "debug", ...args: unknown[]): void {
        if (!shouldLog("debug", this.module, verbosity)) return;
        const formatted = this.formatMessage("🔍", message, chalk.magentaBright, verbosity);
        if (formatted) console.log(formatted, ...args);
    }
}

// Factory function for creating agent loggers
export function createAgentLogger(agentName: string, projectName?: string): AgentLogger {
    return new AgentLogger(agentName, projectName);
}

// Scoped logger for easier module-specific logging
export class ScopedLogger {
    constructor(private module: LogModule) {}

    info(message: string, verbosity: VerbosityLevel = "normal", ...args: unknown[]): void {
        logInfo(message, this.module, verbosity, ...args);
    }

    success(message: string, verbosity: VerbosityLevel = "normal"): void {
        logSuccess(message, this.module, verbosity);
    }

    warning(message: string, verbosity: VerbosityLevel = "normal", ...args: unknown[]): void {
        logWarning(message, this.module, verbosity, ...args);
    }

    error(message: string, error?: unknown): void {
        logError(message, error, this.module);
    }

    debug(message: string, verbosity: VerbosityLevel = "debug", ...args: unknown[]): void {
        logDebug(message, this.module, verbosity, ...args);
    }
}

// Conversation flow logging functions
function truncateText(text: string, maxLength = 100): string {
    if (text.length <= maxLength) return text;
    return `${text.substring(0, maxLength)}...`;
}

function formatConversationHeader(conversationId?: string, title?: string): string {
    if (!conversationId) return "";
    const shortId = conversationId.substring(0, 8);
    const formattedTitle = title ? ` "${title}"` : "";
    return chalk.gray(`[${shortId}${formattedTitle}]`);
}

// Human-readable conversation flow logging
export function logConversationStart(
    userMessage: string,
    conversationId?: string,
    title?: string,
    eventId?: string
): void {
    if (!shouldLog("info", "conversation", "normal")) return;

    const header = formatConversationHeader(conversationId, title);

    console.log();
    console.log(chalk.bold.cyan(`🗣️  NEW CONVERSATION ${header}`));
    console.log(chalk.white(`   User: ${chalk.italic(truncateText(userMessage, 80))}`));
    if (eventId) {
        console.log(chalk.dim(`   Event: ${eventId.substring(0, 12)}...`));
    }
    console.log();
}

export function logLLMInteraction(
    type: string,
    config: {
        model?: string;
        systemPrompt?: string;
        userPrompt?: string;
        response?: string;
        reasoning?: string;
    },
    conversationId?: string,
    title?: string
): void {
    if (!shouldLog("info", "llm", "verbose")) return;

    const header = formatConversationHeader(conversationId, title);
    const maxLength = 500; // Configurable via env var in future

    console.log(chalk.magenta(`🤖 LLM ${type.toUpperCase()} ${header}`));
    if (config.model) {
        console.log(chalk.white(`   Model: ${chalk.bold(config.model)}`));
    }

    if (config.systemPrompt) {
        console.log(
            chalk.white(`   System: ${chalk.dim(truncateText(config.systemPrompt, maxLength))}`)
        );
    }

    if (config.userPrompt) {
        console.log(
            chalk.white(`   Prompt: ${chalk.dim(truncateText(config.userPrompt, maxLength))}`)
        );
    }

    if (config.response) {
        console.log(chalk.white(`   Response: ${truncateText(config.response, maxLength)}`));
    }

    if (config.reasoning) {
        console.log(chalk.white(`   Reasoning: ${config.reasoning}`));
    }
    console.log();
}

export function logPhaseTransition(
    from: string,
    to: string,
    reason?: string,
    conversationId?: string,
    title?: string
): void {
    if (!shouldLog("info", "conversation", "normal")) return;

    const header = formatConversationHeader(conversationId, title);

    console.log(chalk.blue(`🔄 PHASE TRANSITION ${header}`));
    console.log(
        chalk.white(
            `   ${chalk.bold.red(from.toUpperCase())} → ${chalk.bold.green(to.toUpperCase())}`
        )
    );
    if (reason) {
        console.log(chalk.white(`   Reason: ${reason}`));
    }
    console.log();
}

export function logUserMessage(
    message: string,
    conversationId?: string,
    title?: string,
    eventId?: string
): void {
    if (!shouldLog("info", "conversation", "normal")) return;

    const header = formatConversationHeader(conversationId, title);

    console.log(chalk.cyan(`👤 USER MESSAGE ${header}`));
    console.log(chalk.white(`   "${message}"`));
    if (eventId) {
        console.log(chalk.dim(`   Event: ${eventId.substring(0, 12)}...`));
    }
    console.log();
}

export function logAgentResponse(
    agentName: string,
    message: string,
    conversationId?: string,
    title?: string,
    eventId?: string
): void {
    if (!shouldLog("info", "conversation", "normal")) return;

    const header = formatConversationHeader(conversationId, title);

    console.log(chalk.green(`🤖 ${agentName.toUpperCase()} RESPONSE ${header}`));
    console.log(chalk.white(`   "${truncateText(message, 200)}"`));
    if (eventId) {
        console.log(chalk.dim(`   Event: ${eventId.substring(0, 12)}...`));
    }
    console.log();
}

export function logConversationError(
    error: string,
    context?: Record<string, unknown>,
    conversationId?: string,
    title?: string
): void {
    const header = formatConversationHeader(conversationId, title);

    console.log(chalk.red(`❌ CONVERSATION ERROR ${header}`));
    console.log(chalk.white(`   ${error}`));
    if (context) {
        for (const [key, value] of Object.entries(context)) {
            console.log(chalk.dim(`   ${key}: ${value}`));
        }
    }
    console.log();
}

// Export a logger object for compatibility
export const logger = {
    info: (message: string, ...args: unknown[]) => logInfo(message, undefined, "normal", ...args),
    error: (message: string, error?: unknown) => logError(message, error),
    success: (message: string) => logSuccess(message),
    warn: (message: string, ...args: unknown[]) =>
        logWarning(message, undefined, "normal", ...args),
    warning: (message: string, ...args: unknown[]) =>
        logWarning(message, undefined, "normal", ...args),
    debug: (message: string, ...args: unknown[]) => logDebug(message, undefined, "debug", ...args),
    createAgent: createAgentLogger,
    forModule: (module: LogModule) => new ScopedLogger(module),

    // Conversation flow logging
    conversationStart: logConversationStart,
    llmInteraction: logLLMInteraction,
    phaseTransition: logPhaseTransition,
    userMessage: logUserMessage,
    agentResponse: logAgentResponse,
    conversationError: logConversationError,
};
