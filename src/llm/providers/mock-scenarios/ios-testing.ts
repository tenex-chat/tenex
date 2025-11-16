import type { MockScenario } from "../MockProvider";

/**
 * iOS Testing Scenarios
 *
 * These scenarios provide deterministic responses for iOS app testing.
 * The backend will respond with these predetermined responses while
 * the iOS app believes it's talking to a real LLM.
 */

export const iosTestingScenarios: MockScenario[] = [
    // Scenario 1: Basic greeting and project status
    {
        name: "ios-greeting",
        description: "Basic greeting response with project status",
        triggers: {
            contentMatch: /hello|hi|hey/i,
            phase: "CHAT",
        },
        events: [
            {
                type: "project-status",
                delay: 100,
                data: {
                    projectReference: "31933:mock-backend:ios-test-project",
                    agents: [
                        { pubkey: "executor-pubkey-123", slug: "executor", isGlobal: false },
                        { pubkey: "planner-pubkey-456", slug: "planner", isGlobal: true },
                    ],
                    models: {
                        "gpt-4": ["executor"],
                        "claude-3": ["planner"],
                    },
                    tools: {
                        shell: ["executor"],
                        readPath: ["executor", "planner"],
                        writeContextFile: ["executor"],
                    },
                    status: "Agents online and ready",
                },
            },
            {
                type: "typing-start",
                delay: 200,
                data: {
                    phase: "planning",
                    message: "Thinking about your request...",
                },
            },
            {
                type: "typing-stop",
                delay: 2000,
                data: {},
            },
        ],
        response: {
            content:
                "Hello! I'm your AI assistant running in test mode. I can help you with various tasks. What would you like to work on today?",
            delay: 2500,
            toolCalls: [],
        },
    },

    // Scenario 2: Create file request
    {
        name: "ios-create-file",
        description: "File creation workflow",
        triggers: {
            contentMatch: /create.*file|write.*file|make.*file/i,
        },
        events: [
            {
                type: "typing-start",
                delay: 100,
                data: {
                    phase: "planning",
                    message: "Planning file creation...",
                },
            },
            {
                type: "typing-stop",
                delay: 1000,
                data: {},
            },
            {
                type: "typing-start",
                delay: 1200,
                data: {
                    phase: "implementing",
                    message: "Creating the file...",
                },
            },
            {
                type: "task",
                delay: 1500,
                data: {
                    content: "Create requested file",
                    status: "pending",
                    hashtags: ["file-creation", "implementation"],
                },
            },
            {
                type: "typing-stop",
                delay: 3000,
                data: {},
            },
            {
                type: "task",
                delay: 3500,
                data: {
                    content: "Create requested file",
                    status: "completed",
                    hashtags: ["file-creation", "implementation"],
                },
            },
        ],
        response: {
            content: "I'll create that file for you. Let me set that up now.",
            delay: 500,
            toolCalls: [
                {
                    name: "writeContextFile",
                    params: {
                        path: "test-file.md",
                        content:
                            "# Test File\n\nThis is a test file created by the mock backend.\n\n## Contents\n\n- This file was created as part of iOS testing\n- The backend is using predetermined responses\n- The iOS app should display this as a successful file creation\n",
                    },
                },
                {
                    name: "complete",
                    params: {
                        summary: "Successfully created test-file.md with sample content",
                    },
                },
            ],
        },
    },

    // Scenario 3: List files/project inventory
    {
        name: "ios-list-files",
        description: "List project files",
        triggers: {
            contentMatch: /list.*files|show.*files|what.*files|inventory/i,
        },
        events: [
            {
                type: "typing-start",
                delay: 100,
                data: {
                    phase: "implementing",
                    message: "Scanning project files...",
                },
            },
            {
                type: "typing-stop",
                delay: 1500,
                data: {},
            },
        ],
        response: {
            content: `Here are the files in your project:

📁 **Project Structure:**
\`\`\`
ios-test-project/
├── README.md
├── src/
│   ├── main.swift
│   └── utils.swift
├── tests/
│   └── test.swift
└── Package.swift
\`\`\`

Total: 5 files`,
            delay: 2000,
            toolCalls: [
                {
                    name: "complete",
                    params: {
                        summary: "Listed 5 project files",
                    },
                },
            ],
        },
    },

    // Scenario 4: Error simulation
    {
        name: "ios-error-test",
        description: "Simulate an error for testing error handling",
        triggers: {
            contentMatch: /simulate.*error|test.*error|crash/i,
        },
        events: [
            {
                type: "typing-start",
                delay: 100,
                data: {
                    phase: "implementing",
                    message: "Processing request...",
                },
            },
            {
                type: "typing-stop",
                delay: 500,
                data: {},
            },
        ],
        response: {
            content:
                "I encountered an issue while processing your request. This is a simulated error for testing purposes.",
            delay: 1000,
            toolCalls: [
                {
                    name: "shell",
                    params: {
                        command: "exit 1",
                    },
                },
            ],
        },
    },

    // Scenario 5: Multi-agent conversation
    {
        name: "ios-multi-agent",
        description: "Multi-agent delegation test",
        triggers: {
            contentMatch: /analyze.*code|review.*code|complex/i,
        },
        events: [
            {
                type: "project-status",
                delay: 100,
                data: {
                    agents: [
                        { pubkey: "executor-pubkey", slug: "executor", isGlobal: false },
                        { pubkey: "planner-pubkey", slug: "planner", isGlobal: false },
                        { pubkey: "reviewer-pubkey", slug: "reviewer", isGlobal: true },
                    ],
                    models: {
                        "gpt-4": ["executor", "reviewer"],
                        "claude-3": ["planner"],
                    },
                },
            },
            {
                type: "typing-start",
                delay: 200,
                data: {
                    phase: "planning",
                    message: "Planner agent is analyzing the request...",
                },
            },
            {
                type: "typing-stop",
                delay: 1500,
                data: {},
            },
            {
                type: "reply",
                delay: 1600,
                data: {
                    content:
                        "I'll help you analyze the code. Let me delegate this to the appropriate agents.",
                    kind: 1111,
                },
            },
            {
                type: "typing-start",
                delay: 2000,
                data: {
                    phase: "reviewing",
                    message: "Reviewer agent is examining the code...",
                },
            },
            {
                type: "typing-stop",
                delay: 4000,
                data: {},
            },
        ],
        response: {
            content: `I've completed the code analysis. Here's what I found:

## Code Review Summary

✅ **Strengths:**
- Clean code structure
- Good naming conventions
- Proper error handling

⚠️ **Suggestions:**
- Consider adding more comments
- Some functions could be refactored for clarity
- Add unit tests for edge cases

The code is ready for production with minor improvements.`,
            delay: 4500,
            toolCalls: [
                {
                    name: "delegate_phase",
                    params: {
                        phase: "REVIEW",
                        summary: "Code analysis completed",
                    },
                },
                {
                    name: "complete",
                    params: {
                        summary: "Code review completed with suggestions",
                    },
                },
            ],
        },
    },

    // Scenario 6: Long-running task with progress updates
    {
        name: "ios-long-task",
        description: "Simulate a long-running task with multiple status updates",
        triggers: {
            contentMatch: /deploy|build.*project|compile/i,
        },
        events: [
            {
                type: "typing-start",
                delay: 100,
                data: {
                    phase: "implementing",
                    message: "Starting build process...",
                },
            },
            {
                type: "task",
                delay: 500,
                data: {
                    content: "Build project",
                    status: "pending",
                    hashtags: ["build", "deployment"],
                },
            },
            {
                type: "typing-stop",
                delay: 1000,
                data: {},
            },
            {
                type: "typing-start",
                delay: 2000,
                data: {
                    phase: "implementing",
                    message: "Compiling source files...",
                },
            },
            {
                type: "typing-stop",
                delay: 4000,
                data: {},
            },
            {
                type: "typing-start",
                delay: 4500,
                data: {
                    phase: "implementing",
                    message: "Running tests...",
                },
            },
            {
                type: "typing-stop",
                delay: 6000,
                data: {},
            },
            {
                type: "task",
                delay: 6500,
                data: {
                    content: "Build project",
                    status: "completed",
                    hashtags: ["build", "deployment"],
                },
            },
        ],
        response: {
            content: `Build completed successfully! 

📊 **Build Summary:**
- Compiled: 42 files
- Tests passed: 15/15
- Build time: 6.5 seconds
- Output: ./build/app.exe

The application is ready for deployment.`,
            delay: 7000,
            toolCalls: [
                {
                    name: "shell",
                    params: {
                        command: "echo 'Build successful'",
                    },
                },
                {
                    name: "complete",
                    params: {
                        summary: "Project built successfully",
                    },
                },
            ],
        },
    },

    // Default fallback scenario
    {
        name: "ios-default",
        description: "Default response for unmatched inputs",
        triggers: {
            contentMatch: /.*/, // Matches anything
        },
        events: [
            {
                type: "typing-start",
                delay: 100,
                data: {
                    phase: "planning",
                    message: "Processing your request...",
                },
            },
            {
                type: "typing-stop",
                delay: 1000,
                data: {},
            },
        ],
        response: {
            content:
                "I understand your request. This is a test response from the mock backend. In a real scenario, I would process your specific request here.",
            delay: 1500,
            toolCalls: [
                {
                    name: "complete",
                    params: {
                        summary: "Processed user request",
                    },
                },
            ],
        },
    },
];

/**
 * Load iOS testing scenarios based on test type
 */
export function getIOSScenarios(testType?: string): MockScenario[] {
    switch (testType) {
        case "basic":
            return [iosTestingScenarios[0], iosTestingScenarios[6]]; // Greeting and default

        case "files":
            return [iosTestingScenarios[1], iosTestingScenarios[2]]; // File operations

        case "errors":
            return [iosTestingScenarios[3]]; // Error handling

        case "multi-agent":
            return [iosTestingScenarios[4]]; // Multi-agent

        case "long-tasks":
            return [iosTestingScenarios[5]]; // Long-running tasks
        default:
            return iosTestingScenarios;
    }
}
