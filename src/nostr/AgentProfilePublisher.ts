import * as crypto from "node:crypto";
import { agentStorage } from "@/agents/AgentStorage";
import { getNDK } from "@/nostr/ndkClient";
import { getSystemPubkeyListService } from "@/services/trust-pubkeys/SystemPubkeyListService";
import { logger } from "@/utils/logger";
import { enqueueSignedEventForRustPublish } from "./RustPublishOutbox";
import {
    NDKEvent,
    NDKPrivateKeySigner,
    type NDKProject,
} from "@nostr-dev-kit/ndk";

/** Timeout in milliseconds for publish operations */
const PUBLISH_TIMEOUT_MS = 5000;

/** Avatar style families for deterministic avatar selection */
const AVATAR_FAMILIES = [
    "lorelei",
    "miniavs",
    "dylan",
    "pixel-art",
    "rings",
    "avataaars",
];

/**
 * In-memory cache of last published instruction hash per agent pubkey.
 * Used for deduplication to avoid publishing duplicate kind:0 events
 * when compiled instructions haven't changed.
 */
const lastPublishedInstructionHash: Map<string, string> = new Map();

/**
 * Builds a deterministic avatar URL based on the pubkey.
 * Uses DiceBear API with a family selected based on pubkey hash.
 */
function buildAvatarUrl(pubkey: string): string {
    const familyIndex =
        Number.parseInt(pubkey.substring(0, 8), 16) % AVATAR_FAMILIES.length;
    const avatarStyle = AVATAR_FAMILIES[familyIndex];
    return `https://api.dicebear.com/7.x/${avatarStyle}/png?seed=${pubkey}`;
}

/**
 * Publishes a kind:0 profile event for an agent
 */
export async function publishAgentProfile(
    signer: NDKPrivateKeySigner,
    agentName: string,
    agentRole: string,
    projectTitle: string,
    projectEvent: NDKProject,
    agentDefinitionEventId?: string,
    agentMetadata?: {
        description?: string;
        instructions?: string;
        useCriteria?: string;
    },
    whitelistedPubkeys?: string[]
): Promise<void> {
    let profileEvent: NDKEvent;

    try {
        await getSystemPubkeyListService().syncWhitelistFile({
            additionalPubkeys: [signer.pubkey, ...(whitelistedPubkeys ?? [])],
        });

        const projectDTag = projectEvent.dTag;
        let displayName = agentName;

        if (projectDTag) {
            const agent = await agentStorage.loadAgent(signer.pubkey);
            if (agent?.slug) {
                const conflictingAgent = await agentStorage.getAgentBySlugForProject(
                    agent.slug,
                    projectDTag
                );

                if (conflictingAgent && conflictingAgent.nsec !== agent.nsec) {
                    const otherSigner = new NDKPrivateKeySigner(conflictingAgent.nsec);
                    if (otherSigner.pubkey !== signer.pubkey) {
                        displayName = `${agentName} (${signer.pubkey.slice(0, 5)})`;
                        logger.info("Agent slug conflict detected, adding pubkey prefix to Kind 0 name", {
                            slug: agent.slug,
                            pubkey: signer.pubkey.substring(0, 8),
                            projectDTag,
                            displayName,
                        });
                    }
                }
            }
        }

        const avatarUrl = buildAvatarUrl(signer.pubkey);

        const profile = {
            name: displayName,
            description: `${agentRole} agent for ${projectTitle}`,
            picture: avatarUrl,
        };

        profileEvent = new NDKEvent(getNDK(), {
            kind: 0,
            pubkey: signer.pubkey,
            content: JSON.stringify(profile),
            tags: [],
        });

        if (!projectEvent.pubkey) {
            logger.warn("Project event missing pubkey, skipping a-tag", {
                agentPubkey: signer.pubkey,
            });
        } else if (!projectDTag) {
            logger.warn("Project event missing d-tag, skipping a-tag", {
                agentPubkey: signer.pubkey,
                projectPubkey: projectEvent.pubkey,
            });
        } else {
            profileEvent.tag(projectEvent.tagReference());
        }

        const trimmedEventId = agentDefinitionEventId?.trim() ?? "";
        const isValidHexEventId = /^[a-f0-9]{64}$/i.test(trimmedEventId);

        if (isValidHexEventId) {
            profileEvent.tags.push(["e", trimmedEventId]);
        } else {
            if (trimmedEventId !== "") {
                logger.warn(
                    "Invalid event ID format for agent definition in profile, using metadata tags instead",
                    {
                        eventId: agentDefinitionEventId,
                    }
                );
            }

            if (agentMetadata) {
                if (agentMetadata.description) {
                    profileEvent.tags.push(["description", agentMetadata.description]);
                }
                if (agentMetadata.instructions) {
                    profileEvent.tags.push(["instructions", agentMetadata.instructions]);
                }
                if (agentMetadata.useCriteria) {
                    profileEvent.tags.push(["use-criteria", agentMetadata.useCriteria]);
                }
            }
        }

        if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
            for (const pubkey of whitelistedPubkeys) {
                if (pubkey && pubkey !== signer.pubkey) {
                    profileEvent.tags.push(["p", pubkey]);
                }
            }
        }

        profileEvent.tags.push(["bot"]);
        profileEvent.tags.push(["t", "tenex"]);

        await profileEvent.sign(signer, { pTags: false });

        enqueueSignedEventForRustPublish(profileEvent, {
            correlationId: "agent_profile",
            projectId: projectDTag ?? "agent-profile",
            conversationId: signer.pubkey,
            requestId: `agent-profile:${signer.pubkey}:${profileEvent.id}`,
        }).catch((publishError) => {
            logger.warn("Failed to enqueue agent profile", {
                error: publishError,
                agentName,
                pubkey: signer.pubkey.substring(0, 8),
            });
        });
    } catch (error) {
        logger.error("Failed to create agent profile", {
            error,
            agentName,
        });
        throw error;
    }
}

