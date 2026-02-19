import * as crypto from "node:crypto";
import type { AgentConfig } from "@/agents/types";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import {
    NDKEvent,
    NDKPrivateKeySigner,
    type NDKProject,
} from "@nostr-dev-kit/ndk";

/**
 * Publishes Nostr events for agent profiles and creation.
 * Separated from AgentPublisher to handle agent setup vs runtime publishing.
 */
export class AgentProfilePublisher {
    /** Timeout in milliseconds for publish operations */
    private static readonly PUBLISH_TIMEOUT_MS = 5000;

    /** Avatar style families for deterministic avatar selection */
    private static readonly AVATAR_FAMILIES = [
        "lorelei",
        "miniavs",
        "dylan",
        "pixel-art",
        "rings",
        "avataaars",
    ];

    /**
     * Builds a deterministic avatar URL based on the pubkey.
     * Uses DiceBear API with a family selected based on pubkey hash.
     */
    private static buildAvatarUrl(pubkey: string): string {
        const familyIndex =
            Number.parseInt(pubkey.substring(0, 8), 16) % AgentProfilePublisher.AVATAR_FAMILIES.length;
        const avatarStyle = AgentProfilePublisher.AVATAR_FAMILIES[familyIndex];
        return `https://api.dicebear.com/7.x/${avatarStyle}/png?seed=${pubkey}`;
    }
    /**
     * Publishes a kind:14199 snapshot event for a project, listing all associated agents.
     * Reads agent associations from AgentStorage instead of maintaining a separate registry.
     */
    static async publishProjectAgentSnapshot(projectTag: string): Promise<void> {
        // Get all agents for this project from AgentStorage
        const agents = await agentStorage.getProjectAgents(projectTag);
        const tenexNsec = await config.ensureBackendPrivateKey();
        const signer = new NDKPrivateKeySigner(tenexNsec);
        const ndk = getNDK();

        const ev = new NDKEvent(ndk, {
            kind: 14199,
        });

        // Add whitelisted pubkeys
        const whitelisted = config.getWhitelistedPubkeys(undefined, config.getConfig());
        for (const pk of whitelisted) {
            ev.tag(["p", pk]);
        }

        // Add agent pubkeys
        for (const agent of agents) {
            const agentSigner = new NDKPrivateKeySigner(agent.nsec);
            ev.tag(["p", agentSigner.pubkey]);
        }

        await ev.sign(signer);
        ev.publish();
    }

