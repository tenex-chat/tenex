import { z } from "zod";

const PhaseSchema = z
    .string()
    .transform((val) => val.toLowerCase())
    .pipe(
        z.enum([
            "chat",
            "brainstorm",
            "plan",
            "execute",
            "verification",
            "chores",
            "reflection",
        ])
    );

export const PhaseTransitionSchema = z.object({
    from: PhaseSchema,
    to: PhaseSchema,
    message: z.string(),
    timestamp: z.number(),
    agentPubkey: z.string(),
    agentName: z.string(),
    reason: z.string().optional(),
    // Enhanced handoff fields
    summary: z.string().optional(),
    requirements: z.string().optional(),
    artifacts: z.any().optional(),
    goal: z.string().optional(),
});

export const ConversationMetadataSchema = z.record(z.string(), z.unknown());

const ExecutionTimeSchema = z.object({
    totalSeconds: z.number(),
    currentSessionStart: z.number().optional(),
    isActive: z.boolean(),
    lastUpdated: z.number(),
});

// Message schema for agent contexts
const MessageSchema = z.object({
    role: z.enum(["user", "assistant", "system", "developer", "tool"]),
    content: z.string(),
    reasoning: z.string().nullable().optional(),
    attachments: z.array(z.any()).optional(),
});

export const AgentContextSchema = z.object({
    agentSlug: z.string(),
    messages: z.array(MessageSchema),
    tokenCount: z.number(),
    lastUpdate: z.string(), // ISO string for Date
});

export const SerializedConversationSchema = z.object({
    id: z.string(),
    title: z.string(),
    phase: PhaseSchema,
    history: z.array(z.string()),
    agentContexts: z.record(z.string(), AgentContextSchema).optional(), // Map serialized as object
    phaseStartedAt: z.number().optional(),
    metadata: ConversationMetadataSchema,
    phaseTransitions: z.array(PhaseTransitionSchema).default([]),
    executionTime: ExecutionTimeSchema.optional(),
});

export const ConversationMetadataFileSchema = z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    phase: z.string(),
    eventCount: z.number(),
    agentCount: z.number(),
    archived: z.boolean().optional(),
});

export const MetadataFileSchema = z.object({
    conversations: z.array(ConversationMetadataFileSchema),
});

export type SerializedConversation = z.infer<typeof SerializedConversationSchema>;
export type MetadataFile = z.infer<typeof MetadataFileSchema>;
