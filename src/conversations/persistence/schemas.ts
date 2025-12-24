import { z } from "zod";

export const ConversationMetadataSchema = z.record(z.string(), z.unknown());

const ExecutionTimeSchema = z.object({
    totalSeconds: z.number(),
    currentSessionStart: z.number().optional(),
    isActive: z.boolean(),
    lastUpdated: z.number(),
});

// Simplified agent state schema
export const AgentStateSchema = z.object({
    lastProcessedMessageIndex: z.number().int().min(0),
});

// Todo item schema for persistence
export const TodoItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["pending", "in_progress", "done", "skipped"]),
    skipReason: z.string().optional(),
    delegationInstructions: z.string().optional(),
    position: z.number().int().min(0),
    createdAt: z.number(),
    updatedAt: z.number(),
});

export const SerializedConversationSchema = z.object({
    id: z.string(),
    title: z.string(),
    history: z.array(z.string()),
    agentStates: z.record(z.string(), AgentStateSchema).optional(), // Map serialized as object
    agentTodos: z.record(z.string(), z.array(TodoItemSchema)).optional(), // Map serialized as object
    blockedAgents: z.array(z.string()).optional(), // Set serialized as array
    metadata: ConversationMetadataSchema,
    executionTime: ExecutionTimeSchema.optional(),
});

export const ConversationMetadataFileSchema = z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    eventCount: z.number(),
    agentCount: z.number(),
    archived: z.boolean().optional(),
});

export const MetadataFileSchema = z.object({
    conversations: z.array(ConversationMetadataFileSchema),
});

export type SerializedConversation = z.infer<typeof SerializedConversationSchema>;
export type MetadataFile = z.infer<typeof MetadataFileSchema>;
