import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools";

interface CaptureOptions {
    relays: string[];
    outputPath: string;
    kinds: number[] | null;
    authors: string[] | null;
    durationSeconds: number;
    verify: boolean;
    progressIntervalSeconds: number;
}

interface CaptureStats {
    relayEventsSeen: Map<string, number>;
    uniqueEventIds: Set<string>;
    invalidSignatures: number;
    hashMismatches: number;
    skippedDuplicates: number;
}

interface CapturedRecord {
    capturedAt: number;
    relay: string;
    subscriptionId: string;
    event: NostrEvent;
    verified: boolean;
    hashMatchesId: boolean;
}

function parseArgs(argv: string[]): CaptureOptions {
    const args = new Map<string, string>();
    const relays: string[] = [];
    let index = 0;
    while (index < argv.length) {
        const flag = argv[index];
        if (flag === "--relay") {
            const value = argv[index + 1];
            if (typeof value !== "string") {
                throw new Error("--relay requires a value");
            }
            relays.push(value);
            index += 2;
            continue;
        }
        if (!flag.startsWith("--")) {
            throw new Error(`unexpected positional argument: ${flag}`);
        }
        const value = argv[index + 1];
        if (typeof value !== "string") {
            throw new Error(`${flag} requires a value`);
        }
        args.set(flag, value);
        index += 2;
    }

    const outputPath = args.get("--output");
    if (!outputPath) {
        throw new Error("--output <jsonl-path> is required");
    }

    const durationSeconds = args.has("--duration-seconds")
        ? Number(args.get("--duration-seconds"))
        : 60;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("--duration-seconds must be a positive number");
    }

    const kinds = args.has("--kinds") ? parseNumberList(args.get("--kinds")!) : null;
    const authors = args.has("--authors") ? parseStringList(args.get("--authors")!) : null;
    const verify = args.get("--verify") !== "false";
    const progressIntervalSeconds = args.has("--progress-interval-seconds")
        ? Number(args.get("--progress-interval-seconds"))
        : 10;

    return {
        relays,
        outputPath,
        kinds,
        authors,
        durationSeconds,
        verify,
        progressIntervalSeconds,
    };
}

function parseNumberList(value: string): number[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry, index) => {
            const parsed = Number(entry);
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
                throw new Error(`invalid number in list at index ${index}: ${entry}`);
            }
            return parsed;
        });
}

