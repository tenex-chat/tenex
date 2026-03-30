import { agentStorage, createStoredAgent, type StoredAgent } from "@/agents/AgentStorage";
import { installAgentFromNostr, installAgentFromNostrEvent } from "@/agents/agent-installer";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { InstalledAgentListService } from "@/services/status/InstalledAgentListService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner, type NDKEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";

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
        await publisher.publishImmediately();
    } catch (error) {
        logger.warn("[AgentProvisioningService] Failed to publish installed-agent inventory", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function installAgentFromDefinitionEventId(
    definitionEventId: string,
    options?: {
        slugOverride?: string;
        ndk?: NDK;
        publishInventory?: boolean;
    }
): Promise<ProvisionedAgentResult> {
    await agentStorage.initialize();

    const existingAgent = await agentStorage.getAgentByEventId(definitionEventId);
    const storedAgent = await installAgentFromNostr(
        definitionEventId,
        options?.slugOverride,
        options?.ndk
    );

    if (options?.publishInventory !== false) {
        await publishInstalledAgentsInventory();
    }

    return {
        storedAgent,
        pubkey: new NDKPrivateKeySigner(storedAgent.nsec).pubkey,
        created: !existingAgent,
    };
}

export async function installAgentFromDefinitionEvent(
    definitionEvent: NDKEvent,
    options?: {
        slugOverride?: string;
        ndk?: NDK;
        publishInventory?: boolean;
    }
): Promise<ProvisionedAgentResult> {
    await agentStorage.initialize();

    const existingAgent = definitionEvent.id
        ? await agentStorage.getAgentByEventId(definitionEvent.id)
        : null;
    const storedAgent = await installAgentFromNostrEvent(
        definitionEvent,
        options?.slugOverride,
        options?.ndk
    );

    if (options?.publishInventory !== false) {
        await publishInstalledAgentsInventory();
    }

    return {
        storedAgent,
        pubkey: new NDKPrivateKeySigner(storedAgent.nsec).pubkey,
        created: !existingAgent,
    };
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
