/**
 * Example: MCP Resource Subscriptions
 *
 * This example demonstrates how to subscribe to resource updates from MCP servers
 * and automatically ingest them into RAG collections.
 */

import { experimental_createMCPClient } from 'ai';
import { mcpManager } from '../src/services/mcp/MCPManager';
import { RAGService } from '../src/services/rag/RAGService';

async function subscribeToResourceUpdates() {
  // Initialize TENEX services
  await mcpManager.initialize();
  const ragService = RAGService.getInstance();

  // Get the first running MCP server
  const servers = mcpManager.getRunningServers();
  if (servers.length === 0) {
    console.log('No MCP servers running. Configure servers in .tenex/config.json');
    return;
  }

  const serverName = servers[0];
  console.log(`Using MCP server: ${serverName}\n`);

  // List available resources
  const resources = await mcpManager.listResources(serverName);
  console.log(`Found ${resources.length} resources:\n`);

  resources.slice(0, 5).forEach(resource => {
    console.log(`  - ${resource.name} (${resource.uri})`);
  });
  console.log();

  if (resources.length === 0) {
    console.log('No resources available to subscribe to.');
    return;
  }

  // Create a RAG collection for this subscription
  const collectionName = `${serverName}-resources`;
  try {
    await ragService.createCollection({
      collectionName,
      description: `Auto-updated collection from ${serverName} MCP server`,
    });
    console.log(`Created RAG collection: ${collectionName}\n`);
  } catch (error) {
    console.log(`Collection ${collectionName} already exists\n`);
  }

  // Get the MCP client from the manager (you'll need to expose this)
  // For now, create a direct client connection
  const config = await import('../.tenex/config.json');
  const serverConfig = config.mcp.servers[serverName];

  const mcpClient = await experimental_createMCPClient({
    transport: {
      type: 'stdio',
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env,
    },
  });

  // Set up resource update handler
  mcpClient.onResourceUpdated(async ({ uri }) => {
    console.log(`🔔 Resource updated: ${uri}`);

    try {
      // Read the updated resource
      const result = await mcpClient.readResource(uri);

      // Extract content
      for (const content of result.contents) {
        if ('text' in content) {
          console.log(`   Ingesting ${content.text.length} characters into RAG...`);

          // Add to RAG collection
          await ragService.addDocuments(collectionName, [
            {
              content: content.text,
              metadata: {
                serverName,
                uri,
                timestamp: Date.now(),
              },
              source: `${serverName}:${uri}`,
              timestamp: Date.now(),
            },
          ]);

          console.log(`   ✅ Successfully ingested into ${collectionName}`);
        }
      }
    } catch (error) {
      console.error(`   ❌ Error processing update: ${error}`);
    }
    console.log();
  });

  // Subscribe to the first few resources
  const resourcesToSubscribe = resources.slice(0, 3);
  console.log(`Subscribing to ${resourcesToSubscribe.length} resources...\n`);

  for (const resource of resourcesToSubscribe) {
    try {
      await mcpClient.subscribeResource(resource.uri);
      console.log(`✅ Subscribed to: ${resource.name}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not support resource subscriptions')) {
        console.log(`⚠️  Server does not support subscriptions`);
        console.log(`   Use polling or manual updates instead.\n`);
        break;
      }
      console.error(`❌ Failed to subscribe to ${resource.name}: ${error}`);
    }
  }

  console.log('\n👂 Listening for updates... (Press Ctrl+C to exit)\n');

  // Keep the process alive
  await new Promise(() => {});
}

// Run the example
subscribeToResourceUpdates().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
