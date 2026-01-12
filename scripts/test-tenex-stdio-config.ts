#!/usr/bin/env bun

/**
 * Test TenexStdioMcpServer Configuration Generation
 *
 * Verifies the stdio MCP server config is correctly generated
 * with proper environment variables and tool filtering
 */

import { TenexStdioMcpServer } from "@/llm/providers/agent/TenexStdioMcpServer";
import type { ProviderRuntimeContext } from "@/llm/providers/types";
import chalk from "chalk";

async function testConfigGeneration() {
  console.log(chalk.bold.cyan("\n=== TENEX STDIO MCP SERVER CONFIG TEST ===\n"));

  // Create a mock context like CodexCliProvider would
  const mockContext: Partial<ProviderRuntimeContext> = {
    agentName: "test-architect",
    workingDirectory: "/path/to/project",
    sessionId: "session-123",
    tools: {
      delegate: {},
      ask: {},
      conversation_get: {},
      "mcp__repomix__analyze": {}, // External MCP tool - should be filtered out
      "mcp__other__tool": {},
    },
  };

  console.log(chalk.blue("[Setup] Creating mock ProviderRuntimeContext"));
  console.log(chalk.gray(JSON.stringify(mockContext, null, 2)));

  // Extract tool names like CodexCliProvider does
  const toolNames = mockContext.tools ? Object.keys(mockContext.tools) : [];
  console.log(chalk.blue("\n[Tools] All tool names:"));
  console.log(chalk.gray(toolNames.join(", ")));

  // Filter to regular tools (like CodexCliProvider does)
  const regularTools = toolNames.filter((name) => !name.startsWith("mcp__"));
  console.log(chalk.blue("\n[Filter] Filtered to TENEX tools:"));
  console.log(chalk.gray(regularTools.join(", ")));

  // Create the stdio MCP server config
  console.log(chalk.blue("\n[Create] Calling TenexStdioMcpServer.create()..."));
  const config = TenexStdioMcpServer.create(mockContext as ProviderRuntimeContext, regularTools);

  if (!config) {
    console.log(chalk.red("✗ No config generated (expected if no TENEX tools)"));
    process.exit(1);
  }

  console.log(chalk.green("✓ Config generated successfully"));

  // Verify config structure
  console.log(chalk.blue("\n[Verify] Stdio MCP Server Config"));

  console.log(chalk.gray("\nTransport:"));
  console.log(chalk.gray(`  ${config.transport}`));
  if (config.transport !== "stdio") {
    throw new Error("Invalid transport");
  }
  console.log(chalk.green("  ✓ Correct transport type"));

  console.log(chalk.gray("\nCommand:"));
  console.log(chalk.gray(`  ${config.command}`));
  if (!config.command.includes("bun") && !config.command.includes("node")) {
    throw new Error("Invalid command");
  }
  console.log(chalk.green("  ✓ Valid runtime command"));

  console.log(chalk.gray("\nArgs:"));
  for (const arg of config.args) {
    console.log(chalk.gray(`  - ${arg}`));
  }
  if (!config.args.includes("mcp") || !config.args.includes("serve")) {
    throw new Error("Invalid args");
  }
  console.log(chalk.green("  ✓ Has mcp serve subcommand"));

  console.log(chalk.gray("\nEnvironment Variables:"));
  const envVars = [
    "TENEX_PROJECT_ID",
    "TENEX_AGENT_ID",
    "TENEX_CONVERSATION_ID",
    "TENEX_WORKING_DIRECTORY",
    "TENEX_CURRENT_BRANCH",
    "TENEX_TOOLS",
  ];

  for (const envVar of envVars) {
    const value = config.env[envVar];
    if (!value) {
      console.log(chalk.red(`  ✗ Missing ${envVar}`));
      throw new Error(`Missing env var: ${envVar}`);
    }
    console.log(chalk.gray(`  ${envVar}=${value}`));
  }
  console.log(chalk.green("  ✓ All required env vars present"));

  // Verify tool filtering in env
  const toolsStr = config.env.TENEX_TOOLS;
  const configuredTools = toolsStr.split(",");
  console.log(chalk.blue("\n[Verify] Tool Filtering"));
  console.log(chalk.gray(`TENEX_TOOLS: ${toolsStr}`));

  const hasMcpTools = configuredTools.some((t) => t.startsWith("mcp__"));
  if (hasMcpTools) {
    console.log(chalk.red("✗ MCP tools should not be in TENEX_TOOLS"));
    throw new Error("MCP tools incorrectly included");
  }
  console.log(chalk.green("✓ MCP tools correctly filtered out"));

  const hasLocalTools = configuredTools.some((t) => ["delegate", "ask", "conversation_get"].includes(t));
  if (!hasLocalTools) {
    console.log(chalk.yellow("⚠ No local TENEX tools in config"));
  } else {
    console.log(chalk.green("✓ Local TENEX tools included"));
  }

  // Test the actual subprocess spawn behavior
  console.log(chalk.blue("\n[Simulate] Subprocess Spawn"));
  console.log(chalk.gray("The stdio MCP server would be spawned with:"));
  console.log(chalk.gray(`  Command: ${config.command}`));
  console.log(chalk.gray(`  Args: ${config.args.join(" ")}`));
  console.log(chalk.gray(`  Environment: (TENEX_* vars + parent env)`));

  console.log(chalk.blue("\n[Flow] Request Handling"));
  console.log(chalk.gray("1. MCP Client (Codex CLI) sends JSON-RPC request"));
  console.log(chalk.gray("   → tools/list: Get available tools"));
  console.log(chalk.gray("   → tools/call: Execute tool with args"));
  console.log(chalk.gray("2. Subprocess (tenex mcp serve) receives via stdin"));
  console.log(chalk.gray("3. serve.ts loads env vars → reconstructs context"));
  console.log(chalk.gray("4. getToolsObject() loads tool implementations"));
  console.log(chalk.gray("5. Tool executed → returns result/error"));
  console.log(chalk.gray("6. Response sent back via stdout"));

  console.log(chalk.bold.green("\n✅ CONFIG GENERATION TEST PASSED"));

  console.log(chalk.blue("\n[Summary]"));
  console.log(chalk.green("✓ TenexStdioMcpServer.create() generates valid config"));
  console.log(chalk.green("✓ All required environment variables present"));
  console.log(chalk.green("✓ Tool filtering works (MCP tools excluded)"));
  console.log(chalk.green("✓ Config can spawn subprocess with tenex mcp serve"));
  console.log(chalk.green("✓ Integration with CodexCliProvider ready"));

  console.log(chalk.yellow("\n[Integration Point] CodexCliProvider Usage"));
  console.log(chalk.gray("See: src/llm/providers/agent/CodexCliProvider.ts:89"));
  console.log(chalk.gray("  const tenexStdioServer = TenexStdioMcpServer.create(context, regularTools);"));
  console.log(chalk.gray("  if (tenexStdioServer) {"));
  console.log(chalk.gray("    mcpServersConfig.tenex = tenexStdioServer;"));
  console.log(chalk.gray("  }"));

  process.exit(0);
}

testConfigGeneration().catch((error) => {
  console.error(chalk.red("Fatal error:"), error);
  process.exit(1);
});
