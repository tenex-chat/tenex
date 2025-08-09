import { Command } from "commander";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "@/utils/logger";
import { initNDK } from "@/nostr/ndkClient";
import { ProjectManager } from "@/daemon/ProjectManager";
import { getProjectContext } from "@/services/ProjectContext";
import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import type { Agent } from "@/agents/types";

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
        private agent: Agent
    ) {}

    async createLesson(
        data: { title: string; lesson: string },
        agentEventId: string,
        signer: NDKSigner
    ) {
        const lessonEvent = new NDKAgentLesson(this.ndk);
        lessonEvent.title = data.title;
        lessonEvent.lesson = data.lesson;
        lessonEvent.agentEventId = agentEventId;
        
        await lessonEvent.sign(signer);
        await lessonEvent.publish();
        
        logger.info("✅ Lesson published to Nostr", {
            title: data.title,
            eventId: lessonEvent.id,
            agentEventId,
        });
        
        return {
            title: data.title,
            lesson: data.lesson,
            eventId: lessonEvent.id,
        };
    }

    async getLessons(filter: { agentPubkey: string }) {
        const lessons = await this.ndk.fetchEvents({
            kinds: [31338],
            authors: [filter.agentPubkey],
        });
        
        const lessonList = Array.from(lessons).map(event => {
            const lesson = NDKAgentLesson.from(event);
            return {
                title: lesson.title,
                lesson: lesson.lesson,
                createdAt: lesson.created_at,
                eventId: lesson.id,
            };
        });
        
        return lessonList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
}

export const serverCommand = new Command("server")
    .description("Run MCP server for agent tools")
    .requiredOption("--agent <slug>", "Agent slug to run the server for")
    .action(async (options) => {
        const { agent: agentSlug } = options;

        try {
            const projectPath = process.cwd();

            // Initialize NDK
            logger.info("Initializing NDK for MCP server...");
            await initNDK();
            
            // Use ProjectManager to properly load and initialize the project
            const projectManager = new ProjectManager();
            await projectManager.loadAndInitializeProjectContext(projectPath);
            
            // Get the project context which now has all agents loaded
            const projectContext = getProjectContext();
            const { agents } = projectContext;
            
            // Find the specific agent
            const agent = agents.get(agentSlug);
            if (!agent) {
                throw new Error(`Agent '${agentSlug}' not found in project`);
            }
            
            if (!agent.signer) {
                throw new Error(`Agent '${agentSlug}' does not have a signer`);
            }
            
            // Get NDK from project context
            const ndk = projectContext.project.ndk;
            
            // Wait a moment for relays to connect
            logger.info("Waiting for relay connections...");
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Log relay status
            const connectedRelays = Array.from(ndk.pool?.relays?.values() || [])
                .filter(relay => relay.status === 1)
                .map(relay => relay.url);
            
            logger.info(`Connected to ${connectedRelays.length} relays:`, connectedRelays);
            
            // Create LessonService instance
            const lessonService = new LessonService(ndk, agent);

            // Create MCP server
            const server = new Server(
                {
                    name: `tenex-${agentSlug}`,
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
                            name: "learn",
                            description: "Record an important lesson learned during execution that should be carried forward",
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
                                },
                                required: ["title", "lesson"],
                            },
                        },
                        {
                            name: "get_lessons",
                            description: "Retrieve all lessons learned by this agent",
                            inputSchema: {
                                type: "object",
                                properties: {},
                            },
                        },
                    ],
                };
            });

            // Handle tool calls
            server.setRequestHandler(ToolsCallRequestSchema, async (request) => {
                const toolName = request.params.name;
                
                if (toolName === "learn") {
                    const { title, lesson } = request.params.arguments;

                    logger.info("🎓 MCP Server: Agent recording new lesson", {
                        agent: agent.name,
                        agentPubkey: agent.pubkey,
                        title,
                        lessonLength: lesson.length,
                    });

                    try {
                        // Use LessonService to create the lesson
                        const result = await lessonService.createLesson(
                            { title, lesson },
                            agent.eventId,
                            agent.signer
                        );

                        const message = `✅ Lesson recorded: "${result.title}"\n\nThis lesson will be available in future conversations to help avoid similar issues.`;

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
                            agent: agent.name,
                            agentPubkey: agent.pubkey,
                            title,
                        });
                        throw error;
                    }
                } else if (toolName === "get_lessons") {
                    try {
                        logger.info("📚 MCP Server: Fetching lessons for agent", {
                            agent: agent.name,
                            agentPubkey: agent.pubkey,
                        });

                        // Use LessonService to fetch lessons
                        const lessons = await lessonService.getLessons({
                            agentPubkey: agent.pubkey,
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
                            agent: agent.name,
                            agentPubkey: agent.pubkey,
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

            logger.info(`MCP server started for agent '${agentSlug}'`);

            // Keep the process alive
            process.on("SIGINT", async () => {
                await server.close();
                process.exit(0);
            });
        } catch (error) {
            logger.error("Failed to start MCP server:", error);
            process.exit(1);
        }
    });