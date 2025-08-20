import { beforeEach, describe, expect, it } from "bun:test";
import type { Phase } from "@/conversations/phases";
import type { Conversation, PhaseTransition } from "@/conversations/types";
import { phaseContextFragment } from "../10-agent-execution";

describe("phaseContextFragment", () => {
  let mockConversation: Conversation;

  beforeEach(() => {
    mockConversation = {
      id: "test-conv",
      title: "Test Conversation",
      phase: "chat",
      history: [],
      phaseStartedAt: Date.now(),
      metadata: {},
      phaseTransitions: [],
    };
  });

  describe("getPhaseContext integration", () => {
    it("should retrieve context from phase transitions", () => {
      const transition: PhaseTransition = {
        from: "chat" as Phase,
        to: "plan" as Phase,
        message: `## User Requirements
- Build a CLI tool with multiple commands
- Support configuration files
- Include comprehensive documentation

## Technical Constraints
- Must use TypeScript
- Node.js 18+ required
- No external API dependencies`,
        timestamp: Date.now() - 1000,
        agentPubkey: "pm-agent-pubkey",
        agentName: "PM Agent",
        reason: "requirements gathered",
      };

      mockConversation.phaseTransitions = [transition];
      mockConversation.phase = "plan";

      const result = phaseContextFragment.template({
        phase: "plan" as Phase,
        conversation: mockConversation,
      });

      expect(result).toContain("## Current Phase: PLAN");
      expect(result).toContain("### Context from Previous Phase");
      expect(result).toContain("## User Requirements");
      expect(result).toContain("Build a CLI tool with multiple commands");
      expect(result).toContain("## Technical Constraints");
      expect(result).toContain("Must use TypeScript");
    });

    it("should use most recent transition when multiple exist", () => {
      const olderTransition: PhaseTransition = {
        from: "chat" as Phase,
        to: "plan" as Phase,
        message: "Old requirements",
        timestamp: Date.now() - 10000,
        agentPubkey: "agent-1",
        agentName: "Agent 1",
      };

      const newerTransition: PhaseTransition = {
        from: "chat" as Phase,
        to: "plan" as Phase,
        message: "Updated requirements with more details",
        timestamp: Date.now() - 1000,
        agentPubkey: "agent-2",
        agentName: "Agent 2",
      };

      mockConversation.phaseTransitions = [olderTransition, newerTransition];
      mockConversation.phase = "plan";

      const result = phaseContextFragment.template({
        phase: "plan" as Phase,
        conversation: mockConversation,
      });

      expect(result).toContain("Updated requirements with more details");
      expect(result).not.toContain("Old requirements");
    });

    it("should handle no matching transitions", () => {
      // Transition to a different phase
      const transition: PhaseTransition = {
        from: "chat" as Phase,
        to: "execute" as Phase,
        message: "Skipping plan phase",
        timestamp: Date.now() - 1000,
        agentPubkey: "agent-1",
        agentName: "Agent 1",
      };

      mockConversation.phaseTransitions = [transition];
      mockConversation.phase = "plan"; // Looking for plan, but only have execute

      const result = phaseContextFragment.template({
        phase: "plan" as Phase,
        conversation: mockConversation,
      });

      expect(result).toBe("## Current Phase: PLAN");
      expect(result).not.toContain("### Context from Previous Phase");
    });

    it("should handle empty phase transitions array", () => {
      mockConversation.phaseTransitions = [];

      const result = phaseContextFragment.template({
        phase: "plan" as Phase,
        conversation: mockConversation,
      });

      expect(result).toBe("## Current Phase: PLAN");
      expect(result).not.toContain("### Context from Previous Phase");
    });

    it("should handle missing conversation", () => {
      const result = phaseContextFragment.template({
        phase: "plan" as Phase,
        conversation: undefined,
      });

      expect(result).toBe("## Current Phase: PLAN");
      expect(result).not.toContain("### Context from Previous Phase");
    });

    it("should preserve complex markdown in transition messages", () => {
      const complexMessage = `# Implementation Plan

## Architecture Overview
\`\`\`typescript
interface AppConfig {
    version: string;
    features: Feature[];
}
\`\`\`

## Steps
1. **Setup Project**
   - Initialize TypeScript
   - Configure build tools
2. **Core Implementation**
   - Create base classes
   - Implement interfaces

## Notes
- Use async/await for all I/O operations
- Follow SOLID principles
- Include unit tests for each module`;

      const transition: PhaseTransition = {
        from: "plan" as Phase,
        to: "execute" as Phase,
        message: complexMessage,
        timestamp: Date.now(),
        agentPubkey: "pm-agent",
        agentName: "PM Agent",
      };

      mockConversation.phaseTransitions = [transition];
      mockConversation.phase = "execute";

      const result = phaseContextFragment.template({
        phase: "execute" as Phase,
        conversation: mockConversation,
      });

      expect(result).toContain("## Current Phase: EXECUTE");
      expect(result).toContain("### Context from Previous Phase");
      expect(result).toContain(complexMessage);
    });
  });

  describe("validateArgs", () => {
    it("should validate correct args", () => {
      const validArgs = {
        phase: "plan",
        conversation: mockConversation,
      };

      expect(phaseContextFragment.validateArgs?.(validArgs)).toBe(true);
    });

    it("should reject invalid args", () => {
      expect(phaseContextFragment.validateArgs?.(null)).toBe(false);
      expect(phaseContextFragment.validateArgs?.({})).toBe(false);
      expect(phaseContextFragment.validateArgs?.({ phase: 123 })).toBe(false);
    });
  });
});