function parseStringList(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function buildReqMessage(
    subscriptionId: string,
    options: CaptureOptions,
): string {
    const filter: Record<string, unknown> = {};
    if (options.kinds) filter.kinds = options.kinds;
    if (options.authors) filter.authors = options.authors;
    return JSON.stringify(["REQ", subscriptionId, filter]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRelayMessage(raw: string): unknown[] | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isSignedNostrEvent(value: unknown): value is NostrEvent {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === "string" &&
        typeof value.pubkey === "string" &&
        typeof value.created_at === "number" &&
        typeof value.kind === "number" &&
        Array.isArray(value.tags) &&
        typeof value.content === "string" &&
        typeof value.sig === "string"
    );
}

function writeRecord(fd: number, record: CapturedRecord): void {
    writeSync(fd, `${JSON.stringify(record)}\n`);
}

function printProgress(stats: CaptureStats): void {
    const perRelay = Array.from(stats.relayEventsSeen.entries())
        .map(([relay, count]) => `${relay}=${count}`)
        .join(" ");
    process.stderr.write(
        `[capture-relay-events] unique=${stats.uniqueEventIds.size} ` +
            `invalidSig=${stats.invalidSignatures} hashMismatch=${stats.hashMismatches} ` +
            `dupSkipped=${stats.skippedDuplicates} relays=[${perRelay}]\n`,
    );
}

async function captureFromRelay(
    relayUrl: string,
    options: CaptureOptions,
    stats: CaptureStats,
    fd: number,
    abortSignal: AbortSignal,
): Promise<void> {
    const socket = new WebSocket(relayUrl);
    const subscriptionId = `cap-${Math.random().toString(36).slice(2, 10)}`;
    stats.relayEventsSeen.set(relayUrl, 0);

    await new Promise<void>((resolve) => {
        socket.addEventListener("open", () => {
            socket.send(buildReqMessage(subscriptionId, options));
            resolve();
        });
        socket.addEventListener("error", () => resolve());
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });

    if (abortSignal.aborted) {
        try {
            socket.close();
        } catch {
            /* socket may already be closed */
        }
        return;
    }

    await new Promise<void>((resolve) => {
        const cleanup = () => {
            try {
                socket.close();
            } catch {
                /* socket may already be closed */
            }
            resolve();
        };

        abortSignal.addEventListener("abort", cleanup, { once: true });
        socket.addEventListener("close", () => resolve());
        socket.addEventListener("error", () => resolve());

        socket.addEventListener("message", (event: MessageEvent) => {
            const raw = typeof event.data === "string" ? event.data : event.data.toString();
            const parsed = parseRelayMessage(raw);
            if (!parsed) return;
            const tag = parsed[0];
            if (tag !== "EVENT") return;
            if (parsed[1] !== subscriptionId) return;
            const signedEvent = parsed[2];
            if (!isSignedNostrEvent(signedEvent)) return;

            const currentCount = stats.relayEventsSeen.get(relayUrl) ?? 0;
            stats.relayEventsSeen.set(relayUrl, currentCount + 1);

            if (stats.uniqueEventIds.has(signedEvent.id)) {
                stats.skippedDuplicates += 1;
                return;
            }

            const hashMatchesId = verifyHashMatchesId(signedEvent);
            if (!hashMatchesId) {
                stats.hashMismatches += 1;
            }
            const verified = options.verify ? verifyEvent(signedEvent) : false;
            if (options.verify && !verified) {
                stats.invalidSignatures += 1;
            }

            stats.uniqueEventIds.add(signedEvent.id);
            writeRecord(fd, {
                capturedAt: Date.now() / 1000,
                relay: relayUrl,
                subscriptionId,
                event: signedEvent,
                verified,
                hashMatchesId,
            });
        });
    });
}

function verifyHashMatchesId(event: NostrEvent): boolean {
    const payload = JSON.stringify([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
    ]);
    const hash = createHash("sha256").update(payload).digest("hex");
    return hash === event.id;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.relays.length === 0) {
        throw new Error("--relay must be supplied at least once");
    }

    mkdirSync(dirname(options.outputPath), { recursive: true });
    const fd = openSync(options.outputPath, "w");

    const stats: CaptureStats = {
        relayEventsSeen: new Map(),
        uniqueEventIds: new Set(),
        invalidSignatures: 0,
        hashMismatches: 0,
        skippedDuplicates: 0,
    };

    const abortController = new AbortController();
    const shutdown = () => abortController.abort();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    const deadline = setTimeout(() => abortController.abort(), options.durationSeconds * 1000);
    const progressTimer = setInterval(
        () => printProgress(stats),
        options.progressIntervalSeconds * 1000,
    );

    try {
        await Promise.all(
            options.relays.map((relay) =>
                captureFromRelay(relay, options, stats, fd, abortController.signal),
            ),
        );
    } finally {
        clearTimeout(deadline);
        clearInterval(progressTimer);
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
        closeSync(fd);
        printProgress(stats);
        appendFileSync(
            `${options.outputPath}.summary.json`,
            `${JSON.stringify({
                outputPath: options.outputPath,
                durationSeconds: options.durationSeconds,
                relays: options.relays,
                uniqueEventsCaptured: stats.uniqueEventIds.size,
                invalidSignatures: stats.invalidSignatures,
                hashMismatches: stats.hashMismatches,
                skippedDuplicates: stats.skippedDuplicates,
                perRelay: Array.from(stats.relayEventsSeen.entries()).map(([relay, count]) => ({
                    relay,
                    count,
                })),
            })}\n`,
        );
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`capture-relay-events failed: ${message}\n`);
    process.exit(1);
});
