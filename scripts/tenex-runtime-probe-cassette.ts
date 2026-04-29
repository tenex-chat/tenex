import { existsSync, readFileSync } from "node:fs";

export type ProbeLlmMode = "mock" | "ollama" | "cassette";

export type ProbeLlmOptions = {
    mode: ProbeLlmMode;
    cassettePath?: string;
    recordCassettePath?: string;
    generationTimeFactor: number;
    ollamaModel: string;
    ollamaBaseUrl?: string;
};

type CassetteToolCall = {
    name: string;
    args?: unknown;
};

type CassetteRecord = {
    agent?: string;
    model?: string;
    turn?: number;
    durationMs?: number;
    delayMs?: number;
    requestDebug?: string;
    content?: string | null;
    toolCalls?: Array<CassetteToolCall | string>;
};

export function parseProbeLlmOptions(args: string[]): ProbeLlmOptions {
    const explicitMode = flagValue(args, "llm") ?? process.env.TENEX_PROBE_LLM;
    const cassettePath =
        flagValue(args, "cassette") ??
        process.env.TENEX_PROBE_CASSETTE ??
        process.env.TENEX_PROBE_REPLAY_CASSETTE;
    const recordCassettePath =
        flagValue(args, "record-cassette") ?? process.env.TENEX_PROBE_RECORD_CASSETTE;
    const mode = normalizeMode(explicitMode, cassettePath);
    const generationTimeFactor = normalizeFactor(
        flagValue(args, "llm-generation-time-factor") ??
            process.env.TENEX_PROBE_LLM_GENERATION_TIME_FACTOR ??
            process.env.llm_generation_time_factor
    );

    return {
        mode,
        cassettePath,
        recordCassettePath,
        generationTimeFactor,
        ollamaModel:
            flagValue(args, "ollama-model") ??
            process.env.TENEX_PROBE_OLLAMA_MODEL ??
            "llama3.1",
        ollamaBaseUrl:
            flagValue(args, "ollama-base-url") ??
            process.env.TENEX_PROBE_OLLAMA_BASE_URL ??
            process.env.OLLAMA_API_BASE_URL,
    };
}

export function cassetteToMockScenario(
    cassettePath: string,
    generationTimeFactor: number
): unknown {
    const records = readCassette(cassettePath);
    if (records.length === 0) {
        throw new Error(`Cassette has no LLM records: ${cassettePath}`);
    }

    return {
        responses: records.map((record) => {
            const durationMs = record.durationMs ?? record.delayMs ?? 0;
            return {
                agent: requiredString(record.agent, "agent", cassettePath),
                turn: requiredNumber(record.turn, "turn", cassettePath),
                contains: stableNeedle(record.requestDebug),
                content: record.content ?? undefined,
                toolCalls: normalizeToolCalls(record.toolCalls),
                delayMs: Math.max(0, Math.round(durationMs * generationTimeFactor)),
            };
        }),
        defaultContent: "Cassette replay did not find a matching LLM record.",
    };
}

function readCassette(file: string): CassetteRecord[] {
    if (!existsSync(file)) {
        throw new Error(`Cassette does not exist: ${file}`);
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line) as CassetteRecord;
            } catch (error) {
                throw new Error(
                    `Invalid cassette JSON on line ${index + 1} of ${file}: ${error}`
                );
            }
        });
}

function normalizeMode(raw: string | undefined, cassettePath: string | undefined): ProbeLlmMode {
    const mode = raw?.trim().toLowerCase();
    if (!mode && cassettePath) {
        return "cassette";
    }
    if (!mode || mode === "mock") {
        return "mock";
    }
    if (mode === "ollama" || mode === "real") {
        return "ollama";
    }
    if (mode === "cassette" || mode === "replay") {
        return "cassette";
    }
    throw new Error(`Unsupported probe LLM mode: ${raw}`);
}

function normalizeFactor(raw: string | undefined): number {
    if (!raw) {
        return 1;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid llm generation time factor: ${raw}`);
    }
    return value;
}

function normalizeToolCalls(toolCalls: CassetteRecord["toolCalls"]): CassetteToolCall[] {
    if (!toolCalls) {
        return [];
    }
    return toolCalls.map((toolCall) => {
        if (typeof toolCall === "string") {
            return { name: toolCall, args: {} };
        }
        return {
            name: toolCall.name,
            args: parseArgs(toolCall.args),
        };
    });
}

function parseArgs(args: unknown): unknown {
    if (typeof args !== "string") {
        return args ?? {};
    }
    try {
        return JSON.parse(args);
    } catch {
        return args;
    }
}

function stableNeedle(requestDebug: string | undefined): string | undefined {
    const line = requestDebug
        ?.split(/\r?\n/)
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    if (!line) {
        return undefined;
    }
    return line.length > 240 ? line.slice(0, 240) : line;
}

function requiredString(value: string | undefined, field: string, file: string): string {
    if (!value) {
        throw new Error(`Cassette record in ${file} is missing ${field}`);
    }
    return value;
}

function requiredNumber(value: number | undefined, field: string, file: string): number {
    if (!Number.isFinite(value)) {
        throw new Error(`Cassette record in ${file} is missing ${field}`);
    }
    return value as number;
}

function flagValue(args: string[], name: string): string | undefined {
    const equalsPrefix = `--${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) {
        return inline.slice(equalsPrefix.length);
    }
    const index = args.indexOf(`--${name}`);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
        return args[index + 1];
    }
    return undefined;
}
