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

    // Standard NIP kinds not in NDK
    AgentLesson: 4129, // Agent Lesson - learned knowledge
    AgentRequest: 4133, // NIP-90 Agent Request
    AgentDefinition: 4199, // Agent Definition
    AgentNudge: 4201, // Agent Nudge - system prompt injection

    // Tenex custom kinds (2xxxx range)
    TenexStreamingResponse: 21111,
    TenexProjectStatus: 24010,
    TenexAgentConfigUpdate: 24020,
    TenexAgentTypingStart: 24111,
    TenexAgentTypingStop: 24112,
    TenexOperationsStatus: 24133,
    TenexStopCommand: 24134,
} as const;

export type NDKKind = typeof NDKKind[keyof typeof NDKKind];
