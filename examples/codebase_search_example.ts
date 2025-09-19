/**
 * Example usage of the codebase_search tool
 */

import { createCodebaseSearchTool } from "../src/tools/implementations/codebase_search";
import type { ExecutionContext } from "../src/agents/execution/types";

async function main() {
  // Create a mock execution context
  const context: ExecutionContext = {
    agent: { name: "example-agent" },
    projectPath: process.cwd(),
    conversationId: "example-conversation",
    conversationCoordinator: {
      getConversation: () => null,
    },
    agentPublisher: {
      conversation: async () => {},
    },
    triggeringEvent: undefined,
  } as unknown as ExecutionContext;

  // Create the tool instance
  const searchTool = createCodebaseSearchTool(context);

  console.log("=== Codebase Search Tool Examples ===\n");

  // Example 1: Search for files by name
  console.log("1. Searching for files with 'test' in the name:");
  const result1 = await searchTool.execute({
    query: "test",
    searchType: "filename",
    maxResults: 5,
  });
  console.log(result1);
  console.log("\n---\n");

  // Example 2: Search for content within TypeScript files
  console.log("2. Searching for 'ExecutionContext' in TypeScript files:");
  const result2 = await searchTool.execute({
    query: "ExecutionContext",
    searchType: "content",
    fileType: ".ts",
    maxResults: 3,
    includeSnippets: true,
  });
  console.log(result2);
  console.log("\n---\n");

  // Example 3: Combined search (both filename and content)
  console.log("3. Searching for 'tool' in both filenames and content:");
  const result3 = await searchTool.execute({
    query: "tool",
    searchType: "both",
    maxResults: 10,
  });
  console.log(result3);
  console.log("\n---\n");

  // Example 4: Search for directories
  console.log("4. Searching for directories with 'implementations' in the name:");
  const result4 = await searchTool.execute({
    query: "implementations",
    searchType: "filename",
  });
  console.log(result4);
}

// Run the example
main().catch(console.error);