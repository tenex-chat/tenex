import type { MockLLMScenario } from "../types";

/**
 * Complete orchestrator workflow scenario covering all phases:
 * CHAT -> PLAN -> EXECUTE -> VERIFICATION
 */
export const orchestratorWorkflowScenario: MockLLMScenario = {
    name: "orchestrator-workflow",
    description: "Complete orchestrator workflow from chat to verification",
    responses: [
        // Initial chat phase - user asks to create a feature
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "CHAT",
                userMessage: /create.*user authentication/i
            },
            response: {
                content: "I'll help you create a user authentication system. Let me first understand your requirements better.",
                toolCalls: [{
                    id: "1",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "User wants to create authentication system - gathering requirements",
                            suggestedPhase: "CHAT",
                            confidence: 90,
                            reasoning: "Need to understand authentication requirements before planning"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Chat phase - gathering requirements
        {
            trigger: {
                agentName: "Executor",
                phase: "CHAT",
                userMessage: /JWT.*OAuth/i
            },
            response: {
                content: "I understand you want JWT-based authentication with OAuth support. Let me create a plan for this.",
                toolCalls: [{
                    id: "2",
                    type: "function",
                    function: {
                        name: "complete",
                        arguments: JSON.stringify({
                            phaseComplete: true,
                            readyForNext: true,
                            suggestedNextPhase: "PLAN",
                            summary: "Requirements gathered: JWT auth with OAuth providers"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Orchestrator transitions to PLAN phase
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "CHAT",
                previousToolCalls: ["complete"]
            },
            response: {
                toolCalls: [{
                    id: "3",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Requirements gathered, moving to planning phase",
                            suggestedPhase: "PLAN",
                            confidence: 95,
                            reasoning: "Requirements are clear, ready to create implementation plan"
                        })
                    }
                }]
            },
            priority: 9
        },

        // PLAN phase - Planner creates implementation plan
        {
            trigger: {
                agentName: "Planner",
                phase: "PLAN",
                systemPrompt: /JWT.*OAuth/i
            },
            response: {
                content: `# Authentication System Implementation Plan

## Overview
Implement JWT-based authentication with OAuth provider support.

## Architecture
- JWT token management
- OAuth2 integration (Google, GitHub)
- User session handling
- Secure password storage

## Implementation Steps
1. Set up authentication middleware
2. Create user model and database schema
3. Implement JWT token generation/validation
4. Add OAuth provider integration
5. Create login/logout endpoints
6. Add session management
7. Write tests

## Security Considerations
- Use bcrypt for password hashing
- Implement refresh tokens
- Add rate limiting
- Enable CORS properly`,
                toolCalls: [{
                    id: "4",
                    type: "function",
                    function: {
                        name: "writeContextFile",
                        arguments: JSON.stringify({
                            filename: "PLAN.md",
                            content: "# Authentication Implementation Plan\n\n[Plan content here]..."
                        })
                    }
                }]
            },
            priority: 10
        },

        // Planner completes planning
        {
            trigger: {
                agentName: "Planner",
                phase: "PLAN",
                previousToolCalls: ["writeContextFile"]
            },
            response: {
                toolCalls: [{
                    id: "5",
                    type: "function",
                    function: {
                        name: "complete",
                        arguments: JSON.stringify({
                            phaseComplete: true,
                            readyForNext: true,
                            suggestedNextPhase: "EXECUTE",
                            summary: "Comprehensive authentication plan created"
                        })
                    }
                }]
            },
            priority: 9
        },

        // Orchestrator transitions to EXECUTE phase
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "PLAN",
                previousToolCalls: ["complete"]
            },
            response: {
                toolCalls: [{
                    id: "6",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Plan approved, starting implementation",
                            suggestedPhase: "EXECUTE",
                            confidence: 98,
                            reasoning: "Plan is comprehensive and ready for implementation"
                        })
                    }
                }]
            },
            priority: 9
        },

        // EXECUTE phase - Executor implements the feature
        {
            trigger: {
                agentName: "Executor",
                phase: "EXECUTE",
                systemPrompt: /implement.*authentication/i
            },
            response: {
                content: "Starting implementation of the authentication system...",
                toolCalls: [{
                    id: "7",
                    type: "function",
                    function: {
                        name: "writeFile",
                        arguments: JSON.stringify({
                            path: "src/auth/jwt.ts",
                            content: "import jwt from 'jsonwebtoken';\n\nexport class JWTManager {\n  // Implementation\n}"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Executor creates multiple files
        {
            trigger: {
                agentName: "Executor",
                phase: "EXECUTE",
                previousToolCalls: ["writeFile"]
            },
            response: {
                content: "Created JWT manager, now implementing OAuth providers...",
                toolCalls: [{
                    id: "8",
                    type: "function",
                    function: {
                        name: "writeFile",
                        arguments: JSON.stringify({
                            path: "src/auth/oauth.ts",
                            content: "export class OAuthProvider {\n  // OAuth implementation\n}"
                        })
                    }
                }]
            },
            priority: 9
        },

        // Executor runs tests
        {
            trigger: {
                agentName: "Executor",
                phase: "EXECUTE",
                userMessage: /test|verify/i
            },
            response: {
                content: "Running tests to verify the implementation...",
                toolCalls: [{
                    id: "9",
                    type: "function",
                    function: {
                        name: "shell",
                        arguments: JSON.stringify({
                            command: "npm test",
                            cwd: "."
                        })
                    }
                }]
            },
            priority: 8
        },

        // Executor completes implementation
        {
            trigger: {
                agentName: "Executor",
                phase: "EXECUTE",
                previousToolCalls: ["shell"]
            },
            response: {
                content: "Authentication system implemented successfully. All tests passing.",
                toolCalls: [{
                    id: "10",
                    type: "function",
                    function: {
                        name: "complete",
                        arguments: JSON.stringify({
                            phaseComplete: true,
                            readyForNext: true,
                            suggestedNextPhase: "VERIFICATION",
                            summary: "Authentication system implemented with JWT and OAuth"
                        })
                    }
                }]
            },
            priority: 9
        },

        // Orchestrator transitions to VERIFICATION
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "EXECUTE",
                previousToolCalls: ["complete"]
            },
            response: {
                toolCalls: [{
                    id: "11",
                    type: "function",
                    function: {
                        name: "continue",
                        arguments: JSON.stringify({
                            summary: "Implementation complete, proceeding to verification",
                            suggestedPhase: "VERIFICATION",
                            confidence: 100,
                            reasoning: "All components implemented and tests passing"
                        })
                    }
                }]
            },
            priority: 9
        },

        // VERIFICATION phase - final checks
        {
            trigger: {
                agentName: "Executor",
                phase: "VERIFICATION",
                systemPrompt: /verify.*implementation/i
            },
            response: {
                content: `## Verification Report

✅ **JWT Authentication**: Implemented and tested
✅ **OAuth Providers**: Google and GitHub integrated
✅ **Security**: Bcrypt hashing, refresh tokens, rate limiting
✅ **Tests**: All 47 tests passing
✅ **Documentation**: API docs updated

The authentication system has been successfully implemented and verified.`,
                toolCalls: [{
                    id: "12",
                    type: "function",
                    function: {
                        name: "complete",
                        arguments: JSON.stringify({
                            phaseComplete: true,
                            readyForNext: false,
                            summary: "Authentication system verified and ready for use"
                        })
                    }
                }]
            },
            priority: 10
        },

        // Final orchestrator completion
        {
            trigger: {
                agentName: "Orchestrator",
                phase: "VERIFICATION",
                previousToolCalls: ["complete"]
            },
            response: {
                content: "Task completed successfully! The authentication system has been implemented, tested, and verified.",
                toolCalls: [{
                    id: "13",
                    type: "function",
                    function: {
                        name: "endConversation",
                        arguments: JSON.stringify({
                            reason: "Task completed successfully"
                        })
                    }
                }]
            },
            priority: 9
        }
    ]
};