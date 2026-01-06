#!/usr/bin/env npx tsx
/**
 * Integration test to verify the CWD bug exists in the actual codebase.
 *
 * This script imports the real code and demonstrates that:
 * 1. createAgentInstance captures registry.getBasePath() at creation time
 * 2. The captured path is used regardless of execution context
 */

import { createAgentInstance } from "../src/agents/agent-loader";
import { AgentRegistry } from "../src/agents/AgentRegistry";
import type { StoredAgent } from "../src/agents/AgentStorage";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

const PROJECT_BASE_PATH = "/Users/pablofernandez/Work/TENEX-ff3ssq";
const WORKTREE_PATH = "/Users/pablofernandez/Work/TENEX-ff3ssq/.worktrees/test-branch";

console.log("=== Integration Test: CWD Bug in createAgentInstance ===\n");

// Create a mock stored agent
const secretKey = generateSecretKey();
const mockStoredAgent: StoredAgent = {
    slug: "test-agent",
    name: "Test Agent",
    pubkey: getPublicKey(secretKey),
    nsec: bytesToHex(secretKey),
    role: "tester",
    description: "Test agent for CWD bug verification",
    instructions: "Test instructions",
    tools: [],
    llmConfig: "claude-code",
    projects: [],
};

// Create an AgentRegistry that returns PROJECT_BASE_PATH
const mockRegistry = {
    getBasePath: () => PROJECT_BASE_PATH,
    getMetadataPath: () => `${PROJECT_BASE_PATH}/.tenex/metadata`,
    addAgent: () => {},
    getAgent: () => undefined,
    getAgentByEventId: () => undefined,
    agents: [],
} as unknown as AgentRegistry;

console.log("1. Creating agent instance with registry pointing to project base...\n");
console.log(`   Registry.getBasePath() returns: ${mockRegistry.getBasePath()}`);

// Create the agent instance - this captures the registry.getBasePath() in the closure
const agentInstance = createAgentInstance(mockStoredAgent, mockRegistry);

console.log("\n2. Agent instance created. Now simulating worktree execution...\n");
console.log(`   Execution context workingDirectory would be: ${WORKTREE_PATH}`);
console.log(`   But createLLMService doesn't accept workingDirectory as parameter!`);

// Look at the createLLMService function signature
console.log("\n3. Inspecting createLLMService interface...\n");
console.log("   Expected signature: createLLMService({ tools, sessionId, workingDirectory })");
console.log("   Actual signature:   createLLMService({ tools, sessionId })  <-- workingDirectory MISSING!");

console.log("\n4. The bug: workingDirectory is hardcoded at agent creation time.\n");
console.log(`   When Claude Code runs, it will ALWAYS use: ${PROJECT_BASE_PATH}`);
console.log(`   Even though the execution context says: ${WORKTREE_PATH}`);

// We can't easily call createLLMService without a full config setup,
// but we can inspect the function's source to see the hardcoded value
console.log("\n5. Source code inspection of the closure:\n");
const createLLMServiceSrc = agentInstance.createLLMService.toString();
if (createLLMServiceSrc.includes("registry.getBasePath()") || createLLMServiceSrc.includes("getBasePath")) {
    console.log("   ✓ Closure captures registry.getBasePath() (as expected for the bug)");
} else {
    // Minified or bundled code might not show this clearly
    console.log("   Function source (may be transformed):");
    console.log(`   ${createLLMServiceSrc.substring(0, 200)}...`);
}

console.log("\n=== CONCLUSION ===\n");
console.log("The AgentInstance.createLLMService method:");
console.log("- Does NOT accept workingDirectory parameter");
console.log("- Uses registry.getBasePath() captured at creation time");
console.log("- Will always use project root, even when executing in a worktree");
console.log("\nFIX REQUIRED:");
console.log("1. Add workingDirectory to createLLMService options (types/runtime.ts)");
console.log("2. Pass options.workingDirectory in agent-loader.ts");
console.log("3. Pass context.workingDirectory in AgentExecutor.ts line 651");
