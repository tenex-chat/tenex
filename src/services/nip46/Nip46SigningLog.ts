import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "@/services/ConfigService";

/**
 * Operations logged by the NIP-46 signing system.
 */
export type Nip46LogOperation =
    | "signer_connect"
    | "sign_request"
    | "sign_success"
    | "sign_timeout"
    | "sign_rejected"
    | "sign_error"
    | "event_published";

/**
 * A single log entry for NIP-46 signing activity.
 */
export interface Nip46LogEntry {
    ts: string;
    op: Nip46LogOperation;
    requestId?: string;
    ownerPubkey?: string;       // First 12 chars
    eventKind?: number;
    agentAction?: string;
    agentPubkey?: string;       // First 12 chars
    pTagCount?: number;
    signerType?: "nip46";
    durationMs?: number;
    error?: string;
    eventId?: string;
    trigger?: string;           // What triggered this signing request
    eventTags?: string[][];     // Full tags array of the event being signed
    eventContent?: string;      // Content field of the event being signed
}

/**
 * Dedicated JSONL log writer for NIP-46 signing operations.
 * Writes to ~/.tenex/daemon/nip46-signing.log, independent from daemon.log.
 */
export class Nip46SigningLog {
    private static instance: Nip46SigningLog | null = null;
    private logPath: string;

    private constructor() {
        const daemonDir = config.getConfigPath("daemon");
        fs.mkdirSync(daemonDir, { recursive: true });
        this.logPath = path.join(daemonDir, "nip46-signing.log");
    }

    static getInstance(): Nip46SigningLog {
        if (!Nip46SigningLog.instance) {
            Nip46SigningLog.instance = new Nip46SigningLog();
        }
        return Nip46SigningLog.instance;
    }

    /**
     * Append a log entry as a single JSONL line.
     */
    log(entry: Omit<Nip46LogEntry, "ts">): void {
        const fullEntry: Nip46LogEntry = {
            ts: new Date().toISOString(),
            ...entry,
        };

        try {
            fs.appendFileSync(this.logPath, JSON.stringify(fullEntry) + "\n");
        } catch {
            // Silent failure - logging should never crash the daemon
        }
    }

    /**
     * Convenience: truncate a pubkey to 12 chars for logging.
     */
    static truncatePubkey(pubkey: string): string {
        return pubkey.substring(0, 12);
    }
}
