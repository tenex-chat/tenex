import { describe, it, beforeEach, afterEach } from "bun:test";
import { 
    setupE2ETest, 
    cleanupE2ETest, 
    createConversation, 
    executeConversationFlow,
    type E2ETestContext 
} from "./test-harness";
import { conversationalLogger } from "@/test-utils/conversational-logger";

describe("Conversational Logger Demo", () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        // Reset the logger for each test
        conversationalLogger.reset();
        
        // Setup test environment with routing decisions scenario
        context = await setupE2ETest(["routing-decisions"], {
            content: JSON.stringify({
                agents: ["executor"],
                phase: "execute", 
                reason: "Default routing"
            })
        });
    });

    afterEach(async () => {
        await cleanupE2ETest(context);
    });

    it("should show conversational dialog for basic agent interaction", async () => {
        conversationalLogger.logTestStart("Basic Agent Interaction Demo");
        
        // Create a conversation
        const conversationId = await createConversation(
            context,
            "Implement authentication system",
            "Create a basic authentication system with login and registration endpoints"
        );

        // Execute the conversation flow (orchestrator will route to executor)
        await executeConversationFlow(
            context,
            conversationId,
            "Create a basic authentication system with login and registration endpoints",
            {
                maxIterations: 2,
                onAgentExecution: (agent, phase) => {
                    console.log(`Executing ${agent} in ${phase} phase`);
                }
            }
        );

        conversationalLogger.logTestEnd(true, "Basic Agent Interaction Demo");
    });

    it("should show phase transitions and tool usage", async () => {
        conversationalLogger.logTestStart("Phase Transitions and Tool Usage Demo");
        
        // Create conversation
        const conversationId = await createConversation(
            context,
            "Test error recovery",
            "Test error recovery mechanisms in the agent system"
        );

        // Execute the conversation flow (orchestrator will route to planner)
        await executeConversationFlow(
            context,
            conversationId,
            "Test error recovery mechanisms in the agent system",
            {
                maxIterations: 3,
                onAgentExecution: (agent, phase) => {
                    console.log(`Executing ${agent} in ${phase} phase`);
                },
                onPhaseTransition: (from, to) => {
                    console.log(`Phase transition: ${from} -> ${to}`);
                }
            }
        );

        conversationalLogger.logTestEnd(true, "Phase Transitions and Tool Usage Demo");
    });
});
