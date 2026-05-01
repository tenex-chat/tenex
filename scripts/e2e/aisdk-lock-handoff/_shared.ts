// Model + logging helpers for the lock-handoff prototype. Routes through
// OpenRouter -> Anthropic Haiku. Lifecycle behavior of streamText is
// provider-agnostic; provider choice only affects which API receives requests.

import { createOpenAI } from "@ai-sdk/openai";
import fs from "node:fs";

const providersJsonPath = `${process.env.HOME}/.tenex/providers.json`;
const providers = JSON.parse(fs.readFileSync(providersJsonPath, "utf8"));
const openrouterKey: string =
    providers.providers?.openrouter?.apiKey ?? providers.openrouter?.apiKey;
if (!openrouterKey) {
    throw new Error(`openrouter apiKey not found in ${providersJsonPath}`);
}

const openrouter = createOpenAI({
    apiKey: openrouterKey,
    baseURL: "https://openrouter.ai/api/v1",
});

export const MODEL = openrouter.chat("anthropic/claude-haiku-4.5");

let t0 = 0;
export function startClock(): void {
    t0 = Date.now();
}
export function ts(): string {
    const ms = Date.now() - t0;
    return `+${ms.toString().padStart(5, " ")}ms`;
}
export function log(tag: string, ...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.log(`[${ts()}] ${tag}`, ...args);
}
export function summarize(value: unknown, max = 160): string {
    try {
        const s = typeof value === "string" ? value : JSON.stringify(value);
        if (!s) return String(s);
        return s.length > max ? `${s.slice(0, max)}…(len=${s.length})` : s;
    } catch {
        return String(value);
    }
}

let ralCounter = 0;
export function nextRalId(): string {
    return `RAL#${++ralCounter}`;
}
export function resetRalCounter(): void {
    ralCounter = 0;
}
