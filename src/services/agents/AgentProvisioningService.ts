import { agentStorage, createStoredAgent, type StoredAgent } from "@/agents/AgentStorage";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { initNDK } from "@/nostr/ndkClient";
import { InstalledAgentListService } from "@/services/status/InstalledAgentListService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export interface ProvisionedAgentResult {
    storedAgent: StoredAgent;
    pubkey: string;
    created: boolean;
}

export interface CreateLocalAgentInput {
    slug: string;
    name: string;
    role: string;
    instructions?: string;
    useCriteria?: string;
    llmConfig?: string | null;
    tools?: string[] | null;
}

async function publishInstalledAgentsInventory(): Promise<void> {
    const publisher = new InstalledAgentListService();
    try {
        await initNDK();
        await publisher.publishImmediately();
    } catch (error) {
        logger.warn("[AgentProvisioningService] Failed to publish installed-agent inventory", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function createLocalAgent(
    input: CreateLocalAgentInput,
    options?: {
        publishInventory?: boolean;
    }
): Promise<ProvisionedAgentResult> {
    await agentStorage.initialize();

    const signer = NDKPrivateKeySigner.generate();
    const storedAgent = createStoredAgent({
        nsec: signer.nsec,
        slug: input.slug,
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        useCriteria: input.useCriteria,
        defaultConfig: {
            model: input.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
            tools: input.tools ?? undefined,
        },
    });

    await agentStorage.saveAgent(storedAgent);

    if (options?.publishInventory !== false) {
        await publishInstalledAgentsInventory();
    }

    return {
        storedAgent,
        pubkey: signer.pubkey,
        created: true,
    };
}

export async function deleteStoredAgent(
    pubkey: string,
    options?: {
        publishInventory?: boolean;
        quiet?: boolean;
    }
): Promise<boolean> {
    await agentStorage.initialize();

    const existingAgent = await agentStorage.loadAgent(pubkey);
    if (!existingAgent) {
        return false;
    }

    await agentStorage.deleteAgent(pubkey, {
        quiet: options?.quiet,
    });

    if (options?.publishInventory !== false) {
        await publishInstalledAgentsInventory();
    }

    return true;
}
