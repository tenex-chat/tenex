/**
 * Centralized event kind definitions for TENEX.
 *
 * This module extends NDK's NDKKind enum with custom Tenex event kinds.
 * All kind references throughout the codebase should use this module instead
 * of importing NDKKind directly or using magic numbers.
 */

import { NDKKind as BaseNDKKind, NDKProject } from "@nostr-dev-kit/ndk";

// Re-export all base NDK kinds
export const NDKKind = {
    ...BaseNDKKind,

    // Standard NIP kinds
    Text: 1 as BaseNDKKind, // Regular text note (kind:1) - unified conversation format
    LongFormArticle: 30023 as BaseNDKKind, // NIP-23 Long-form article
    EventMetadata: 513 as BaseNDKKind, // Event metadata (titles, summaries)
    Comment: 1111 as BaseNDKKind, // NIP-22 Comment - used for lesson refinements
    AgentLesson: 4129 as BaseNDKKind, // Agent Lesson - learned knowledge
    AgentDefinition: 4199 as BaseNDKKind, // Agent Definition
    AgentSkill: 4202 as BaseNDKKind, // Agent Skill - instruction bundle injection
    SkillWhitelist: 14202 as BaseNDKKind, // Skill Whitelist - NIP-51-like list of e-tagged skills
    ProjectAgentSnapshot: 14199 as BaseNDKKind, // Owner-agent declaration (replaceable, p-tags agents)
    Project: NDKProject.kind as BaseNDKKind, // NIP-33 Project definition

    // Tenex custom kinds (2xxxx range)
    TenexBootProject: 24000 as BaseNDKKind, // Boot project via a-tag
    TenexAgentCreate: 24001 as BaseNDKKind, // Request backend-side agent creation/install
    TenexProjectStatus: 24010 as BaseNDKKind,
    TenexAgentConfig: 24011 as BaseNDKKind, // Per-agent configuration (model/skills/mcp) — one event per agent
    TenexBackendHeartbeat: 24012 as BaseNDKKind, // Backend whitelist request (ephemeral, p-tags owner)
    TenexAgentConfigUpdate: 24020 as BaseNDKKind,
    TenexAgentDelete: 24030 as BaseNDKKind, // Agent deletion from projects or globally
    TenexOperationsStatus: 24133 as BaseNDKKind,
    TenexStopCommand: 24134 as BaseNDKKind,
    TenexStreamTextDelta: 24135 as BaseNDKKind,
} as const;

export type NDKKind = (typeof NDKKind)[keyof typeof NDKKind];
