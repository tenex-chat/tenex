import type { MockLLMScenario } from "../types";

/**
 * Inventory generation workflow scenario
 * Tests the complete flow of generating project inventory including:
 * - Initial request in CHAT phase
 * - Transitioning to EXECUTE phase
 * - Using generate_inventory tool
 * - Handling task progress updates
 * - Completing the workflow
 */
export const inventoryGenerationScenario: MockLLMScenario = {
    name: "inventory-generation",
    description: "Complete workflow for generating project inventory",
    responses: [
        // Initial chat phase - user asks to generate inventory
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "chat",
                userMessage: /generate.*inventory|analyze.*codebase|understand.*project/i
            },
            response: {
                content: "I'll analyze your codebase and generate a comprehensive inventory to help understand the project structure.",
                toolCalls: [{
                    id: "1",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "User wants to generate project inventory",
                        suggestedPhase: "execute",
                        confidence: 95,
                        reasoning: "This is a straightforward task that can be executed immediately"
                    })
                }]
            },
            priority: 10
        },

        // EXECUTE phase - Executor generates inventory
        {
            trigger: {
                agentName: "Executor", 
                phase: "execute",
                systemPrompt: /inventory|analyze.*codebase/i
            },
            response: {
                content: "I'll now generate a comprehensive inventory of your project using our inventory analysis tool.",
                toolCalls: [{
                    id: "2",
                    function: "generate_inventory",
                    args: JSON.stringify({})
                }]
            },
            priority: 10
        },

        // Handle inventory generation completion
        {
            trigger: {
                agentName: "Executor",
                phase: "execute",
                previousToolCalls: ["generate_inventory"]
            },
            response: {
                content: `Great! I've successfully generated a comprehensive inventory of your project. Here's what was created:

📋 **Main Inventory**: Saved to \`context/INVENTORY.md\`
- Complete project structure analysis
- Key architectural patterns identified
- Dependencies and their relationships mapped
- Critical code paths documented

📚 **Complex Module Guides**: Individual guides created for complex modules
- Detailed documentation for intricate components
- Usage examples and best practices
- Integration points highlighted

The inventory provides a thorough understanding of your codebase architecture, making it easier to navigate and work with the project.`,
                toolCalls: [{
                    id: "3",
                    function: "complete",
                    args: JSON.stringify({
                        phaseComplete: true,
                        readyForNext: true,
                        suggestedNextPhase: "verification",
                        summary: "Project inventory generated successfully"
                    })
                }]
            },
            priority: 9
        },

        // Orchestrator handles completion
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "execute",
                previousToolCalls: ["complete"]
            },
            response: {
                toolCalls: [{
                    id: "4",
                    function: "continue",
                    args: JSON.stringify({
                        summary: "Inventory generation completed successfully",
                        suggestedPhase: "verification",
                        confidence: 100,
                        reasoning: "Task completed, moving to verification"
                    })
                }]
            },
            priority: 9
        },

        // VERIFICATION phase - confirm inventory was created
        {
            trigger: {
                agentName: "Executor",
                phase: "verification",
                systemPrompt: /inventory.*generated/i
            },
            response: {
                content: `Let me verify the inventory generation was successful.`,
                toolCalls: [{
                    id: "5",
                    function: "readPath",
                    args: JSON.stringify({
                        path: "context/INVENTORY.md"
                    })
                }]
            },
            priority: 10
        },

        // Verification complete
        {
            trigger: {
                agentName: "Executor",
                phase: "verification",
                previousToolCalls: ["readPath"]
            },
            response: {
                content: `✅ Verification complete! The inventory has been successfully generated and contains:

- Project overview and structure
- Architectural patterns and conventions
- Key components and their relationships
- Dependencies analysis
- Development guidelines

The inventory is ready to use for understanding and navigating your codebase.`,
                toolCalls: [{
                    id: "6",
                    function: "complete",
                    args: JSON.stringify({
                        phaseComplete: true,
                        readyForNext: false,
                        summary: "Inventory generation verified - task completed successfully"
                    })
                }]
            },
            priority: 9
        },

        // Alternative flow: Inventory already exists
        {
            trigger: {
                agentName: "Executor",
                phase: "execute",
                messageContains: /inventory.*regenerated/i
            },
            response: {
                content: `I've successfully regenerated your project inventory. The existing inventory has been updated with:

📋 **Updated Main Inventory**: \`context/INVENTORY.md\` 
- Refreshed with latest code changes
- New components and patterns identified
- Updated dependency analysis

The regenerated inventory reflects the current state of your codebase.`,
                toolCalls: [{
                    id: "7",
                    function: "complete",
                    args: JSON.stringify({
                        phaseComplete: true,
                        readyForNext: true,
                        suggestedNextPhase: "verification",
                        summary: "Project inventory regenerated with latest changes"
                    })
                }]
            },
            priority: 8
        },

        // Error handling: Inventory generation fails
        {
            trigger: {
                agentName: "Executor",
                phase: "execute",
                messageContains: /error.*inventory|failed.*generate/i
            },
            response: {
                content: `I encountered an issue while generating the inventory. Let me try an alternative approach.`,
                toolCalls: [{
                    id: "8",
                    function: "shell",
                    args: JSON.stringify({
                        command: "ls -la context/",
                        purpose: "Check if context directory exists"
                    })
                }]
            },
            priority: 8
        }
    ]
};