/**
 * Publishes a kind:0 profile event for the TENEX backend daemon.
 * This identifies the backend as an entity on nostr.
 *
 * @param signer The backend's NDKPrivateKeySigner
 * @param backendName The name for the backend profile (default: "tenex backend")
 * @param whitelistedPubkeys Array of pubkeys to include as contacts
 */
export async function publishBackendProfile(
    signer: NDKPrivateKeySigner,
    backendName = "tenex backend",
    whitelistedPubkeys?: string[]
): Promise<void> {
    try {
        await getSystemPubkeyListService().syncWhitelistFile({
            additionalPubkeys: [signer.pubkey, ...(whitelistedPubkeys ?? [])],
        });

        const avatarUrl = buildAvatarUrl(signer.pubkey);

        const profile = {
            name: backendName,
            description: "TENEX Backend Daemon - Multi-agent orchestration system",
            picture: avatarUrl,
        };

        const profileEvent = new NDKEvent(getNDK(), {
            kind: 0,
            pubkey: signer.pubkey,
            content: JSON.stringify(profile),
            tags: [],
        });

        if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
            for (const pubkey of whitelistedPubkeys) {
                if (pubkey && pubkey !== signer.pubkey) {
                    profileEvent.tags.push(["p", pubkey]);
                }
            }
        }

        profileEvent.tags.push(["bot"]);
        profileEvent.tags.push(["t", "tenex"]);
        profileEvent.tags.push(["t", "tenex-backend"]);

        await profileEvent.sign(signer, { pTags: false });

        try {
            await enqueueSignedEventForRustPublish(profileEvent, {
                correlationId: "backend_profile",
                projectId: "backend-profile",
                conversationId: signer.pubkey,
                requestId: `backend-profile:${signer.pubkey}:${profileEvent.id}`,
                timeoutMs: PUBLISH_TIMEOUT_MS,
            });
            logger.info("Enqueued TENEX backend profile for Rust publish", {
                pubkey: signer.pubkey.substring(0, 8),
                name: backendName,
            });
        } catch (publishError) {
            logger.warn("Failed to enqueue backend profile", {
                error: publishError,
                pubkey: signer.pubkey.substring(0, 8),
            });
        }
    } catch (error) {
        logger.error("Failed to create backend profile", {
            error,
        });
    }
}

/**
 * Publishes a kind:0 profile event with compiled instructions for an agent.
 * Uses hash-based deduplication to avoid publishing when instructions haven't changed.
 * This is fire-and-forget - failures are logged but don't throw.
 *
 * Callers should use `void publishCompiledInstructions(...)` to
 * explicitly indicate the fire-and-forget intent.
 *
 * @param signer The agent's NDKPrivateKeySigner
 * @param compiledInstructions The compiled effective instructions from PromptCompilerService
 * @param agentName The agent's display name
 * @param agentRole The agent's role description
 * @param projectTitle The project title for the profile description
 */
export async function publishCompiledInstructions(
    signer: NDKPrivateKeySigner,
    compiledInstructions: string,
    agentName: string,
    agentRole: string,
    projectTitle: string
): Promise<void> {
    try {
        await getSystemPubkeyListService().syncWhitelistFile({
            additionalPubkeys: [signer.pubkey],
        });

        const instructionHash = crypto
            .createHash("sha256")
            .update(compiledInstructions)
            .digest("hex");

        const lastHash = lastPublishedInstructionHash.get(signer.pubkey);
        if (lastHash === instructionHash) {
            logger.debug("Skipping kind:0 publish - compiled instructions unchanged", {
                agentPubkey: signer.pubkey.substring(0, 8),
            });
            return;
        }

        const avatarUrl = buildAvatarUrl(signer.pubkey);

        const profile = {
            name: agentName,
            description: `${agentRole} agent for ${projectTitle}`,
            picture: avatarUrl,
        };

        const profileEvent = new NDKEvent(getNDK(), {
            kind: 0,
            pubkey: signer.pubkey,
            content: JSON.stringify(profile),
            tags: [],
        });

        profileEvent.tags.push(["instruction", compiledInstructions]);
        profileEvent.tags.push(["bot"]);
        profileEvent.tags.push(["t", "tenex"]);

        await profileEvent.sign(signer, { pTags: false });

        try {
            await enqueueSignedEventForRustPublish(profileEvent, {
                correlationId: "compiled_instructions",
                projectId: "compiled-instructions",
                conversationId: signer.pubkey,
                requestId: `compiled-instructions:${signer.pubkey}:${profileEvent.id}`,
                timeoutMs: PUBLISH_TIMEOUT_MS,
            });

            lastPublishedInstructionHash.set(signer.pubkey, instructionHash);

            logger.info("Enqueued kind:0 with compiled instructions for Rust publish", {
                agentPubkey: signer.pubkey.substring(0, 8),
                agentName,
                instructionsLength: compiledInstructions.length,
            });
        } catch (publishError) {
            logger.warn("Failed to enqueue kind:0 with compiled instructions", {
                error: publishError,
                agentPubkey: signer.pubkey.substring(0, 8),
            });
        }
    } catch (error) {
        logger.error("Failed to create kind:0 with compiled instructions", {
            error,
            agentPubkey: signer.pubkey.substring(0, 8),
        });
    }
}
