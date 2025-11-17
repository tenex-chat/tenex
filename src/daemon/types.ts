import type { Hexpubkey, NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Branded type for Project IDs
 * Format: "31933:authorPubkey:dTag"
 *
 * Using branded types provides compile-time safety to prevent
 * mixing up regular strings with project IDs.
 */
export type ProjectId = string & { __brand: "ProjectId" };

/**
 * Helper to create a ProjectId from components
 */
export function createProjectId(authorPubkey: string, dTag: string): ProjectId {
    return `31933:${authorPubkey}:${dTag}` as ProjectId;
}

/**
 * Helper to create a ProjectId from raw string (with validation)
 */
export function toProjectId(id: string): ProjectId {
    if (!id.startsWith("31933:")) {
        throw new Error(`Invalid project ID format: ${id}`);
    }
    return id as ProjectId;
}

/**
 * Event classification for daemon routing decisions
 */
export type EventClassification =
    | "never_route" // Events that should never be routed (status, streaming, etc.)
    | "project" // Project creation/update events (kind 31933)
    | "lesson" // Agent lesson events (kind 4129)
    | "conversation" // Reply and thread events
    | "unknown"; // Unclassified events

/**
 * Routing decision for an event
 * This is a discriminated union for type-safe routing handling
 */
export type RoutingDecision =
    | {
          type: "route_to_project";
          projectId: ProjectId;
          method: "a_tag" | "p_tag_agent";
          matchedTags: string[];
      }
    | {
          type: "dropped";
          reason: string;
      }
    | {
          type: "lesson_hydration";
          targetProjects: ProjectId[];
          agentDefinitionId: string;
      }
    | {
          type: "project_event";
          projectId: ProjectId;
          isUpdate: boolean;
      };

/**
 * Runtime action performed when routing an event
 */
export type RuntimeAction = "existing" | "started" | "crashed";

/**
 * Routing context containing all data needed for routing decisions
 */
export interface RoutingContext {
    /** Known project IDs mapped to their NDKProject instances */
    knownProjects: Map<ProjectId, unknown>; // Using unknown to avoid circular deps
    /** Map of agent pubkeys to their project IDs */
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectId>>;
    /** Whitelisted user pubkeys */
    whitelistedPubkeys: Hexpubkey[];
    /** Currently active runtime project IDs */
    activeProjectIds: Set<ProjectId>;
}

/**
 * Event routing result with telemetry metadata
 */
export interface EventRoutingResult {
    decision: RoutingDecision;
    timestamp: number;
    eventId: string;
    eventKind: number | undefined;
    processingTimeMs?: number;
}

/**
 * Runtime status for monitoring
 */
export interface RuntimeStatus {
    projectId: ProjectId;
    isRunning: boolean;
    title: string;
    startTime: Date | null;
    lastEventTime: Date | null;
    eventCount: number;
    agentCount: number;
    hasError?: boolean;
    errorMessage?: string;
}

/**
 * Daemon status for monitoring
 */
export interface DaemonStatus {
    running: boolean;
    knownProjects: number;
    activeProjects: number;
    startingProjects: number;
    totalAgents: number;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
}

/**
 * Subscription state for filter building
 */
export interface SubscriptionState {
    whitelistedPubkeys: Set<Hexpubkey>;
    knownProjects: Set<ProjectId>;
    agentPubkeys: Set<Hexpubkey>;
    agentDefinitionIds: Set<string>;
    lastUpdate: Date;
    restartPending: boolean;
}

/**
 * Agent index entry for routing
 */
export interface AgentIndexEntry {
    pubkey: Hexpubkey;
    projectId: ProjectId;
    name: string;
    slug: string;
}

/**
 * Event processing error types
 */
export enum EventProcessingError {
    UnknownProject = "UNKNOWN_PROJECT",
    NoRoutingMatch = "NO_ROUTING_MATCH",
    RuntimeCrash = "RUNTIME_CRASH",
    RuntimeStartupFailed = "RUNTIME_STARTUP_FAILED",
    InvalidEvent = "INVALID_EVENT",
}

/**
 * Lifecycle event types for telemetry
 */
export enum LifecycleEvent {
    DaemonStart = "daemon.start",
    DaemonStop = "daemon.stop",
    RuntimeStart = "runtime.start",
    RuntimeStop = "runtime.stop",
    RuntimeCrash = "runtime.crash",
    SubscriptionRestart = "subscription.restart",
}

/**
 * Type guard to check if a routing decision routes to a project
 */
export function isRoutedToProject(
    decision: RoutingDecision
): decision is Extract<RoutingDecision, { type: "route_to_project" }> {
    return decision.type === "route_to_project";
}

/**
 * Type guard to check if a routing decision is dropped
 */
export function isDropped(
    decision: RoutingDecision
): decision is Extract<RoutingDecision, { type: "dropped" }> {
    return decision.type === "dropped";
}

/**
 * Type guard to check if a routing decision is lesson hydration
 */
export function isLessonHydration(
    decision: RoutingDecision
): decision is Extract<RoutingDecision, { type: "lesson_hydration" }> {
    return decision.type === "lesson_hydration";
}

/**
 * Type guard to check if a routing decision is a project event
 */
export function isProjectEvent(
    decision: RoutingDecision
): decision is Extract<RoutingDecision, { type: "project_event" }> {
    return decision.type === "project_event";
}