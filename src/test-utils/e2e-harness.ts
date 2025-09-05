/**
 * E2E Test Harness - Main export file
 * 
 * This file re-exports all the E2E testing utilities from their respective modules
 * to maintain backward compatibility while keeping the code organized.
 */

// Export types
export type {
    E2ETestContext,
    ExecutionTrace,
    AgentExecutionRecord,
    PhaseTransitionRecord,
    ToolCallRecord,
    ToolCall,
    AgentExecutionResult,
    RoutingDecision
} from "./e2e-types";

// Export setup and teardown functions
export { 
    setupE2ETest, 
    cleanupE2ETest 
} from "./e2e-setup";

// Export execution functions
export {
    executeConversationFlow,
    createConversation,
    getConversationState,
    waitForPhase,
    getToolCallsFromHistory
} from "./e2e-execution";

// Export assertion helpers
export {
    assertAgentSequence,
    assertPhaseTransitions,
    assertToolCalls,
    assertFeedbackPropagated
} from "./e2e-assertions";

// Export mock utilities
export { 
    createE2EMockEvent,
    createTestAgents 
} from "./e2e-mocks";

// Re-export createMockNDKEvent for backward compatibility
export { createMockNDKEvent } from "@/test-utils/mock-factories";