import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory, fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export type Registry = Record<string, { pubkey: string }[]>;

/**
 * Service for managing agent pubkey registration across projects.
 * Maintains a registry at ~/.tenex/agents-registry.json mapping project d-tags
 * to their associated agent pubkeys.
 *
 * When the registry is updated, it publishes a kind:14199 event containing
 * whitelisted pubkeys as "p" tags and agent pubkeys as "agent" tags.
 */
export class AgentsRegistryService {
    private readonly registryPath = path.join(config.getConfigPath(), "agents-registry.json");

    constructor() {
        // ensure directory exists on construction
        ensureDirectory(path.dirname(this.registryPath)).catch((e) =>
            logger.error("Failed to ensure .tenex dir", e)
        );
    }

    private async load(): Promise<Registry> {
        if (!(await fileExists(this.registryPath))) return {};
        const data = await readJsonFile(this.registryPath);
        // simple runtime validation
        if (typeof data !== "object" || data === null) return {};
        return data as Registry;
    }

    private async save(reg: Registry): Promise<void> {
        await writeJsonFile(this.registryPath, reg);
    }

    /** Add an agent pubkey to a project entry */
    async addAgent(projectTag: string, agentPubkey: string): Promise<void> {
        const reg = await this.load();
        const list = reg[projectTag] ?? [];
        if (!list.some((e) => e.pubkey === agentPubkey)) {
            list.push({ pubkey: agentPubkey });
            reg[projectTag] = list;
            await this.save(reg);
            await this.publishSnapshot(projectTag);
        }
    }

    /** Return list of projects (d-tags) an agent belongs to */
    async getProjectsForAgent(agentPubkey: string): Promise<string[]> {
        const reg = await this.load();
        return Object.entries(reg)
            .filter(([, arr]) => arr.some((e) => e.pubkey === agentPubkey))
            .map(([tag]) => tag);
    }

    /** Publish a kind 14199 snapshot for a specific project */
    private async publishSnapshot(projectTag: string): Promise<void> {
        const reg = await this.load();
        const agents = reg[projectTag] ?? [];
        const tenexNsec = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(tenexNsec);
        const ndk = getNDK();

        const ev = new NDKEvent(ndk, {
            kind: 14199,
        });

        // whitelisted pubs from config (no CLI override here)
        const whitelisted = config.getWhitelistedPubkeys(
            undefined,
            config.getConfig()
        );
        for (const pk of whitelisted) {
            ev.tag(["p", pk]);
        }

        // agent tags
        for (const a of agents) {
            ev.tag(["p", a.pubkey]);
        }

        await ev.sign(signer);
        ev.publish();

        logger.debug("Published agents-registry snapshot", {
            projectTag,
            agentCount: agents.length,
            whitelistedCount: whitelisted.length,
        });
    }
}

// Export a singleton for easy import
export const agentsRegistryService = new AgentsRegistryService();
