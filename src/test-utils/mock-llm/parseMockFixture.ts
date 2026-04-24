import type {
    MockLLMConfig,
    MockLLMResponse,
    MockToolCall,
} from "./types";

/**
 * Fixture JSON shape accepted by {@link parseMockFixture}.
 *
 * The fixture is validated strictly: every scripted tool call must declare a
 * name, every trigger field must be a string or `null`/absent (regex is
 * expressed via the `/pattern/flags` convention so the fixture stays plain
 * JSON), and `responses` must be non-empty.
 */
export interface MockFixtureJson {
    expectedModelId: string;
    label?: string;
    responses: MockFixtureResponseJson[];
}

export interface MockFixtureResponseJson {
    priority?: number;
    trigger: MockFixtureTriggerJson;
    response: MockFixtureResponsePayloadJson;
}

export interface MockFixtureTriggerJson {
    systemPrompt?: string;
    userMessage?: string;
    agentName?: string;
    phase?: string;
    messageContains?: string;
    previousToolCalls?: string[];
    iterationCount?: number;
    previousAgent?: string;
    afterAgent?: string;
    continueToPhase?: string;
}

export interface MockFixtureResponsePayloadJson {
    content?: string;
    toolCalls?: MockToolCall[];
    streamDelay?: number;
}

const REGEX_SYNTAX = /^\/(.*)\/([a-z]*)$/;

/**
 * Convert a fixture string that may be either a literal or a `/pattern/flags`
 * expression into the value consumed by {@link MockLLMService}.
 */
function parsePatternField(
    raw: unknown,
    path: string,
    label: string
): string | RegExp | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }

    if (typeof raw !== "string") {
        throw new Error(
            `[parseMockFixture:${label}] ${path} must be a string (literal or /pattern/flags), got ${typeof raw}`
        );
    }

    const match = REGEX_SYNTAX.exec(raw);
    if (!match) {
        return raw;
    }

    const [, pattern, flags] = match;
    if (pattern === undefined) {
        throw new Error(
            `[parseMockFixture:${label}] ${path} looks like /pattern/flags but is missing a pattern body: ${raw}`
        );
    }
    try {
        return new RegExp(pattern, flags ?? "");
    } catch (error) {
        throw new Error(
            `[parseMockFixture:${label}] ${path} has an invalid regular expression: ${raw}`,
            { cause: error }
        );
    }
}

function parseToolCalls(
    raw: MockToolCall[] | undefined,
    path: string,
    label: string
): MockToolCall[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        throw new Error(`[parseMockFixture:${label}] ${path} must be an array`);
    }
    raw.forEach((call, index) => {
        const name = call.name ?? call.function;
        if (!name || typeof name !== "string") {
            throw new Error(
                `[parseMockFixture:${label}] ${path}[${index}] must declare 'name' (or legacy 'function') as a string`
            );
        }
    });
    return raw;
}

/**
 * Parse a mock fixture JSON payload into a {@link MockLLMConfig} ready to be
 * handed to {@link createMockProvider}. Throws on any structural problem;
 * callers should surface the error, not suppress it.
 */
