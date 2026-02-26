/**
 * Centralized event kind definitions for TENEX.
 *
 * This module extends NDK's NDKKind enum with custom Tenex event kinds.
 * All kind references throughout the codebase should use this module instead
 * of importing NDKKind directly or using magic numbers.
 */

import { NDKKind as BaseNDKKind } from "@nostr-dev-kit/ndk";

// Re-export all base NDK kinds
export const NDKKind = {
    ...BaseNDKKind,

    // Standard NIP kinds
    Text: 1 as BaseNDKKind, // Regular text note (kind:1) - unified conversation format
    EventMetadata: 513 as BaseNDKKind, // Event metadata (titles, summaries)
    Comment: 1111 as BaseNDKKind, // NIP-22 Comment - used for lesson refinements
    AgentLesson: 4129 as BaseNDKKind, // Agent Lesson - learned knowledge
    AgentDefinition: 4199 as BaseNDKKind, // Agent Definition
    AgentNudge: 4201 as BaseNDKKind, // Agent Nudge - system prompt injection
    AgentSkill: 4202 as BaseNDKKind, // Agent Skill - transient capability injection
    DelegationMarker: 4203 as BaseNDKKind, // Delegation Marker - lifecycle tracking
    NudgeSkillWhitelist: 14202 as BaseNDKKind, // Nudge/Skill Whitelist - NIP-51-like list of e-tagged nudges/skills
    ProjectAgentSnapshot: 14199 as BaseNDKKind, // Owner-agent declaration (replaceable, p-tags agents)

    // Tenex custom kinds (2xxxx range)
    TenexBootProject: 24000 as BaseNDKKind, // Boot project via a-tag
    TenexProjectStatus: 24010 as BaseNDKKind,
    TenexAgentConfigUpdate: 24020 as BaseNDKKind,
    TenexAgentDelete: 24030 as BaseNDKKind, // Agent deletion from projects or globally
    TenexConfigUpdate: 25000 as BaseNDKKind, // Encrypted config updates (e.g., APNs device tokens)
    TenexOperationsStatus: 24133 as BaseNDKKind,
    TenexStopCommand: 24134 as BaseNDKKind,
} as const;

export type NDKKind = (typeof NDKKind)[keyof typeof NDKKind];
