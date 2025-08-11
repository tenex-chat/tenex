import { Command } from "commander";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "@/utils/logger";
import { initNDK, getNDK } from "@/nostr/ndkClient";
import { ProjectManager } from "@/daemon/ProjectManager";
import { getProjectContext } from "@/services/ProjectContext";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Format discovered MCP tools as markdown
 */
function formatMCPToolsAsMarkdown(tools: Array<{
  id: string;
  name: string;
  description?: string;
  command?: string;
  image?: string;
  slug: string;
  authorPubkey: string;
  createdAt?: number;
}>): string {
  if (tools.length === 0) {
    return "## No MCP tools found\n\nNo tools match your search criteria. Try broadening your search or check back later.";
  }

  const lines: string[] = [];
  lines.push(`# MCP Tool Discovery Results`);
  lines.push(`\nFound **${tools.length}** available tool${tools.length === 1 ? '' : 's'}:\n`);

  tools.forEach((tool, index) => {
    lines.push(`## ${index + 1}. ${tool.name}`);
    lines.push(``);
    
    if (tool.description) {
      lines.push(`**Description:** ${tool.description}`);
      lines.push(``);
    }
    
    if (tool.command) {
      lines.push(`**Command:** \`${tool.command}\``);
      lines.push(``);
    }
    
    if (tool.image) {
      lines.push(`**Image:** \`${tool.image}\``);
      lines.push(``);
    }
    
    lines.push(`**Nostr ID:** \`${tool.id}\``);
    lines.push(``);
    
    if (tool.createdAt) {
      const date = new Date(tool.createdAt * 1000).toLocaleString();
      lines.push(`**Created:** ${date}`);
      lines.push(``);
    }
    
    lines.push(`---`);
    lines.push(``);
  });

  // Add installation instructions at the end
  lines.push(`## Installation Instructions`);
  lines.push(``);
  lines.push(`To request installation of any of these tools:`);
  lines.push(`1. Note the **Nostr ID** of the tool you want to install`);
  lines.push(`2. Send a message tagging the human user`);
  lines.push(`3. Include the tool reference using \`nostr:<id>\` format`);
  lines.push(``);
  lines.push(`Example: "I'd like to install the Git Helper tool: nostr:note1xyz..."`);

  return lines.join('\n');
}
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Schema definitions for MCP handlers
const ToolsListRequestSchema = z.object({
    method: z.literal("tools/list"),
});

const ToolsCallRequestSchema = z.object({
    method: z.literal("tools/call"),
    params: z.object({
        name: z.string(),
        arguments: z.any(),
    }),
});

/**
 * Service for managing lessons
 */
class LessonService {
    constructor(
        private ndk: NDK,
        private agent: AgentInstance | null,
        private project: NDKEvent | null
    ) {}

    async createLesson(
        data: { 
            title: string; 
            lesson: string;
            detailed?: string;
            category?: string;
            hashtags?: string[];
        },
        agentEventId: string,
        signer: NDKSigner
    ) {
        const lessonEvent = new NDKAgentLesson(this.ndk);
        lessonEvent.title = data.title;
        lessonEvent.lesson = data.lesson;
        
        // Add optional fields if provided
        if (data.detailed) {
            lessonEvent.detailed = data.detailed;
        }
        if (data.category) {
            lessonEvent.category = data.category;
        }
        if (data.hashtags && data.hashtags.length > 0) {
            lessonEvent.hashtags = data.hashtags;
        }
        
        // Add reference to the agent event if available
        if (agentEventId) {
            const agentEvent = await this.ndk.fetchEvent(agentEventId);
            if (agentEvent) {
                lessonEvent.agent = agentEvent;
            } else {
                logger.warn("Could not fetch agent event for lesson", { agentEventId });
            }
        }
        
        // Add project tag for scoping if available
        if (this.project) {
            lessonEvent.tag(this.project);
        }
        
        await lessonEvent.sign(signer);
        await lessonEvent.publish();
        
        logger.info("✅ Lesson published to Nostr", {
            title: data.title,
            eventId: lessonEvent.id,
            agentEventId,
            hasDetailed: !!data.detailed,
            category: data.category,
            hashtagCount: data.hashtags?.length || 0,
        });
        
        return {
            title: data.title,
            lesson: data.lesson,
            eventId: lessonEvent.id,
            hasDetailed: !!data.detailed,
        };
    }

