import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getAgentHomeDirectory } from "./agent-home";

export interface EnsureAgentHomeEnvFileResult {
    path: string;
    created: boolean;
}

function isAlreadyBech32Nsec(value: string): boolean {
    return value.startsWith("nsec1");
}

export function normalizeNsecToBech32(agentNsec: string): string {
    const trimmed = agentNsec.trim();

    if (trimmed.length === 0) {
        throw new Error("Agent nsec is empty");
    }

    if (isAlreadyBech32Nsec(trimmed)) {
        const decoded = nip19.decode(trimmed);
        if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
            throw new Error("Agent nsec is not a valid bech32 nsec");
        }
        return trimmed;
    }

    const signer = new NDKPrivateKeySigner(trimmed);
    const privateKey = signer.privateKey?.trim();
    if (!privateKey) {
        throw new Error("Agent nsec could not be normalized to bech32");
    }

    return nip19.nsecEncode(Buffer.from(privateKey, "hex"));
}

function buildAgentHomeEnvBootstrap(
    normalizedNsec: string,
    pubkey: string,
    npub: string,
    relays?: string[]
): string {
    const lines = [
        "# TENEX agent shell environment",
        "# Shell sessions auto-load this file. Add additional KEY=value entries below.",
        `NSEC=${normalizedNsec}`,
        `PUBKEY=${pubkey}`,
        `NPUB=${npub}`,
    ];

    if (relays && relays.length > 0) {
        lines.push(`RELAYS=${relays.join(",")}`);
    }

    lines.push("");
    return lines.join("\n");
}

export function getAgentHomeEnvPath(agentPubkey: string): string {
    return join(getAgentHomeDirectory(agentPubkey), ".env");
}

export async function ensureAgentHomeEnvFile(
    agentPubkey: string,
    agentNsec: string,
    relays?: string[]
): Promise<EnsureAgentHomeEnvFileResult> {
    const homeDir = getAgentHomeDirectory(agentPubkey);
    const envPath = getAgentHomeEnvPath(agentPubkey);
    const normalizedNsec = normalizeNsecToBech32(agentNsec);
    const signer = new NDKPrivateKeySigner(normalizedNsec);
    const pubkey = signer.pubkey;
    const npub = signer.npub;

    await mkdir(homeDir, { recursive: true });

    try {
        await writeFile(envPath, buildAgentHomeEnvBootstrap(normalizedNsec, pubkey, npub, relays), {
            encoding: "utf-8",
            flag: "wx",
            mode: 0o600,
        });
        return { path: envPath, created: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { path: envPath, created: false };
        }
        throw error;
    }
}
