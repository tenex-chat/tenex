// Shared helpers for AI SDK lifecycle probes.
// Routes through OpenRouter -> Anthropic Haiku for speed/cost. The lifecycle
// behavior of streamText is provider-agnostic; the choice of provider here
// only affects which API receives the request.

import { createOpenAI } from "@ai-sdk/openai";
import fs from "node:fs";

const providers = JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.tenex/providers.json`, "utf8"),
);
const openrouterKey: string =
    providers.providers?.openrouter?.apiKey ??
    providers.openrouter?.apiKey;
if (!openrouterKey) throw new Error("openrouter apiKey not found in providers.json");

const openrouter = createOpenAI({
    apiKey: openrouterKey,
    baseURL: "https://openrouter.ai/api/v1",
});

// Haiku via OpenRouter. Tool-calling capable and cheap.
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
