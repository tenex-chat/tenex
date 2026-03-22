import type { Hexpubkey } from "@nostr-dev-kit/ndk";
import type { ProjectDTag } from "@/types/project-ids";

/**
 * Event classification for daemon routing decisions
 */
export type EventClassification =
    | "never_route" // Events that should never be routed (status, streaming, etc.)
    | "project" // Project creation/update events (kind 31933)
    | "lesson" // Agent lesson events (kind 4129)
    | "conversation" // Reply and thread events

/**
 * Routing decision for an event
 * This is a discriminated union for type-safe routing handling
 */
export type RoutingDecision =
    | {
          type: "route_to_project";
          projectId: ProjectDTag;
          method: "a_tag" | "p_tag_agent";
          matchedTags: string[];
      }
    | {
          type: "dropped";
          reason: string;
      }
    | {
          type: "lesson_hydration";
          targetProjects: ProjectDTag[];
          agentDefinitionId: string;
      }
    | {
          type: "project_event";
          projectId: ProjectDTag;
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
    /** Known project d-tags mapped to their NDKProject instances */
    knownProjects: Map<ProjectDTag, unknown>; // Using unknown to avoid circular deps
    /** Map of agent pubkeys to their project d-tags */
    agentPubkeyToProjects: Map<Hexpubkey, Set<ProjectDTag>>;
    /** Whitelisted user pubkeys */
    whitelistedPubkeys: Hexpubkey[];
    /** Currently active runtime project d-tags */
    activeProjectIds: Set<ProjectDTag>;
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
    projectId: ProjectDTag;
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
    knownProjects: Set<ProjectDTag>;
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
    projectId: ProjectDTag;
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