    /**
     * Publishes a kind:0 profile event for an agent
     */
    static async publishAgentProfile(
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
            // Check if there are other agents with the same slug (name) in this project
            // If so, append pubkey prefix for disambiguation
            const projectDTag = projectEvent.dTag;
            let displayName = agentName;

            if (projectDTag) {
                // Load the agent's slug from storage to check for conflicts
                const agent = await agentStorage.loadAgent(signer.pubkey);
                if (agent && agent.slug) {
                    // Check if this slug has conflicts (multiple pubkeys for same slug)
                    const conflictingAgent = await agentStorage.getAgentBySlugForProject(
                        agent.slug,
                        projectDTag
                    );

                    // If we found an agent with this slug but it's a different pubkey, there's a conflict
                    if (conflictingAgent && conflictingAgent.nsec !== agent.nsec) {
                        const otherSigner = new NDKPrivateKeySigner(conflictingAgent.nsec);
                        if (otherSigner.pubkey !== signer.pubkey) {
                            // Conflict exists - append pubkey prefix to both names
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

            const avatarUrl = AgentProfilePublisher.buildAvatarUrl(signer.pubkey);

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

            // Validate projectEvent has required fields before tagging
            // Both pubkey and dTag are required for valid NIP-01 addressable coordinates:
            // Format: <kind>:<pubkey>:<d-tag> (e.g., "31933:abc123:my-project")
            // Note: projectDTag was already declared earlier for conflict detection
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
                // Properly tag the project event (creates an "a" tag for kind:31933)
                // Note: We only tag the CURRENT project. Each project publishes
                // the agent's profile with its own a-tag when the agent boots there.
                // This avoids the multi-owner problem where other projects may have
                // different owner pubkeys that we don't have access to.
                profileEvent.tag(projectEvent.tagReference());
            }

            // Add e-tag for the agent definition event if it exists and is valid
            // OR add metadata tags as fallback for agents without a valid event ID
            const trimmedEventId = agentDefinitionEventId?.trim() ?? "";
            const isValidHexEventId = /^[a-f0-9]{64}$/i.test(trimmedEventId);

            if (isValidHexEventId) {
                profileEvent.tags.push(["e", trimmedEventId]);
            } else {
                // Log warning only if an event ID was provided but is invalid
                if (trimmedEventId !== "") {
                    logger.warn(
                        "Invalid event ID format for agent definition in profile, using metadata tags instead",
                        {
                            eventId: agentDefinitionEventId,
                        }
                    );
                }

                // Add metadata tags for agents without a valid NDKAgentDefinition event ID
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

            // Add p-tags for all whitelisted pubkeys
            if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
                for (const pubkey of whitelistedPubkeys) {
                    if (pubkey && pubkey !== signer.pubkey) {
                        // Don't p-tag self
                        profileEvent.tags.push(["p", pubkey]);
                    }
                }
            }

            // Add bot tag
            profileEvent.tags.push(["bot"]);

            // Add tenex tag
            profileEvent.tags.push(["t", "tenex"]);

            await profileEvent.sign(signer, { pTags: false });

            try {
                await profileEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish agent profile (may already exist)", {
                    error: publishError,
                    agentName,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }

            // Publish kind:14199 snapshot for this project after successful profile publish
            const projectTag = projectEvent.tagId();
            if (projectTag) {
                await AgentProfilePublisher.publishProjectAgentSnapshot(projectTag);
            }
        } catch (error) {
            logger.error("Failed to create agent profile", {
                error,
                agentName,
            });
            throw error;
        }
    }

    /**
     * Publishes an agent request event
     */
    static async publishAgentRequest(
        signer: NDKPrivateKeySigner,
        agentConfig: Omit<AgentConfig, "nsec">,
        projectEvent: NDKProject,
        ndkAgentEventId?: string
    ): Promise<NDKEvent> {
        try {
            const requestEvent = new NDKEvent(getNDK(), {
                kind: NDKKind.AgentRequest,
                content: "",
                tags: [],
            });

            // Properly tag the project event
            requestEvent.tag(projectEvent);

            const tags: string[][] = [];

            // Only add e-tag if this agent was created from an NDKAgentDefinition event and is valid
            if (ndkAgentEventId && ndkAgentEventId.trim() !== "") {
                // Validate that it's a proper hex event ID (64 characters)
                const trimmedId = ndkAgentEventId.trim();
                if (/^[a-f0-9]{64}$/i.test(trimmedId)) {
                    tags.push(["e", trimmedId, "", "agent-definition"]);
                } else {
                    logger.warn(
                        "Invalid event ID format for agent definition in request, skipping e-tag",
                        {
                            eventId: ndkAgentEventId,
                        }
                    );
                }
            }

            // Add agent metadata tags
            tags.push(["name", agentConfig.name]);

            // Add the other tags
            requestEvent.tags.push(...tags);

            await requestEvent.sign(signer, { pTags: false });

            try {
                await requestEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish agent request (may already exist)", {
                    error: publishError,
                    agentName: agentConfig.name,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }

            return requestEvent;
        } catch (error) {
            logger.error("Failed to create agent request", {
                error,
                agentName: agentConfig.name,
            });
            throw error;
        }
    }

    /**
     * Publishes a kind:3 contact list for an agent
     * This allows agents to follow other agents in the project and whitelisted pubkeys
     */
    static async publishContactList(
        signer: NDKPrivateKeySigner,
        contactPubkeys: string[]
    ): Promise<void> {
        try {
            // Create a kind:3 event (contact list)
            const contactListEvent = new NDKEvent(getNDK(), {
                kind: 3,
                pubkey: signer.pubkey,
                content: "", // Contact list content is usually empty
                tags: [],
            });

            // Add p-tags for each contact
            for (const pubkey of contactPubkeys) {
                if (pubkey && pubkey !== signer.pubkey) {
                    // Don't follow self
                    contactListEvent.tags.push(["p", pubkey]);
                }
            }

            // Sign and publish the contact list
            await contactListEvent.sign(signer, { pTags: false });

            try {
                await contactListEvent.publish();
            } catch (publishError) {
                logger.warn("Failed to publish contact list (may already exist)", {
                    error: publishError,
                    agentPubkey: signer.pubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to create contact list", {
                error,
                agentPubkey: signer.pubkey.substring(0, 8),
            });
            // Don't throw - contact list is not critical
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
    static async publishBackendProfile(
        signer: NDKPrivateKeySigner,
        backendName: string = "tenex backend",
        whitelistedPubkeys?: string[]
    ): Promise<void> {
        try {
            const avatarUrl = AgentProfilePublisher.buildAvatarUrl(signer.pubkey);

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

            // Add p-tags for all whitelisted pubkeys
            if (whitelistedPubkeys && whitelistedPubkeys.length > 0) {
                for (const pubkey of whitelistedPubkeys) {
                    if (pubkey && pubkey !== signer.pubkey) {
                        profileEvent.tags.push(["p", pubkey]);
                    }
                }
            }

            // Add bot tag to indicate this is an automated system
            profileEvent.tags.push(["bot"]);

            // Add tenex tag for discoverability
            profileEvent.tags.push(["t", "tenex"]);

            // Add tenex-backend tag to distinguish from agents
            profileEvent.tags.push(["t", "tenex-backend"]);

            await profileEvent.sign(signer, { pTags: false });

            try {
                // Publish with timeout - don't block daemon startup if relays are slow
                await Promise.race([
                    profileEvent.publish(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Publish timeout")), AgentProfilePublisher.PUBLISH_TIMEOUT_MS)
                    ),
                ]);
                logger.info("Published TENEX backend profile", {
                    pubkey: signer.pubkey.substring(0, 8),
                    name: backendName,
                });
            } catch (publishError) {
                logger.warn("Failed to publish backend profile (relay timeout or error)", {
                    error: publishError,
                    pubkey: signer.pubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to create backend profile", {
                error,
            });
            // Don't throw - backend profile is not critical for operation
        }
    }

    /**
     * In-memory cache of last published instruction hash per agent pubkey.
     * Used for deduplication to avoid publishing duplicate kind:0 events
     * when compiled instructions haven't changed.
     */
    private static lastPublishedInstructionHash: Map<string, string> = new Map();

    /**
     * Publishes a kind:0 profile event with compiled instructions for an agent.
     * Uses hash-based deduplication to avoid publishing when instructions haven't changed.
     * This is fire-and-forget - failures are logged but don't throw.
     *
     * Callers should use `void AgentProfilePublisher.publishCompiledInstructions(...)` to
     * explicitly indicate the fire-and-forget intent.
     *
     * @param signer The agent's NDKPrivateKeySigner
     * @param compiledInstructions The compiled effective instructions from PromptCompilerService
     * @param agentName The agent's display name
     * @param agentRole The agent's role description
     * @param projectTitle The project title for the profile description
     */
    static async publishCompiledInstructions(
        signer: NDKPrivateKeySigner,
        compiledInstructions: string,
        agentName: string,
        agentRole: string,
        projectTitle: string
    ): Promise<void> {
        try {
            // Hash-based deduplication: skip if instructions haven't changed
            const instructionHash = crypto
                .createHash("sha256")
                .update(compiledInstructions)
                .digest("hex");

            const lastHash = AgentProfilePublisher.lastPublishedInstructionHash.get(signer.pubkey);
            if (lastHash === instructionHash) {
                logger.debug("Skipping kind:0 publish - compiled instructions unchanged", {
                    agentPubkey: signer.pubkey.substring(0, 8),
                });
                return;
            }

            const avatarUrl = AgentProfilePublisher.buildAvatarUrl(signer.pubkey);

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

            // Add instruction tag with compiled instructions
            profileEvent.tags.push(["instruction", compiledInstructions]);

            // Add bot tag
            profileEvent.tags.push(["bot"]);

            // Add tenex tag for discoverability
            profileEvent.tags.push(["t", "tenex"]);

            await profileEvent.sign(signer, { pTags: false });

            try {
                // Publish with timeout to prevent blocking
                await Promise.race([
                    profileEvent.publish(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Publish timeout")), AgentProfilePublisher.PUBLISH_TIMEOUT_MS)
                    ),
                ]);

                // Update deduplication cache on successful publish
                AgentProfilePublisher.lastPublishedInstructionHash.set(signer.pubkey, instructionHash);

                logger.info("Published kind:0 with compiled instructions", {
                    agentPubkey: signer.pubkey.substring(0, 8),
                    agentName,
                    instructionsLength: compiledInstructions.length,
                });
            } catch (publishError) {
                logger.warn("Failed to publish kind:0 with compiled instructions (relay timeout or error)", {
                    error: publishError,
                    agentPubkey: signer.pubkey.substring(0, 8),
                });
            }
        } catch (error) {
            logger.error("Failed to create kind:0 with compiled instructions", {
                error,
                agentPubkey: signer.pubkey.substring(0, 8),
            });
            // Don't throw - this is fire-and-forget
        }
    }
}
