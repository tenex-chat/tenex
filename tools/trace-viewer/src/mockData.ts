// Mock trace data that mimics TENEX OpenTelemetry structure

import type { Trace, TraceSummary } from "./types.js";

export function generateMockTrace(): Trace {
    const now = Date.now();

    const trace: Trace = {
        traceId: "trace_abc123",
        timestamp: now - 15200,
        totalDuration: 15200,
        rootSpan: {
            spanId: "span_001",
            operationName: "tenex.event.process",
            startTime: 0,
            duration: 15200,
            attributes: {
                "event.id": "evt_user_request_001",
                "event.content": "Refactor the authentication system to use OAuth2",
                "event.kind": 1111,
                "routing.decision": "route_to_project",
                "project.id": "tenex_main",
            },
            events: [
                {
                    name: "routing_decision",
                    timestamp: 50,
                    attributes: {
                        decision: "route_to_project",
                    },
                },
                {
                    name: "agent_routing",
                    timestamp: 120,
                    attributes: {
                        "routing.mentioned_pubkeys_count": 1,
                        "routing.resolved_agent_count": 1,
                        "routing.agent_names": "ProjectManager",
                        "routing.agent_roles": "pm",
                    },
                },
                {
                    name: "conversation.resolved",
                    timestamp: 180,
                    attributes: {
                        "resolution.type": "found_existing",
                        "conversation.id": "conv_001",
                        "conversation.message_count": 3,
                    },
                },
            ],
            children: [
                {
                    spanId: "span_002",
                    parentSpanId: "span_001",
                    operationName: "tenex.agent.execute",
                    startTime: 200,
                    duration: 4800,
                    attributes: {
                        "agent.name": "ProjectManager",
                        "agent.slug": "pm",
                        "agent.pubkey": "npub1abc...",
                        "agent.role": "pm",
                        "conversation.id": "conv_001",
                        "conversation.phase": "chat",
                        "conversation.message_count": 4,
                    },
                    events: [
                        {
                            name: "execution.start",
                            timestamp: 210,
                            attributes: {},
                        },
                        {
                            name: "supervisor.validation_start",
                            timestamp: 4800,
                            attributes: {
                                "supervisor.continuation_attempts": 0,
                                "supervisor.has_phases": true,
                                "supervisor.phase_count": 2,
                            },
                        },
                        {
                            name: "supervisor.response_validated",
                            timestamp: 4850,
                            attributes: {
                                "response.length": 1234,
                            },
                        },
                        {
                            name: "delegation.registered",
                            timestamp: 4900,
                            attributes: {
                                "delegation.batch_id": "batch_xyz789",
                                "delegation.recipient_count": 2,
                                "delegation.delegating_agent": "pm",
                                "delegation.recipients": "npub1cod..., npub1tes...",
                            },
                        },
                        {
                            name: "execution.complete",
                            timestamp: 4950,
                            attributes: {},
                        },
                    ],
                    children: [
                        {
                            spanId: "span_003",
                            parentSpanId: "span_002",
                            operationName: "tenex.strategy.build_messages",
                            startTime: 250,
                            duration: 300,
                            attributes: {
                                "strategy.name": "FlattenedChronological",
                                "agent.name": "ProjectManager",
                            },
                            events: [
                                {
                                    name: "system_prompt_compiled",
                                    timestamp: 400,
                                    attributes: {
                                        "prompt.length": 15234,
                                        "prompt.content": `# Your Identity

Your name: Project Manager (pm)
Your role: project manager
Your npub: npub1abc...

## Your Responsibilities
- Coordinate agent workflows
- Delegate tasks to specialist agents
- Ensure project goals are met

## Available Tools
- delegate_phase: Assign work to specialist agents
- ask: Ask questions to the user

## Current Conversation
User: Refactor the authentication system to use OAuth2`,
                                    },
                                },
                                {
                                    name: "events_gathered",
                                    timestamp: 450,
                                    attributes: {
                                        relevant_event_count: 5,
                                        total_event_count: 5,
                                    },
                                },
                                {
                                    name: "messages_built",
                                    timestamp: 500,
                                    attributes: {
                                        message_count: 6,
                                    },
                                },
                            ],
                            children: [],
                        },
                        {
                            spanId: "span_004",
                            parentSpanId: "span_002",
                            operationName: "ai.streamText",
                            startTime: 600,
                            duration: 4000,
                            attributes: {
                                "ai.model.id": "anthropic/claude-3.5-sonnet",
                                "ai.model.provider": "openrouter",
                                "ai.prompt.messages": JSON.stringify([
                                    { role: "system", content: "# Your Identity..." },
                                    {
                                        role: "user",
                                        content: "Refactor the authentication system...",
                                    },
                                ]),
                                "ai.usage.promptTokens": 1523,
                                "ai.usage.completionTokens": 234,
                            },
                            events: [],
                            children: [
                                {
                                    spanId: "span_005",
                                    parentSpanId: "span_004",
                                    operationName: "ai.toolCall",
                                    startTime: 2500,
                                    duration: 1400,
                                    attributes: {
                                        "ai.toolCall.name": "delegate_phase",
                                        "ai.toolCall.id": "call_001",
                                        "ai.toolCall.args": JSON.stringify({
                                            phase: "code_analysis",
                                            recipient: "coder1",
                                            request: "Analyze current auth implementation",
                                        }),
                                    },
                                    events: [
                                        {
                                            name: "tool.execution_start",
                                            timestamp: 2510,
                                            attributes: {
                                                "tool.name": "delegate_phase",
                                                "tool.call_id": "call_001",
                                                "tool.args_preview":
                                                    '{"phase":"code_analysis","recipient":"coder1","request":"Analyze current auth implementation"}',
                                            },
                                        },
                                        {
                                            name: "tool.execution_complete",
                                            timestamp: 3900,
                                            attributes: {
                                                "tool.name": "delegate_phase",
                                                "tool.call_id": "call_001",
                                                "tool.error": false,
                                                "tool.result_preview":
                                                    '{"success":true,"delegationEventId":"evt_del_001"}',
                                            },
                                        },
                                    ],
                                    children: [],
                                },
                                {
                                    spanId: "span_006",
                                    parentSpanId: "span_004",
                                    operationName: "ai.toolCall",
                                    startTime: 3950,
                                    duration: 600,
                                    attributes: {
                                        "ai.toolCall.name": "delegate_phase",
                                        "ai.toolCall.id": "call_002",
                                        "ai.toolCall.args": JSON.stringify({
                                            phase: "testing",
                                            recipient: "tester",
                                            request: "Create test plan for OAuth2",
                                        }),
                                    },
                                    events: [
                                        {
                                            name: "tool.execution_start",
                                            timestamp: 3960,
                                            attributes: {
                                                "tool.name": "delegate_phase",
                                                "tool.call_id": "call_002",
                                                "tool.args_preview":
                                                    '{"phase":"testing","recipient":"tester","request":"Create test plan for OAuth2"}',
                                            },
                                        },
                                        {
                                            name: "tool.execution_complete",
                                            timestamp: 4550,
                                            attributes: {
                                                "tool.name": "delegate_phase",
                                                "tool.call_id": "call_002",
                                                "tool.error": false,
                                                "tool.result_preview":
                                                    '{"success":true,"delegationEventId":"evt_del_002"}',
                                            },
                                        },
                                    ],
                                    children: [],
                                },
                            ],
                        },
                    ],
                },
                // Delegated agent execution (Coder1)
                {
                    spanId: "span_007",
                    parentSpanId: "span_001",
                    operationName: "tenex.event.process",
                    startTime: 5000,
                    duration: 12300,
                    attributes: {
                        "event.id": "evt_delegation_001",
                        "event.content": "Analyze current auth implementation",
                        "event.kind": 1111,
                        "routing.decision": "route_to_project",
                        "event.has_trace_context": true,
                    },
                    events: [
                        {
                            name: "agent_routing",
                            timestamp: 5050,
                            attributes: {
                                "routing.resolved_agent_count": 1,
                                "routing.agent_names": "CodeAnalyzer",
                            },
                        },
                    ],
                    children: [
                        {
                            spanId: "span_008",
                            parentSpanId: "span_007",
                            operationName: "tenex.agent.execute",
                            startTime: 5100,
                            duration: 12000,
                            attributes: {
                                "agent.name": "CodeAnalyzer",
                                "agent.slug": "coder1",
                                "agent.role": "worker",
                                "conversation.phase": "code_analysis",
                            },
                            events: [
                                {
                                    name: "execution.start",
                                    timestamp: 5110,
                                    attributes: {},
                                },
                            ],
                            children: [
                                {
                                    spanId: "span_009",
                                    parentSpanId: "span_008",
                                    operationName: "ai.streamText",
                                    startTime: 5500,
                                    duration: 11500,
                                    attributes: {
                                        "ai.model.id": "anthropic/claude-3.5-sonnet",
                                    },
                                    events: [],
                                    children: [
                                        {
                                            spanId: "span_010",
                                            parentSpanId: "span_009",
                                            operationName: "ai.toolCall",
                                            startTime: 7000,
                                            duration: 500,
                                            attributes: {
                                                "ai.toolCall.name": "search_code",
                                                "ai.toolCall.args": JSON.stringify({
                                                    query: "authentication",
                                                    path: "src/",
                                                }),
                                            },
                                            events: [
                                                {
                                                    name: "tool.execution_start",
                                                    timestamp: 7010,
                                                    attributes: {
                                                        "tool.name": "search_code",
                                                        "tool.args_preview":
                                                            '{"query":"authentication","path":"src/"}',
                                                    },
                                                },
                                                {
                                                    name: "tool.execution_complete",
                                                    timestamp: 7500,
                                                    attributes: {
                                                        "tool.name": "search_code",
                                                        "tool.error": false,
                                                        "tool.result_preview":
                                                            '{"files":["src/auth/login.ts","src/auth/register.ts"]}',
                                                    },
                                                },
                                            ],
                                            children: [],
                                        },
                                        {
                                            spanId: "span_011",
                                            parentSpanId: "span_009",
                                            operationName: "ai.toolCall",
                                            startTime: 9000,
                                            duration: 300,
                                            attributes: {
                                                "ai.toolCall.name": "read_file",
                                                "ai.toolCall.args": JSON.stringify({
                                                    path: "src/auth/login.ts",
                                                }),
                                            },
                                            events: [
                                                {
                                                    name: "tool.execution_start",
                                                    timestamp: 9010,
                                                    attributes: {
                                                        "tool.name": "read_file",
                                                        "tool.args_preview":
                                                            '{"path":"src/auth/login.ts"}',
                                                    },
                                                },
                                                {
                                                    name: "tool.execution_complete",
                                                    timestamp: 9300,
                                                    attributes: {
                                                        "tool.name": "read_file",
                                                        "tool.error": false,
                                                        "tool.result_preview":
                                                            "export function login(username: string, password: string) { ... }",
                                                    },
                                                },
                                            ],
                                            children: [],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    };

    return trace;
}

export function generateMockTraceList(): TraceSummary[] {
    const now = Date.now();

    return [
        {
            traceId: "trace_abc123",
            summary: 'User → PM: "Refactor auth system"',
            duration: 15200,
            timestamp: now - 300000,
        },
        {
            traceId: "trace_def456",
            summary: 'User → PM: "Add rate limiting"',
            duration: 8900,
            timestamp: now - 600000,
        },
        {
            traceId: "trace_ghi789",
            summary: 'User → PM: "Fix bug in payment flow"',
            duration: 23400,
            timestamp: now - 900000,
        },
    ];
}
