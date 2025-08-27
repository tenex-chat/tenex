import { getNDK } from "@/nostr";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema, failure, success } from "../types";

const createProjectSchema = z.object({
  title: z.string().describe("The title/name of the project"),
  description: z.string().optional().describe("Description of the project"),
  repository: z.string().optional().describe("Repository URL for the project"),
  image: z.string().optional().describe("Image URL for the project"),
  tags: z.array(z.string()).optional().describe("Additional tags for the project"),
  agents: z.array(z.string()).optional().describe("Array of agent definition event IDs to include in the project"),
  mcpServers: z.array(z.string()).optional().describe("Array of MCP announcement event IDs to include in the project"),
});

interface CreateProjectInput {
  title: string;
  description?: string;
  repository?: string;
  image?: string;
  tags?: string[];
  agents?: string[];
  mcpServers?: string[];
}

interface CreateProjectOutput {
  id: string;
}

/**
 * Create Project tool - publishes a new NDKProject event to Nostr
 * Not available to any agent by default - must be explicitly assigned
 */
export const createProjectTool: Tool<CreateProjectInput, CreateProjectOutput> = {
  name: "create-project",
  description: "Create and publish a new NDKProject event to Nostr",

  promptFragment: `Create a new NDKProject event and publish it to Nostr.

This tool allows agents to create new projects.
The project will be published using the current agent's signer.

Required:
- title: The project name
- description: Project description

Optional:
- repository: Git repository URL
- image: Project image URL
- tags: Additional tags for categorization
- agents: Array of agent definition event IDs (format: "nevent1..." or "note1...")
- mcpServers: Array of MCP announcement event IDs (format: "nevent1..." or "note1...")

To find available agents and MCP servers:
- Use agents_discover() to search for agent definitions on Nostr
- Use discover_capabilities() to find MCP server announcements

The created project will be a kind 31933 replaceable event.`,

  parameters: createZodSchema(createProjectSchema),

  execute: async (input, context) => {
    const { title, description, repository, image, tags, agents, mcpServers } = input.value;

    const ndk = getNDK();
    if (!ndk) {
      const error = "NDK instance not available";
      logger.error("❌ Create project failed", {
        error,
        agent: context.agent.name,
      });
      return failure({
        kind: "execution",
        tool: "create_project",
        message: error,
      });
    }

    logger.info("📝 Creating new NDKProject", {
      title,
      agent: context.agent.name,
      conversationId: context.conversationId,
    });

    try {
      // Create a new NDKProject event
      const project = new NDKProject(ndk);
      
      // Set project metadata
      project.title = title;
      
      if (description) {
        project.description = description;
      }
      
      if (repository) {
        project.repo = repository;
      }
      
      if (image) {
        project.picture = image;
      }
      
      // Add any additional tags
      if (tags && tags.length > 0) {
        tags.forEach(tag => {
          // Add as generic "t" tags for categorization
          project.tags.push(["t", tag]);
        });
      }

      // Add agent event IDs
      if (agents && agents.length > 0) {
        agents.forEach(agentEventId => {
          // Strip "nostr:" prefix if present (common mistake)
          const cleanEventId = agentEventId.startsWith("nostr:") 
            ? agentEventId.substring(6) 
            : agentEventId;
          // Add agent tags with event ID
          project.tags.push(["agent", cleanEventId]);
        });
      }

      // Add MCP server event IDs
      if (mcpServers && mcpServers.length > 0) {
        mcpServers.forEach(mcpEventId => {
          // Strip "nostr:" prefix if present (common mistake)
          const cleanEventId = mcpEventId.startsWith("nostr:") 
            ? mcpEventId.substring(6) 
            : mcpEventId;
          // Add mcp tags with event ID
          project.tags.push(["mcp", cleanEventId]);
        });
      }

      // The project will be published with the agent's pubkey as the author
      // This is typically the project-manager agent creating projects
      
      // Sign and publish the event
      await project.sign(context.agent.signer);
      await project.publish();

      logger.info("✅ NDKProject created successfully", {
        title,
        projectId: project.encode(),
        agent: context.agent.name,
      });

      const result: CreateProjectOutput = {
        id: `nostr:${project.encode()}`,
      };

      return success(result);
    } catch (error) {
      const errorMessage = formatAnyError(error);
      logger.error("❌ Failed to create NDKProject", {
        error: errorMessage,
        title,
        agent: context.agent.name,
      });

      return failure({
        kind: "execution",
        tool: "create_project",
        message: `Failed to create project: ${errorMessage}`,
      });
    }
  },
};