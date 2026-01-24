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
    AgentRequest: 4133 as BaseNDKKind, // NIP-90 Agent Request
    AgentDefinition: 4199 as BaseNDKKind, // Agent Definition
    AgentNudge: 4201 as BaseNDKKind, // Agent Nudge - system prompt injection

    // Tenex custom kinds (2xxxx range)
    TenexBootProject: 24000 as BaseNDKKind, // Boot project via a-tag
    TenexProjectStatus: 24010 as BaseNDKKind,
    TenexAgentConfigUpdate: 24020 as BaseNDKKind,
    TenexOperationsStatus: 24133 as BaseNDKKind,
    TenexStopCommand: 24134 as BaseNDKKind,
} as const;

export type NDKKind = (typeof NDKKind)[keyof typeof NDKKind];
