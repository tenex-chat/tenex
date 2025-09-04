import { z } from "zod";

const PhaseSchema = z.string(); // Any string is a valid phase now

export const PhaseTransitionSchema = z.object({
  from: PhaseSchema,
  to: PhaseSchema,
  message: z.string(),
  timestamp: z.number(),
  agentPubkey: z.string(),
  agentName: z.string(),
});

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
  claudeSessionsByPhase: z.record(z.string(), z.string()).optional(), // Phase -> sessionId mapping
  lastSeenPhase: z.string().optional(), // Phase as string
});

export const SerializedConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  phase: PhaseSchema,
  history: z.array(z.string()),
  agentStates: z.record(z.string(), AgentStateSchema).optional(), // Map serialized as object
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
