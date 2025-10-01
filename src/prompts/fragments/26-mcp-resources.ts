import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { experimental_MCPResource, experimental_MCPResourceTemplate } from "ai";

interface ResourcesPerServer {
  serverName: string;
  resources: experimental_MCPResource[];
  templates: experimental_MCPResourceTemplate[];
}

interface McpResourcesFragmentArgs {
  agentPubkey: string;
  mcpEnabled: boolean;
  resourcesPerServer: ResourcesPerServer[];
}

/**
 * Format a single resource for display
 */
function formatResource(
  resource: { uri: string; name: string; description?: string; mimeType?: string },
  serverName: string
): string {
  const lines: string[] = [];
  lines.push(`- **${resource.name}** (\`${resource.uri}\`)`);
  if (resource.description) {
    lines.push(`  ${resource.description}`);
  }
  lines.push(`  Server: ${serverName}`);
  if (resource.mimeType) {
    lines.push(`  Type: ${resource.mimeType}`);
  }
  return lines.join('\n');
}

/**
 * Format a resource template for display
 */
function formatTemplate(
  template: { uriTemplate: string; name: string; description?: string; mimeType?: string },
  serverName: string
): string {
  const lines: string[] = [];
  lines.push(`- **${template.name}** (\`${template.uriTemplate}\`) *[Template]*`);
  if (template.description) {
    lines.push(`  ${template.description}`);
  }
  lines.push(`  Server: ${serverName}`);

  // Extract parameter names from template
  const params = template.uriTemplate.match(/\{([^}]+)\}/g);
  if (params) {
    const paramNames = params.map(p => p.slice(1, -1)).join(', ');
    lines.push(`  **Required parameters:** ${paramNames}`);
    lines.push(`  **Note:** Expand this template with actual values before subscribing`);
  }

  if (template.mimeType) {
    lines.push(`  Type: ${template.mimeType}`);
  }
  return lines.join('\n');
}

/**
 * MCP Resources fragment - shows available resources for RAG subscription
 */
export const mcpResourcesFragment: PromptFragment<McpResourcesFragmentArgs> = {
  id: "mcp-resources",
  priority: 26,

  template: (args: McpResourcesFragmentArgs): string => {
    if (!args.mcpEnabled || args.resourcesPerServer.length === 0) {
      return ''; // Don't show if MCP is disabled or no resources
    }

    // Check if there are any actual resources or templates across all servers
    const hasAnyResources = args.resourcesPerServer.some(
      server => server.resources.length > 0 || server.templates.length > 0
    );

    if (!hasAnyResources) {
      return ''; // Don't show fragment if no resources available
    }

    const sections: string[] = [];
    const serverNames = args.resourcesPerServer.map(s => s.serverName);
    sections.push('# Available MCP Resources for RAG Subscription\n');
    sections.push(`You have access to MCP resources from ${serverNames.length} server${serverNames.length === 1 ? '' : 's'}: ${serverNames.join(', ')}\n`);

    let totalResources = 0;
    let totalTemplates = 0;

    for (const serverData of args.resourcesPerServer) {
      const { serverName, resources, templates } = serverData;

      if (resources.length === 0 && templates.length === 0) {
        continue; // Skip servers with no resources
      }

      sections.push(`## Server: ${serverName}\n`);

      // Direct resources
      if (resources.length > 0) {
        sections.push('### Direct Resources (ready to subscribe)\n');
        for (const resource of resources) {
          sections.push(formatResource(resource, serverName));
          sections.push('');
        }
        totalResources += resources.length;
      }

      // Resource templates
      if (templates.length > 0) {
        sections.push('### Resource Templates (require parameter expansion)\n');
        for (const template of templates) {
          sections.push(formatTemplate(template, serverName));
          sections.push('');
        }
        totalTemplates += templates.length;
      }

      sections.push('---\n');
    }

    // Add usage instructions
    sections.push('## How to Subscribe to Resources\n');
    sections.push('Use the `rag_subscription_create` tool with the following parameters:\n');
    sections.push('- **subscriptionId**: Unique ID for your subscription (e.g., "global-feed")');
    sections.push('- **mcpServerId**: The server name shown above (e.g., "nostr-provider")');
    sections.push('- **resourceUri**: The exact URI shown in parentheses above');
    sections.push('- **ragCollection**: Name of the RAG collection to ingest updates into');
    sections.push('- **description**: What this subscription does\n');

    sections.push('**For templates:** You must expand the URI template by replacing `{parameter}` placeholders with actual values.');
    sections.push('For example: `nostr://feed/{pubkey}/1` → `nostr://feed/abc123.../1`\n');

    sections.push(`**Summary:** ${totalResources} direct resource${totalResources === 1 ? '' : 's'}, ${totalTemplates} template${totalTemplates === 1 ? '' : 's'} available`);

    return sections.join('\n');
  },

  validateArgs: (args: unknown): args is McpResourcesFragmentArgs => {
    return (
      typeof args === 'object' &&
      args !== null &&
      'agentPubkey' in args &&
      'mcpEnabled' in args &&
      'resourcesPerServer' in args &&
      typeof (args as McpResourcesFragmentArgs).agentPubkey === 'string' &&
      typeof (args as McpResourcesFragmentArgs).mcpEnabled === 'boolean' &&
      Array.isArray((args as McpResourcesFragmentArgs).resourcesPerServer)
    );
  },

  expectedArgs: "{ agentPubkey: string, mcpEnabled: boolean, resourcesPerServer: ResourcesPerServer[] }"
};

// Auto-register the fragment
fragmentRegistry.register(mcpResourcesFragment);