export function parseMockFixture(input: unknown): MockLLMConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("[parseMockFixture] fixture must be a JSON object");
    }

    const raw = input as Partial<MockFixtureJson>;
    const label =
        typeof raw.label === "string" && raw.label.length > 0
            ? raw.label
            : "anonymous-fixture";

    if (typeof raw.expectedModelId !== "string" || raw.expectedModelId.length === 0) {
        throw new Error(
            `[parseMockFixture:${label}] fixture is missing required 'expectedModelId'`
        );
    }

    if (!Array.isArray(raw.responses) || raw.responses.length === 0) {
        throw new Error(
            `[parseMockFixture:${label}] fixture must declare a non-empty 'responses' array`
        );
    }

    const responses: MockLLMResponse[] = raw.responses.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(
                `[parseMockFixture:${label}] responses[${index}] must be an object`
            );
        }
        if (!entry.trigger || typeof entry.trigger !== "object") {
            throw new Error(
                `[parseMockFixture:${label}] responses[${index}].trigger must be an object`
            );
        }
        if (!entry.response || typeof entry.response !== "object") {
            throw new Error(
                `[parseMockFixture:${label}] responses[${index}].response must be an object`
            );
        }

        const triggerIn = entry.trigger;
        const trigger: MockLLMResponse["trigger"] = {};

        const systemPrompt = parsePatternField(
            triggerIn.systemPrompt,
            `responses[${index}].trigger.systemPrompt`,
            label
        );
        if (systemPrompt !== undefined) trigger.systemPrompt = systemPrompt;

        const userMessage = parsePatternField(
            triggerIn.userMessage,
            `responses[${index}].trigger.userMessage`,
            label
        );
        if (userMessage !== undefined) trigger.userMessage = userMessage;

        const agentName = parsePatternField(
            triggerIn.agentName,
            `responses[${index}].trigger.agentName`,
            label
        );
        if (agentName !== undefined) trigger.agentName = agentName;

        const messageContains = parsePatternField(
            triggerIn.messageContains,
            `responses[${index}].trigger.messageContains`,
            label
        );
        if (messageContains !== undefined) trigger.messageContains = messageContains;

        if (triggerIn.phase !== undefined) {
            if (typeof triggerIn.phase !== "string") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.phase must be a string`
                );
            }
            trigger.phase = triggerIn.phase;
        }

        if (triggerIn.previousToolCalls !== undefined) {
            if (
                !Array.isArray(triggerIn.previousToolCalls) ||
                triggerIn.previousToolCalls.some((v) => typeof v !== "string")
            ) {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.previousToolCalls must be a string[]`
                );
            }
            trigger.previousToolCalls = triggerIn.previousToolCalls;
        }

        if (triggerIn.iterationCount !== undefined) {
            if (typeof triggerIn.iterationCount !== "number") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.iterationCount must be a number`
                );
            }
            trigger.iterationCount = triggerIn.iterationCount;
        }

        if (triggerIn.previousAgent !== undefined) {
            if (typeof triggerIn.previousAgent !== "string") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.previousAgent must be a string`
                );
            }
            trigger.previousAgent = triggerIn.previousAgent;
        }

        if (triggerIn.afterAgent !== undefined) {
            if (typeof triggerIn.afterAgent !== "string") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.afterAgent must be a string`
                );
            }
            trigger.afterAgent = triggerIn.afterAgent;
        }

        if (triggerIn.continueToPhase !== undefined) {
            if (typeof triggerIn.continueToPhase !== "string") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].trigger.continueToPhase must be a string`
                );
            }
            trigger.continueToPhase = triggerIn.continueToPhase;
        }

        const responseIn = entry.response;
        const response: MockLLMResponse["response"] = {};
        if (responseIn.content !== undefined) {
            if (typeof responseIn.content !== "string") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].response.content must be a string`
                );
            }
            response.content = responseIn.content;
        }
        const toolCalls = parseToolCalls(
            responseIn.toolCalls,
            `responses[${index}].response.toolCalls`,
            label
        );
        if (toolCalls !== undefined) {
            response.toolCalls = toolCalls;
        }
        if (responseIn.streamDelay !== undefined) {
            if (typeof responseIn.streamDelay !== "number") {
                throw new Error(
                    `[parseMockFixture:${label}] responses[${index}].response.streamDelay must be a number`
                );
            }
            response.streamDelay = responseIn.streamDelay;
        }

        if (response.content === undefined && !response.toolCalls?.length) {
            throw new Error(
                `[parseMockFixture:${label}] responses[${index}].response must declare at least 'content' or 'toolCalls'`
            );
        }

        const priority = entry.priority;
        if (priority !== undefined && typeof priority !== "number") {
            throw new Error(
                `[parseMockFixture:${label}] responses[${index}].priority must be a number`
            );
        }

        return { trigger, response, ...(priority !== undefined ? { priority } : {}) };
    });

    return {
        strict: true,
        fixtureLabel: label,
        expectedModelId: raw.expectedModelId,
        responses,
    };
}
