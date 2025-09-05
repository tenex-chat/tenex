import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { AgentConversationContext } from "@/conversations/AgentConversationContext";
import type { ConversationMessageRepository } from "@/conversations/ConversationMessageRepository";
import type { MockLLMService } from "@/llm/__tests__/MockLLMService";
import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { ProjectContext } from "@/services/ProjectContext";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface E2ETestContext {
    mockLLM: MockLLMService;
    conversationCoordinator: ConversationCoordinator;
    agentContext: AgentConversationContext;
    messageRepo: ConversationMessageRepository;
    agentRegistry: AgentRegistry;
    projectContext: ProjectContext;
    testAgents: AgentInstance[];
    cleanup: () => Promise<void>;
}

export interface ExecutionTrace {
    conversationId: string;
    executions: AgentExecutionRecord[];
    phaseTransitions: PhaseTransitionRecord[];
    toolCalls: ToolCallRecord[];
    routingDecisions: any[];
}

export interface AgentExecutionRecord {
    agent: string;
    phase: string;
    timestamp: Date;
    message?: string;
    toolCalls?: any[];
}

export interface PhaseTransitionRecord {
    from: string;
    to: string;
    agent: string;
    reason: string;
    timestamp: Date;
}

export interface ToolCallRecord {
    agent: string;
    tool: string;
    arguments: any;
    timestamp: Date;
}

export interface ToolCall {
    id?: string;
    type?: string;
    function?: {
        name: string;
        arguments: string;
    };
    name?: string;
    params?: any;
}

export interface AgentExecutionResult {
    message: string;
    toolCalls: ToolCall[];
}

export interface RoutingDecision {
    agents: string[];
    phase?: string;
    reason: string;
}