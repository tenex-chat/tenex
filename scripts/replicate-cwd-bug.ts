#!/usr/bin/env npx tsx
/**
 * Script to replicate the CWD bug when Claude Code agent runs in a worktree.
 *
 * BUG: When an agent is instantiated with a git worktree, it runs from the
 * project basedir instead of the worktree directory.
 *
 * ROOT CAUSE: In agent-loader.ts, createLLMService() captures registry.getBasePath()
 * at load time. When execution happens with a different workingDirectory (e.g., worktree),
 * the hardcoded base path is used instead.
 *
 * This script demonstrates the problem by:
 * 1. Creating an AgentInstance with a mock registry
 * 2. Showing that createLLMService ignores the execution context's workingDirectory
 */

import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

// Mock the key components to demonstrate the bug
const PROJECT_BASE_PATH = "/Users/pablofernandez/Work/TENEX-ff3ssq";
const WORKTREE_PATH = "/Users/pablofernandez/Work/TENEX-ff3ssq/.worktrees/test-branch";

console.log("=== CWD Bug Replication Script ===\n");

// Show the problematic code pattern
console.log("1. THE BUG PATTERN (from agent-loader.ts lines 51-60):\n");
console.log(`
createLLMService: (options) => {
    return config.createLLMService(
        agent.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
        {
            tools: options?.tools ?? {},
            agentName: storedAgent.name,
            sessionId: options?.sessionId,
            workingDirectory: registry.getBasePath(),  // <-- BUG: Always uses base path!
        }
    );
},
`);

console.log("2. THE PROBLEM:\n");
console.log(`   registry.getBasePath() returns: ${PROJECT_BASE_PATH}`);
console.log(`   But when working in a worktree, we need: ${WORKTREE_PATH}`);
console.log("");

console.log("3. EXECUTION FLOW:\n");
console.log("   ExecutionContextFactory.createExecutionContext()");
console.log(`      → Correctly resolves workingDirectory = "${WORKTREE_PATH}"`);
console.log("   AgentExecutor.execute(context)");
console.log("      → Has context.workingDirectory pointing to worktree");
console.log("   context.agent.createLLMService({ tools, sessionId })");
console.log("      → IGNORES context.workingDirectory!");
console.log(`      → Uses hardcoded registry.getBasePath() = "${PROJECT_BASE_PATH}"`);
console.log("   ClaudeCodeProvider.createAgentSettings(context)");
console.log(`      → Receives workingDirectory: "${PROJECT_BASE_PATH}" (wrong!)`);
console.log("");

console.log("4. RESULT:\n");
console.log("   Claude Code starts in the project root directory instead of the worktree.");
console.log("   All file operations happen in the wrong location.");
console.log("");

// Simulate the bug
console.log("5. SIMULATING THE BUG:\n");

// This simulates what happens in agent-loader.ts
class MockRegistry {
    private basePath: string;

    constructor(basePath: string) {
        this.basePath = basePath;
    }

    getBasePath(): string {
        return this.basePath;
    }
}

// This simulates the agent creation at load time
function createMockAgent(registry: MockRegistry) {
    return {
        name: "test-agent",
        createLLMService: (options?: { tools?: Record<string, unknown>; sessionId?: string }) => {
            // This is the buggy pattern - workingDirectory is captured at creation time
            const workingDirectory = registry.getBasePath();
            console.log(`   createLLMService called, using workingDirectory: ${workingDirectory}`);
            return { workingDirectory };
        }
    };
}

// This simulates execution context creation (correctly resolves worktree)
function createExecutionContext(agent: ReturnType<typeof createMockAgent>, worktreePath: string) {
    return {
        agent,
        workingDirectory: worktreePath,  // Correctly points to worktree
    };
}

// Create registry with project base path
const registry = new MockRegistry(PROJECT_BASE_PATH);

// Create agent (captures registry.getBasePath() at this point)
const agent = createMockAgent(registry);

// Create execution context with worktree path
const context = createExecutionContext(agent, WORKTREE_PATH);

console.log(`   Execution context workingDirectory: ${context.workingDirectory}`);

// Call createLLMService - this is where the bug manifests
const llmConfig = context.agent.createLLMService({});

console.log("");
console.log("6. VERIFICATION:\n");
console.log(`   Expected workingDirectory: ${WORKTREE_PATH}`);
console.log(`   Actual workingDirectory:   ${llmConfig.workingDirectory}`);
console.log(`   Match: ${llmConfig.workingDirectory === WORKTREE_PATH ? "✅ YES" : "❌ NO - BUG CONFIRMED!"}`);
console.log("");

console.log("7. FIX NEEDED:\n");
console.log("   The createLLMService interface needs to accept workingDirectory as a parameter,");
console.log("   and AgentExecutor needs to pass context.workingDirectory when calling it:");
console.log("");
console.log(`
// In types/runtime.ts - add workingDirectory to options:
createLLMService(options?: {
    tools?: Record<string, CoreTool>;
    sessionId?: string;
    workingDirectory?: string;  // <-- ADD THIS
}): LLMService;

// In agent-loader.ts - use the parameter:
createLLMService: (options) => {
    return config.createLLMService(
        agent.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
        {
            tools: options?.tools ?? {},
            agentName: storedAgent.name,
            sessionId: options?.sessionId,
            workingDirectory: options?.workingDirectory ?? registry.getBasePath(),  // <-- USE PARAM
        }
    );
},

// In AgentExecutor.ts - pass the workingDirectory:
const llmService = context.agent.createLLMService({
    tools: toolsObject,
    sessionId,
    workingDirectory: context.workingDirectory,  // <-- PASS IT
});
`);
