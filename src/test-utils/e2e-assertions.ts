import { expect } from "bun:test";
import type { ExecutionTrace } from "./e2e-types";

/**
 * Assert that agents execute in the expected sequence
 */
export function assertAgentSequence(trace: ExecutionTrace, ...expectedAgents: string[]) {
    const executedAgents = trace.executions.map(e => e.agent);
    expect(executedAgents).toEqual(expectedAgents);
}

/**
 * Assert that phase transitions occur in the expected order
 */
export function assertPhaseTransitions(trace: ExecutionTrace, ...expectedPhases: string[]) {
    // Extract phases from executions where phase changed
    const phases = trace.executions
        .filter(e => e.message?.includes("Phase changed"))
        .map(e => e.phase);
    expect(phases).toEqual(expectedPhases);
}

/**
 * Assert that specific tools are called by an agent
 */
export function assertToolCalls(trace: ExecutionTrace, agent: string, ...expectedTools: string[]) {
    const agentTools = trace.toolCalls
        .filter(tc => tc.agent === agent)
        .map(tc => tc.tool);
    expect(agentTools).toEqual(expectedTools);
}

/**
 * Check if feedback was propagated from one agent to another
 */
export function assertFeedbackPropagated(trace: ExecutionTrace, fromAgent: string, toAgent: string, keyword: string): boolean {
    // Find message from fromAgent
    const fromExecution = trace.executions.find(e => 
        e.agent === fromAgent && e.message?.includes(keyword)
    );
    if (!fromExecution) return false;
    
    // Find subsequent execution of toAgent
    const fromIndex = trace.executions.indexOf(fromExecution);
    const toExecution = trace.executions
        .slice(fromIndex + 1)
        .find(e => e.agent === toAgent);
    
    return toExecution !== undefined;
}