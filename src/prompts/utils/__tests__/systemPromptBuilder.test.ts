import { describe, expect, it } from "bun:test";
import { buildSystemPromptMessages } from "../systemPromptBuilder";
import type { AgentInstance } from "@/agents/types";
import { PHASES } from "@/conversations/phases";
// Import all required fragments
import "@/prompts/fragments/30-project-inventory";
import "@/prompts/fragments/30-project-md";
import "@/prompts/fragments/20-phase-constraints";
import "@/prompts/fragments/24-retrieved-lessons";
import "@/prompts/fragments/01-specialist-identity";
import "@/prompts/fragments/25-specialist-tools";
import "@/prompts/fragments/85-specialist-reasoning";

describe("systemPromptBuilder", () => {
    const baseAgent: AgentInstance = {
        id: "test-agent",
        slug: "test-agent",
        pubkey: "test-pubkey",
        name: "Test Agent",
        role: "Test Role",
        tools: [],
        instructions: "You are a test agent. Help users with their tasks.",
        backend: "reason-act-loop" as const,
    };

    const mockProject = {
        pubkey: "project-pubkey",
        title: "Test Project",
        tags: [],
    };

    it("should NOT include phase-specific completion guidance in base prompt", () => {
        const messages = buildSystemPromptMessages({
            agent: { ...baseAgent, isOrchestrator: false },
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });
        const systemPrompt = messages.map(m => m.message.content).join("\n\n");

        // Completion guidance is now injected dynamically with phase transitions
        // so it should NOT be in the base system prompt
        expect(systemPrompt).not.toContain("When to use complete() tool");
        expect(systemPrompt).not.toContain("When NOT to use complete()");
    });

    it("should NOT include yield-back fragment for orchestrator agents", () => {
        const messages = buildSystemPromptMessages({
            agent: { ...baseAgent, isOrchestrator: true },
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });
        const systemPrompt = messages.map(m => m.message.content).join("\n\n");

        // Orchestrator should not have the yield-back fragment section
        expect(systemPrompt).not.toContain("When to use complete() tool");
        expect(systemPrompt).not.toContain("When NOT to use complete()");
    });

    it("should include agent instructions but not phase-specific guidance", () => {
        const customAgent: AgentInstance = {
            ...baseAgent,
            name: "Custom Agent",
            role: "Custom Role",
            isOrchestrator: false,
        };

        const messages = buildSystemPromptMessages({
            agent: customAgent,
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });
        const systemPrompt = messages.map(m => m.message.content).join("\n\n");

        // Completion guidance is now injected dynamically with phase transitions
        // so it should NOT be in the base system prompt
        expect(systemPrompt).not.toContain("When to use complete() tool");
        expect(systemPrompt).not.toContain("When NOT to use complete()");
    });
});

describe("buildSystemPromptMessages", () => {
    const baseAgent: AgentInstance = {
        id: "test-agent",
        slug: "test-agent",
        pubkey: "test-pubkey",
        name: "Test Agent",
        role: "Test Role",
        tools: [],
        instructions: "You are a test agent. Help users with their tasks.",
        backend: "reason-act-loop" as const,
    };

    const mockProject = {
        id: "project-id",
        pubkey: "project-pubkey",
        title: "Test Project",
        tags: [],
    };

    it("should return an array of system messages", () => {
        const messages = buildSystemPromptMessages({
            agent: { ...baseAgent, isOrchestrator: false },
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });

        expect(Array.isArray(messages)).toBe(true);
        expect(messages.length).toBeGreaterThan(0);
        expect(messages[0].message.role).toBe("system");
    });

    it("should include separate cacheable messages for project-manager", () => {
        const projectManagerAgent = {
            ...baseAgent,
            slug: "project-manager",
            isOrchestrator: false,
        };

        const messages = buildSystemPromptMessages({
            agent: projectManagerAgent,
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });

        // Should have multiple messages
        expect(messages.length).toBeGreaterThanOrEqual(2);
        
        // Check for cacheable messages
        const cacheableMessages = messages.filter(m => m.metadata?.cacheable);
        expect(cacheableMessages.length).toBeGreaterThan(0);
        
        // Check for PROJECT.md and inventory messages
        const projectMdMessage = messages.find(m => m.metadata?.description === "PROJECT.md content");
        const inventoryMessage = messages.find(m => m.metadata?.description === "Project inventory");
        
        expect(projectMdMessage).toBeDefined();
        expect(inventoryMessage).toBeDefined();
        
        if (projectMdMessage) {
            expect(projectMdMessage.metadata?.cacheable).toBe(true);
            expect(projectMdMessage.metadata?.cacheKey).toContain("project-md");
        }
        
        if (inventoryMessage) {
            expect(inventoryMessage.metadata?.cacheable).toBe(true);
            expect(inventoryMessage.metadata?.cacheKey).toContain("project-inventory");
        }
    });

    it("should not include PROJECT.md for non-project-manager agents", () => {
        const regularAgent = {
            ...baseAgent,
            slug: "executor",
            isOrchestrator: false,
        };

        const messages = buildSystemPromptMessages({
            agent: regularAgent,
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });

        const projectMdMessage = messages.find(m => m.metadata?.description === "PROJECT.md content");
        expect(projectMdMessage).toBeUndefined();
        
        // But should still have inventory
        const inventoryMessage = messages.find(m => m.metadata?.description === "Project inventory");
        expect(inventoryMessage).toBeDefined();
    });

    it("should not include inventory or PROJECT.md for orchestrator", () => {
        const orchestratorAgent = {
            ...baseAgent,
            isOrchestrator: true,
        };

        const messages = buildSystemPromptMessages({
            agent: orchestratorAgent,
            phase: PHASES.EXECUTE,
            project: mockProject as any,
        });

        const projectMdMessage = messages.find(m => m.metadata?.description === "PROJECT.md content");
        const inventoryMessage = messages.find(m => m.metadata?.description === "Project inventory");
        
        expect(projectMdMessage).toBeUndefined();
        expect(inventoryMessage).toBeUndefined();
    });

});
