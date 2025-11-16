import { describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ProjectContext } from "@/services/ProjectContext";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentRouter } from "../AgentRouter";

// Mock the logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock AgentEventDecoder
const getMentionedPubkeysMock = mock(() => ["global-agent-pubkey"]);
const isEventFromAgentMock = mock(() => false);

mock.module("@/nostr/AgentEventDecoder", () => ({
    AgentEventDecoder: {
        getMentionedPubkeys: getMentionedPubkeysMock,
        isEventFromAgent: isEventFromAgentMock,
    },
}));

describe("AgentRouter - Project Context Validation", () => {
    it("should route events to global agents when project context matches", () => {
        // Create a mock global agent
        const globalAgent: Partial<AgentInstance> = {
            name: "GlobalAgent",
            pubkey: "global-agent-pubkey",
            isGlobal: true,
            slug: "global-agent",
        };

        // Create a mock project context with the agent
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["global-agent", globalAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-123" : undefined),
            } as any,
        };

        // Create an event with matching project context
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "global-agent-pubkey"],
                ["a", "31933:some-pubkey:project-123"], // Matching project
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0]).toBe(globalAgent);
    });

    it("should NOT route events to global agents when project context does not match", () => {
        // Create a mock global agent
        const globalAgent: Partial<AgentInstance> = {
            name: "GlobalAgent",
            pubkey: "global-agent-pubkey",
            isGlobal: true,
            slug: "global-agent",
        };

        // Create a mock project context with the agent
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["global-agent", globalAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-123" : undefined),
            } as any,
        };

        // Create an event with DIFFERENT project context
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "global-agent-pubkey"],
                ["a", "31933:some-pubkey:project-456"], // Different project!
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(0);
    });

    it("should route events to non-global agents regardless of project context", () => {
        // Create a mock non-global agent
        const localAgent: Partial<AgentInstance> = {
            name: "LocalAgent",
            pubkey: "local-agent-pubkey",
            isGlobal: false, // Not a global agent
            slug: "local-agent",
        };

        // Update mock to return the local agent pubkey
        getMentionedPubkeysMock.mockImplementationOnce(() => ["local-agent-pubkey"]);

        // Create a mock project context with the agent
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["local-agent", localAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "local-agent-pubkey") return localAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-123" : undefined),
            } as any,
        };

        // Create an event with different project context
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "local-agent-pubkey"],
                ["a", "31933:some-pubkey:project-456"], // Different project - doesn't matter for local agents
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0]).toBe(localAgent);
    });

    it("should allow routing to global agents when event has no project reference (backward compatibility)", () => {
        // Create a mock global agent
        const globalAgent: Partial<AgentInstance> = {
            name: "GlobalAgent",
            pubkey: "global-agent-pubkey",
            isGlobal: true,
            slug: "global-agent",
        };

        // Update mock to return the global agent pubkey
        getMentionedPubkeysMock.mockImplementationOnce(() => ["global-agent-pubkey"]);

        // Create a mock project context with the agent
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["global-agent", globalAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-123" : undefined),
            } as any,
        };

        // Create an event WITHOUT a project reference
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "global-agent-pubkey"],
                // No "a" tag
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0]).toBe(globalAgent);
    });

    it("should allow routing to global agents when current project has no identifier", () => {
        // Create a mock global agent
        const globalAgent: Partial<AgentInstance> = {
            name: "GlobalAgent",
            pubkey: "global-agent-pubkey",
            isGlobal: true,
            slug: "global-agent",
        };

        // Update mock to return the global agent pubkey
        getMentionedPubkeysMock.mockImplementationOnce(() => ["global-agent-pubkey"]);

        // Create a mock project context with NO project identifier
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["global-agent", globalAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => undefined, // No "d" tag - no project identifier
            } as any,
        };

        // Create an event WITH a project reference
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "global-agent-pubkey"],
                ["a", "31933:some-pubkey:project-456"], // Has project reference but current project has no identifier
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0]).toBe(globalAgent);
    });

    it("should allow routing when a tag is not a NIP-31933 project reference", () => {
        // Create a mock global agent
        const globalAgent: Partial<AgentInstance> = {
            name: "GlobalAgent",
            pubkey: "global-agent-pubkey",
            isGlobal: true,
            slug: "global-agent",
        };

        // Update mock to return the global agent pubkey
        getMentionedPubkeysMock.mockImplementationOnce(() => ["global-agent-pubkey"]);

        // Create a mock project context with the agent
        const projectContext: Partial<ProjectContext> = {
            agents: new Map([["global-agent", globalAgent as AgentInstance]]),
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === "global-agent-pubkey") return globalAgent as AgentInstance;
                return undefined;
            },
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-123" : undefined),
            } as any,
        };

        // Create an event with a non-project "a" tag (e.g., article reference)
        const event: Partial<NDKEvent> = {
            tags: [
                ["p", "global-agent-pubkey"],
                ["a", "30023:some-pubkey:article-id"], // Article, not a project
            ],
            pubkey: "user-pubkey",
        };

        const targetAgents = AgentRouter.resolveTargetAgents(
            event as NDKEvent,
            projectContext as ProjectContext
        );

        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0]).toBe(globalAgent);
    });
});
