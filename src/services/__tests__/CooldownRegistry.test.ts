/**
 * Tests for CooldownRegistry
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CooldownRegistry } from "../CooldownRegistry";

describe("CooldownRegistry", () => {
    let registry: CooldownRegistry;

    beforeEach(() => {
        registry = CooldownRegistry.getInstance();
        registry.clearAll();
    });

    afterEach(() => {
        registry.clearAll();
    });

    test("should add and check cooldown entries", () => {
        const projectId = "test-project-789";
        const conversationId = "test-conversation-123";
        const agentPubkey = "test-agent-pubkey-456";

        // Initially not in cooldown
        expect(registry.isInCooldown(projectId, conversationId, agentPubkey)).toBe(false);

        // Add to cooldown
        registry.add(projectId, conversationId, agentPubkey, "test abort");

        // Now should be in cooldown
        expect(registry.isInCooldown(projectId, conversationId, agentPubkey)).toBe(true);
    });

    test("should expire cooldown entries after timeout", () => {
        const projectId = "test-project-789";
        const conversationId = "test-conversation-123";
        const agentPubkey = "test-agent-pubkey-456";

        // Add to cooldown
        const originalDateNow = Date.now;
        const startTime = Date.now();
        Date.now = () => startTime;

        registry.add(projectId, conversationId, agentPubkey, "test abort");

        // Should be in cooldown immediately after adding
        expect(registry.isInCooldown(projectId, conversationId, agentPubkey)).toBe(true);

        // Mock time advancing by 16 seconds (exceeds 15s cooldown)
        Date.now = () => startTime + 16000;

        // Should now be expired when checked again
        expect(registry.isInCooldown(projectId, conversationId, agentPubkey)).toBe(false);

        // Restore original Date.now
        Date.now = originalDateNow;
    });

    test("should track multiple cooldown entries independently", () => {
        const project1 = "project-1";
        const project2 = "project-2";
        const conv1 = "conversation-1";
        const conv2 = "conversation-2";
        const agent1 = "agent-1";
        const agent2 = "agent-2";

        // Add different combinations
        registry.add(project1, conv1, agent1, "abort 1");
        registry.add(project2, conv2, agent2, "abort 2");

        // Each tuple should be in cooldown
        expect(registry.isInCooldown(project1, conv1, agent1)).toBe(true);
        expect(registry.isInCooldown(project2, conv2, agent2)).toBe(true);

        // Different combinations should not be in cooldown
        expect(registry.isInCooldown(project1, conv1, agent2)).toBe(false);
        expect(registry.isInCooldown(project2, conv2, agent1)).toBe(false);

        // CRITICAL: Same conversation+agent in different projects should NOT interfere
        expect(registry.isInCooldown(project2, conv1, agent1)).toBe(false);
        expect(registry.isInCooldown(project1, conv2, agent2)).toBe(false);
    });

    test("should get active cooldowns", () => {
        const project1 = "project-1";
        const project2 = "project-2";
        const conv1 = "conversation-1";
        const conv2 = "conversation-2";
        const agent1 = "agent-1";
        const agent2 = "agent-2";

        // Add multiple cooldowns
        registry.add(project1, conv1, agent1, "abort 1");
        registry.add(project2, conv2, agent2, "abort 2");

        const active = registry.getActiveCooldowns();

        expect(active.length).toBe(2);
        expect(active.some(e => e.projectId === project1 && e.conversationId === conv1 && e.agentPubkey === agent1)).toBe(true);
        expect(active.some(e => e.projectId === project2 && e.conversationId === conv2 && e.agentPubkey === agent2)).toBe(true);
    });

    test("should clear all cooldown entries", () => {
        const project1 = "project-1";
        const conv1 = "conversation-1";
        const agent1 = "agent-1";

        registry.add(project1, conv1, agent1, "abort 1");
        expect(registry.isInCooldown(project1, conv1, agent1)).toBe(true);

        registry.clearAll();
        expect(registry.isInCooldown(project1, conv1, agent1)).toBe(false);
        expect(registry.getActiveCooldowns().length).toBe(0);
    });
});
