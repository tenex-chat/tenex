import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    type Event,
    type EventTemplate,
} from "nostr-tools";
import type { MockRequestRecord } from "./tenex-runtime-probe-scenarios";

export type OutputProc = {
    label: string;
    output: string;
};

export function keypair(): { secret: Uint8Array; pubkey: string } {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
}

export function sign(template: EventTemplate, secret: Uint8Array): Event {
    return finalizeEvent(template, secret);
}

export function mergeEvents(...groups: Event[][]): Event[] {
    const byId = new Map<string, Event>();
    for (const group of groups) {
        for (const event of group) {
            byId.set(event.id, event);
        }
    }
    return Array.from(byId.values()).sort((a, b) => a.created_at - b.created_at);
}

export function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readRequestRecords(file: string): MockRequestRecord[] {
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
            try {
                const record = JSON.parse(line) as MockRequestRecord & {
                    toolCalls?: Array<string | { name: string }>;
                };
                if (Array.isArray(record.toolCalls)) {
                    record.toolCalls = record.toolCalls.map((toolCall) =>
                        typeof toolCall === "string" ? toolCall : toolCall.name
                    );
                }
                return [record as MockRequestRecord];
            } catch {
                return [];
            }
        });
}

export function readJsonLines(file: string): Array<Record<string, unknown>> {
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
            try {
                const parsed = JSON.parse(line) as unknown;
                return parsed && typeof parsed === "object"
                    ? [parsed as Record<string, unknown>]
                    : [];
            } catch {
                return [];
            }
        });
}

export function now(): number {
    return Math.floor(Date.now() / 1000);
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (typeof address === "object" && address?.port) {
                const port = address.port;
                server.close(() => resolve(port));
            } else {
                reject(new Error("failed to allocate port"));
            }
        });
        server.on("error", reject);
    });
}

export async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // keep polling
        }
        await delay(100);
    }
    throw new Error(`relay did not become healthy: ${url}`);
}

export async function waitForOutput(
    proc: OutputProc,
    needle: string,
    timeoutMs: number
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (proc.output.includes(needle)) {
            return;
        }
        await delay(100);
    }
    throw new Error(`${proc.label} did not print '${needle}' within ${timeoutMs}ms`);
}

export async function waitForObservedEvent(
    events: Event[],
    predicate: (event: Event) => boolean,
    timeoutMs: number,
    label: string
): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) {
            return event;
        }
        await delay(100);
    }
    throw new Error(`did not observe ${label} within ${timeoutMs}ms`);
}

export async function waitForRequestRecord(
    file: string,
    predicate: (records: MockRequestRecord[]) => boolean,
    timeoutMs: number,
    label: string
): Promise<MockRequestRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const records = readRequestRecords(file);
        if (predicate(records)) {
            return records;
        }
        await delay(50);
    }
    throw new Error(`did not observe ${label} within ${timeoutMs}ms`);
}
