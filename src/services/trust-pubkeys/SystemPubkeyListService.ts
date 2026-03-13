import * as fs from "node:fs/promises";
import * as path from "node:path";
import { agentStorage } from "@/agents/AgentStorage";
import { ensureDirectory, readFile } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

export interface SyncSystemPubkeyListOptions {
    /**
     * Extra pubkeys to force-include in the output file.
     * Useful for "about to publish" contexts where the pubkey must be present
     * even if other registries haven't synced yet.
     */
    additionalPubkeys?: Iterable<string>;
}

/**
 * Maintains `$TENEX_BASE_DIR/daemon/whitelist.txt` as the canonical list of
 * pubkeys known to belong to this TENEX system.
 *
 * The file contains one pubkey per line and is rebuilt from:
 * - daemon/user whitelist from config
 * - backend pubkey
 * - all known agent pubkeys from storage
 * - optional call-site additions (e.g., the pubkey being published right now)
 */
export class SystemPubkeyListService {
    private static instance: SystemPubkeyListService;

    static getInstance(): SystemPubkeyListService {
        if (!SystemPubkeyListService.instance) {
            SystemPubkeyListService.instance = new SystemPubkeyListService();
        }
        return SystemPubkeyListService.instance;
    }

    /**
     * Rebuild and persist daemon whitelist file.
     * Idempotent: skips writes when content is unchanged.
     */
    async syncWhitelistFile(options: SyncSystemPubkeyListOptions = {}): Promise<void> {
        const daemonDir = config.getConfigPath("daemon");
        const whitelistPath = path.join(daemonDir, "whitelist.txt");
        const pubkeys = await this.collectKnownSystemPubkeys(options.additionalPubkeys);
        const content = this.serialize(pubkeys);

        await ensureDirectory(daemonDir);

        const existing = await this.safeReadFile(whitelistPath);
        if (existing === content) {
            return;
        }

        await this.atomicWrite(whitelistPath, content);
        logger.debug("[SYSTEM_PUBKEY_LIST] Updated daemon whitelist.txt", {
            path: whitelistPath,
            pubkeyCount: pubkeys.length,
        });
    }

    private async collectKnownSystemPubkeys(additionalPubkeys?: Iterable<string>): Promise<string[]> {
        const pubkeys = new Set<string>();

        // Whitelisted daemon pubkeys from loaded config
        try {
            const whitelisted = config.getWhitelistedPubkeys();
            for (const pubkey of whitelisted) {
                this.addPubkey(pubkeys, pubkey);
            }
        } catch (error) {
            logger.debug("[SYSTEM_PUBKEY_LIST] Failed to load whitelisted pubkeys", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // TENEX backend pubkey
        try {
            const backendSigner = await config.getBackendSigner();
            this.addPubkey(pubkeys, backendSigner.pubkey);
        } catch (error) {
            logger.debug("[SYSTEM_PUBKEY_LIST] Failed to load backend pubkey", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // All known agents (across projects) from storage
        try {
            const knownAgentPubkeys = await agentStorage.getAllKnownPubkeys();
            for (const pubkey of knownAgentPubkeys) {
                this.addPubkey(pubkeys, pubkey);
            }
        } catch (error) {
            logger.debug("[SYSTEM_PUBKEY_LIST] Failed to load known agent pubkeys", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // Call-site additions (e.g., pubkey being published right now)
        if (additionalPubkeys) {
            for (const pubkey of additionalPubkeys) {
                this.addPubkey(pubkeys, pubkey);
            }
        }

        return Array.from(pubkeys).sort();
    }

    private addPubkey(pubkeys: Set<string>, candidate: string | undefined): void {
        if (!candidate) {
            return;
        }

        const trimmed = candidate.trim();
        if (!trimmed) {
            return;
        }

        pubkeys.add(trimmed);
    }

    private serialize(pubkeys: string[]): string {
        if (pubkeys.length === 0) {
            return "";
        }
        return `${pubkeys.join("\n")}\n`;
    }

    private async safeReadFile(filePath: string): Promise<string | null> {
        try {
            return await readFile(filePath, "utf-8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                return null;
            }
            throw error;
        }
    }

    private async atomicWrite(filePath: string, content: string): Promise<void> {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, content, "utf-8");
        await fs.rename(tempPath, filePath);
    }
}

export const getSystemPubkeyListService = (): SystemPubkeyListService =>
    SystemPubkeyListService.getInstance();