    async getLessons(filter: { agentPubkey: string }) {
        const lessons = await this.ndk.fetchEvents({
            kinds: [4129],  // Updated to match NDKAgentLesson.kind
            authors: [filter.agentPubkey],
        });
        
        const lessonList = Array.from(lessons).map(event => {
            const lesson = NDKAgentLesson.from(event);
            return {
                title: lesson.title,
                lesson: lesson.lesson,
                detailed: lesson.detailed,
                category: lesson.category,
                hashtags: lesson.hashtags,
                createdAt: lesson.created_at,
                eventId: lesson.id,
            };
        });
        
        return lessonList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
}

export const serverCommand = new Command("server")
    .description("Run MCP server for agent tools")
    .action(async () => {

        try {
            const projectPath = process.cwd();

            // Initialize NDK
            logger.info("Initializing NDK for MCP server...");
            await initNDK();
            const ndk = getNDK();
            
            if (!ndk) {
                throw new Error("NDK is undefined after initialization");
            }
            
            logger.debug("NDK initialized successfully", { 
                hasNdk: !!ndk,
                hasFetchEvent: !!(ndk && ndk.fetchEvent)
            });
            
            // Try to load project context if available, but don't fail if not
            let projectContext: any = null;
            let agents: Map<string, AgentInstance> = new Map();
            let project: NDKEvent | null = null;
            
            try {
                const projectManager = new ProjectManager();
                await projectManager.loadAndInitializeProjectContext(projectPath, ndk);
                projectContext = getProjectContext();
                agents = projectContext.agents;
                project = projectContext.project;
                logger.info("Running MCP server with project context");
            } catch (error: any) {
                if (error?.message?.includes("Project configuration missing projectNaddr")) {
                    logger.info("Running MCP server without project context (standalone mode)");
                } else {
                    // Re-throw if it's a different error
                    throw error;
                }
            }
            
            // NDK is already available from above, no need to redeclare
            
            // Wait a moment for relays to connect
            logger.info("Waiting for relay connections...");
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Log relay status
            const connectedRelays = Array.from(ndk.pool?.relays?.values() || [])
                .filter(relay => relay.status === 1)
                .map(relay => relay.url);
            
            logger.info(`Connected to ${connectedRelays.length} relays:`, connectedRelays);
            
            // Create MCP server
            const server = new Server(
                {
                    name: `tenex-mcp`,
                    version: "1.0.0",
                },
                {
                    capabilities: {
                        tools: {},
                    },
                }
            );

            // Add tools handler
            server.setRequestHandler(ToolsListRequestSchema, async () => {
                return {
                    tools: [
                        {
                            name: "lesson_learn",
                            description: "Record an important lesson learned during execution that should be carried forward, with optional detailed version",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    title: {
                                        type: "string",
                                        description: "Brief title/description of what this lesson is about",
                                    },
                                    lesson: {
                                        type: "string",
                                        description: "The key insight or lesson learned - be concise and actionable",
                                    },
                                    agentSlug: {
                                        type: "string",
                                        description: "The slug identifier of the agent recording this lesson (required when in project context)",
                                    },
                                    nsec: {
                                        type: "string",
                                        description: "The Nostr private key (nsec format) for signing the lesson (required when not in project context)",
                                    },
                                    detailed: {
                                        type: "string",
                                        description: "Detailed version with richer explanation when deeper context is needed",
                                    },
                                    category: {
                                        type: "string",
                                        description: "Single category for filing this lesson (e.g., 'architecture', 'debugging', 'user-preferences')",
                                    },
                                    hashtags: {
                                        type: "array",
                                        items: {
                                            type: "string",
                                        },
                                        description: "Hashtags for easier sorting and discovery (e.g., ['async', 'error-handling'])",
                                    },
                                },
                                required: ["title", "lesson"],
                            },
                        },
                        {
                            name: "get_lessons",
                            description: "Retrieve all lessons learned by this agent",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    agentSlug: {
                                        type: "string",
                                        description: "The slug identifier of the agent whose lessons to retrieve (when in project context)",
                                    },
                                    pubkey: {
                                        type: "string",
                                        description: "The public key (hex format) to retrieve lessons for (when not in project context)",
                                    },
                                },
                                required: [],
                            },
                        },
                        {
                            name: "mcp_discover",
                            description: "Discover MCP tool definitions from the Nostr network that can be installed and used",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    searchText: {
                                        type: "string",
                                        description: "Text to search for in tool name/description",
                                    },
                                    limit: {
                                        type: "number",
                                        description: "Maximum number of tools to return (default: 50)",
                                    },
                                },
                            },
                        },
                        {
                            name: "nostr_projects",
                            description: "Retrieve NDKProject (31933) events and online project status (24010) events for a given pubkey",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    pubkey: {
                                        type: "string",
                                        description: "The public key (hex format) to retrieve projects for",
                                    },
                                },
                                required: ["pubkey"],
                            },
                        },
                    ],
                };
            });

            // Handle tool calls
            server.setRequestHandler(ToolsCallRequestSchema, async (request) => {
                const toolName = request.params.name;
                
                if (toolName === "lesson_learn") {
                    const { title, lesson, detailed, category, hashtags, agentSlug, nsec } = request.params.arguments;

                    let agent: AgentInstance | null = null;
                    let signer: NDKSigner;
                    let agentEventId: string = "";
                    
                    // Determine how to get the signer based on what's provided
                    if (agentSlug && agents.size > 0) {
                        // Project context mode - use agent slug
                        agent = agents.get(agentSlug) || null;
                        if (!agent) {
                            throw new Error(`Agent '${agentSlug}' not found in project`);
                        }
                        if (!agent.signer) {
                            throw new Error(`Agent '${agentSlug}' does not have a signer`);
                        }
                        signer = agent.signer;
                        agentEventId = agent.eventId || "";
                    } else if (nsec) {
                        // Standalone mode - use nsec
                        signer = new NDKPrivateKeySigner(nsec);
                    } else {
                        throw new Error("Either agentSlug (with project context) or nsec is required");
                    }

                    logger.info("🎓 MCP Server: Recording new lesson", {
                        agent: agent?.name || "standalone",
                        agentPubkey: agent?.pubkey || signer.pubkey,
                        title,
                        lessonLength: lesson.length,
                        hasDetailed: !!detailed,
                        category,
                        hashtagCount: hashtags?.length || 0,
                    });

                    try {
                        // Create LessonService instance
                        const lessonService = new LessonService(ndk, agent, project);
                        
                        // Use LessonService to create the lesson
                        const result = await lessonService.createLesson(
                            { title, lesson, detailed, category, hashtags },
                            agentEventId,
                            signer
                        );

                        const message = `✅ Lesson recorded: "${result.title}"${result.hasDetailed ? " (with detailed version)" : ""}\n\nThis lesson will be available in future conversations to help avoid similar issues.`;

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: message,
                                },
                            ],
                        };
                    } catch (error) {
                        logger.error("❌ MCP Server: Learn tool failed", {
                            error,
                            agent: agent?.name || "standalone",
                            agentPubkey: agent?.pubkey || signer.pubkey,
                            title,
                        });
                        throw error;
                    }
                } else if (toolName === "get_lessons") {
                    const { agentSlug, pubkey } = request.params.arguments;
                    
                    let agentPubkey: string;
                    let agent: AgentInstance | null = null;
                    
                    // Determine how to get the pubkey
                    if (agentSlug && agents.size > 0) {
                        // Project context mode - use agent slug
                        agent = agents.get(agentSlug) || null;
                        if (!agent) {
                            throw new Error(`Agent '${agentSlug}' not found in project`);
                        }
                        agentPubkey = agent.pubkey;
                    } else if (pubkey) {
                        // Standalone mode - use provided pubkey
                        agentPubkey = pubkey;
                    } else {
                        throw new Error("Either agentSlug (with project context) or pubkey is required");
                    }
                    
                    try {
                        logger.info("📚 MCP Server: Fetching lessons", {
                            agent: agent?.name || "standalone",
                            agentPubkey,
                        });

                        // Create LessonService instance
                        const lessonService = new LessonService(ndk, agent, project);
                        
                        // Use LessonService to fetch lessons
                        const lessons = await lessonService.getLessons({
                            agentPubkey,
                        });

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(lessons, null, 2),
                                },
                            ],
                        };
                    } catch (error) {
                        logger.error("❌ MCP Server: Get lessons failed", {
                            error,
                            agent: agent?.name || "standalone",
                            agentPubkey,
                        });
                        throw error;
                    }
                } else if (toolName === "mcp_discover") {
                    const { searchText, limit = 50 } = request.params.arguments;
                    
                    logger.info("🔍 MCP Server: Discovering MCP tools", {
                        searchText,
                        limit,
                    });

                    try {
                        // Fetch MCP tool events (kind 4200)
                        const mcpToolEvents = await ndk.fetchEvents({
                            kinds: [NDKMCPTool.kinds[0]],
                            limit,
                        });

                        // Convert to NDKMCPTool instances and extract metadata
                        let tools = Array.from(mcpToolEvents).map(event => {
                            const mcpTool = NDKMCPTool.from(event);
                            
                            return {
                                id: mcpTool.encode(),
                                name: mcpTool.name || "Unnamed Tool",
                                description: mcpTool.description,
                                command: mcpTool.command,
                                image: mcpTool.image,
                                slug: mcpTool.slug,
                                authorPubkey: mcpTool.pubkey,
                                createdAt: mcpTool.created_at,
                            };
                        });

                        // Apply local filtering if specified
                        if (searchText) {
                            const searchLower = searchText.toLowerCase();
                            tools = tools.filter(tool => {
                                const searchableText = [
                                    tool.name,
                                    tool.description || "",
                                    tool.command || ""
                                ].join(" ").toLowerCase();
                                
                                return searchableText.includes(searchLower);
                            });
                        }

                        // Sort by creation time (newest first)
                        tools.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                        // Format as markdown
                        const markdown = formatMCPToolsAsMarkdown(tools);

                        logger.info("✅ MCP Server: MCP tools discovered successfully", {
                            toolsFound: tools.length,
                        });

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: markdown,
                                },
                            ],
                        };
                    } catch (error) {
                        logger.error("❌ MCP Server: MCP discover failed", {
                            error,
                            searchText,
                            limit,
                        });
                        throw error;
                    }
                } else if (toolName === "nostr_projects") {
                    const { pubkey } = request.params.arguments;
                    
                    logger.info("🔍 MCP Server: Fetching projects for pubkey", {
                        pubkey,
                    });

                    try {
                        // Fetch both kinds of events in parallel
                        const [projectEvents, statusEvents] = await Promise.all([
                            // Fetch 31933 events (NDKProject)
                            ndk.fetchEvents({
                                kinds: [31933],
                                authors: [pubkey],
                            }),
                            // Fetch 24010 events (project status - online agents)
                            ndk.fetchEvents({
                                kinds: [24010],
                                "#p": [pubkey],
                            }),
                        ]);

                        // Build a map of online agents by project
                        const onlineAgentsByProject = new Map<string, Record<string, string>>();
                        
                        // Process status events to find online agents
                        Array.from(statusEvents).forEach(event => {
                            const projectPubkey = event.tagValue("p");
                            if (projectPubkey === pubkey) {
                                // Get agent tags from the 24010 event
                                const agentTags = event.tags.filter(tag => tag[0] === "agent");
                                const agents: Record<string, string> = {};
                                
                                agentTags.forEach(tag => {
                                    // agent tag format: ["agent", "<pubkey>", "<slug>"]
                                    if (tag.length >= 3) {
                                        const [, agentPubkey, agentSlug] = tag;
                                        agents[agentSlug] = agentPubkey;
                                    }
                                });
                                
                                // Store agents for this project
                                if (Object.keys(agents).length > 0) {
                                    onlineAgentsByProject.set(projectPubkey, agents);
                                }
                            }
                        });

                        // Process project events (31933)
                        const projects = Array.from(projectEvents).map(projectEvent => {
                            const title = projectEvent.tagValue("title") || projectEvent.tagValue("name");
                            const description = projectEvent.tagValue("description");
                            const website = projectEvent.tagValue("website");
                            const repository = projectEvent.tagValue("repository");
                            const image = projectEvent.tagValue("image");
                            
                            // Check if this project has online agents
                            const isOnline = onlineAgentsByProject.has(projectEvent.pubkey);
                            const onlineAgents = isOnline ? onlineAgentsByProject.get(projectEvent.pubkey) : undefined;
                            
                            // Get the encoded project ID
                            const projectId = projectEvent.encode();
                            
                            return {
                                id: projectId,
                                title,
                                description,
                                website,
                                repository,
                                image,
                                online: isOnline,
                                agents: onlineAgents,
                                pubkey: projectEvent.pubkey,
                                createdAt: projectEvent.created_at,
                            };
                        });

                        // Sort projects by creation time (newest first)
                        projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                        const result = {
                            projects,
                            summary: {
                                totalProjects: projects.length,
                                onlineProjects: projects.filter(p => p.online).length,
                                offlineProjects: projects.filter(p => !p.online).length,
                            },
                        };

                        logger.info("✅ MCP Server: Projects fetched successfully", {
                            pubkey,
                            projectCount: projects.length,
                            onlineCount: result.summary.onlineProjects,
                        });

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result, null, 2),
                                },
                            ],
                        };
                    } catch (error) {
                        logger.error("❌ MCP Server: Fetch projects failed", {
                            error,
                            pubkey,
                        });
                        throw error;
                    }
                } else {
                    throw new Error(`Unknown tool: ${toolName}`);
                }
            });

            // Start the server
            const transport = new StdioServerTransport();
            await server.connect(transport);

            logger.info(`MCP server started`);

            // Keep the process alive
            process.on("SIGINT", async () => {
                await server.close();
                process.exit(0);
            });
        } catch (error: any) {
            logger.error("Failed to start MCP server:", error);
            process.exit(1);
        }
    });