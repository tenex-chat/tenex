import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { NDKEvent, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "../AgentPublisher";
import { getNDK } from "../ndkClient";

// Mock the NDK client
mock.module("../ndkClient", () => ({
  getNDK: mock(() => ({
    // Mock NDK instance
  })),
}));

// Mock logger
mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

describe("AgentPublisher - Agent Metadata in Kind:0", () => {
  let mockPublish: any;
  let mockSign: any;
  let capturedEvent: NDKEvent | null = null;

  beforeEach(() => {
    capturedEvent = null;

    // Mock NDKEvent to capture the created event
    mockPublish = mock();
    mockSign = mock();
    
    spyOn(NDKEvent.prototype, "publish").mockImplementation(function(this: NDKEvent) {
      capturedEvent = this;
      return mockPublish();
    });
    
    spyOn(NDKEvent.prototype, "sign").mockImplementation(mockSign);
  });

  describe("publishAgentProfile", () => {
    it("should include metadata tags for agents without NDKAgentDefinition event ID", async () => {
      const signer = NDKPrivateKeySigner.generate();
      const projectEvent = new NDKProject(getNDK());
      projectEvent.tagValue = mock(() => "Test Project");
      projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

      const agentMetadata = {
        description: "A test agent that does testing",
        instructions: "Follow these test instructions carefully",
        useCriteria: "Use when testing is needed",
        phases: {
          "planning": "Plan the tests carefully",
          "execution": "Execute tests with precision"
        }
      };

      await AgentPublisher.publishAgentProfile(
        signer,
        "TestAgent",
        "Tester",
        "Test Project",
        projectEvent,
        undefined, // No NDKAgentDefinition event ID
        agentMetadata
      );

      expect(mockSign).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
      expect(capturedEvent).toBeDefined();

      if (capturedEvent) {
        // Verify kind:0 event
        expect(capturedEvent.kind).toBe(0);
        
        // Verify metadata tags are included
        const tags = capturedEvent.tags;
        
        // Check description tag
        const descriptionTag = tags.find(tag => tag[0] === "description");
        expect(descriptionTag).toBeDefined();
        expect(descriptionTag?.[1]).toBe("A test agent that does testing");
        
        // Check instructions tag
        const instructionsTag = tags.find(tag => tag[0] === "instructions");
        expect(instructionsTag).toBeDefined();
        expect(instructionsTag?.[1]).toBe("Follow these test instructions carefully");
        
        // Check use-criteria tag
        const useCriteriaTag = tags.find(tag => tag[0] === "use-criteria");
        expect(useCriteriaTag).toBeDefined();
        expect(useCriteriaTag?.[1]).toBe("Use when testing is needed");
        
        // Check phase tags
        const phaseTags = tags.filter(tag => tag[0] === "phase" && tag.length === 3);
        expect(phaseTags.length).toBe(2);
        
        const planningPhase = phaseTags.find(tag => tag[1] === "planning");
        expect(planningPhase).toBeDefined();
        expect(planningPhase?.[2]).toBe("Plan the tests carefully");
        
        const executionPhase = phaseTags.find(tag => tag[1] === "execution");
        expect(executionPhase).toBeDefined();
        expect(executionPhase?.[2]).toBe("Execute tests with precision");
      }
    });

    it("should NOT include metadata tags for agents WITH NDKAgentDefinition event ID", async () => {
      const signer = NDKPrivateKeySigner.generate();
      const projectEvent = new NDKProject(getNDK());
      projectEvent.tagValue = mock(() => "Test Project");
      projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

      const agentMetadata = {
        description: "A test agent that does testing",
        instructions: "Follow these test instructions carefully",
        useCriteria: "Use when testing is needed",
        phases: {
          "planning": "Plan the tests carefully",
          "execution": "Execute tests with precision"
        }
      };

      const ndkAgentEventId = "a".repeat(64); // Valid hex event ID

      await AgentPublisher.publishAgentProfile(
        signer,
        "TestAgent",
        "Tester",
        "Test Project",
        projectEvent,
        ndkAgentEventId, // Has NDKAgentDefinition event ID
        agentMetadata
      );

      expect(mockSign).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
      expect(capturedEvent).toBeDefined();

      if (capturedEvent) {
        // Verify kind:0 event
        expect(capturedEvent.kind).toBe(0);
        
        // Verify metadata tags are NOT included
        const tags = capturedEvent.tags;
        
        // Should have e-tag for the NDKAgentDefinition
        const eTag = tags.find(tag => tag[0] === "e");
        expect(eTag).toBeDefined();
        expect(eTag?.[1]).toBe(ndkAgentEventId);
        
        // Should NOT have metadata tags
        const descriptionTag = tags.find(tag => tag[0] === "description");
        expect(descriptionTag).toBeUndefined();
        
        const instructionsTag = tags.find(tag => tag[0] === "instructions");
        expect(instructionsTag).toBeUndefined();
        
        const useCriteriaTag = tags.find(tag => tag[0] === "use-criteria");
        expect(useCriteriaTag).toBeUndefined();
        
        const phaseTags = tags.filter(tag => tag[0] === "phase" && tag.length === 3);
        expect(phaseTags.length).toBe(0);
      }
    });

    it("should handle partial metadata gracefully", async () => {
      const signer = NDKPrivateKeySigner.generate();
      const projectEvent = new NDKProject(getNDK());
      projectEvent.tagValue = mock(() => "Test Project");
      projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

      const agentMetadata = {
        description: "A test agent that does testing",
        // No instructions, useCriteria, or phases
      };

      await AgentPublisher.publishAgentProfile(
        signer,
        "TestAgent",
        "Tester",
        "Test Project",
        projectEvent,
        undefined, // No NDKAgentDefinition event ID
        agentMetadata
      );

      expect(mockSign).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
      expect(capturedEvent).toBeDefined();

      if (capturedEvent) {
        const tags = capturedEvent.tags;
        
        // Check only description tag is included
        const descriptionTag = tags.find(tag => tag[0] === "description");
        expect(descriptionTag).toBeDefined();
        expect(descriptionTag?.[1]).toBe("A test agent that does testing");
        
        // Other tags should not be present
        const instructionsTag = tags.find(tag => tag[0] === "instructions");
        expect(instructionsTag).toBeUndefined();
        
        const useCriteriaTag = tags.find(tag => tag[0] === "use-criteria");
        expect(useCriteriaTag).toBeUndefined();
        
        const phaseTags = tags.filter(tag => tag[0] === "phase" && tag.length === 3);
        expect(phaseTags.length).toBe(0);
      }
    });
  });

  describe("publishAgentCreation", () => {
    it("should pass metadata to publishAgentProfile for agents without eventId", async () => {
      const signer = NDKPrivateKeySigner.generate();
      const projectEvent = new NDKProject(getNDK());
      projectEvent.tagValue = mock(() => "Test Project");
      projectEvent.tagReference = mock(() => ["a", "31933:pubkey:d-tag"]);

      const agentConfig = {
        name: "TestAgent",
        role: "Tester",
        description: "A comprehensive test agent",
        instructions: "Test everything thoroughly",
        useCriteria: "Use for all testing needs",
        phases: {
          "setup": "Set up test environment",
          "testing": "Run all tests",
          "cleanup": "Clean up after tests"
        }
      };

      // Mock publishAgentRequest to prevent errors
      const mockPublishRequest = spyOn(AgentPublisher, "publishAgentRequest").mockResolvedValue(new NDKEvent(getNDK()));

      await AgentPublisher.publishAgentCreation(
        signer,
        agentConfig,
        "Test Project",
        projectEvent,
        undefined // No eventId
      );

      expect(mockSign).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
      expect(capturedEvent).toBeDefined();

      if (capturedEvent) {
        const tags = capturedEvent.tags;
        
        // Verify all metadata tags are present
        expect(tags.find(tag => tag[0] === "description")?.[1]).toBe("A comprehensive test agent");
        expect(tags.find(tag => tag[0] === "instructions")?.[1]).toBe("Test everything thoroughly");
        expect(tags.find(tag => tag[0] === "use-criteria")?.[1]).toBe("Use for all testing needs");
        
        const phaseTags = tags.filter(tag => tag[0] === "phase" && tag.length === 3);
        expect(phaseTags.length).toBe(3);
      }

      // Cleanup is automatic in Bun
    });
  });
});