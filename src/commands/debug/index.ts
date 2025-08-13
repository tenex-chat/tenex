import { AgentRegistry } from "@/agents/AgentRegistry";
import { ALL_PHASES, type Phase } from "@/conversations/phases";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import type { Tool } from "@/tools/types";
import { formatAnyError } from "@/utils/error-formatter";
import { logError, logInfo } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import chalk from "chalk";
import { formatMarkdown, colorizeJSON } from "@/utils/formatting";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

// Format content with enhancements
function formatContentWithEnhancements(content: string, isSystemPrompt = false): string {
    let formattedContent = content.replace(/\\n/g, "\n");

    if (isSystemPrompt) {
        formattedContent = formatMarkdown(formattedContent);
    }

    // Handle <tool_use> blocks
    formattedContent = formattedContent.replace(
        /<tool_use>([\s\S]*?)<\/tool_use>/g,
        (_match, jsonContent) => {
            try {
                const parsed = JSON.parse(jsonContent.trim());
                const formatted = JSON.stringify(parsed, null, 2);
                return (
                    chalk.gray("<tool_use>\n") +
                    colorizeJSON(formatted) +
                    chalk.gray("\n</tool_use>")
                );
            } catch {
                return chalk.gray("<tool_use>") + jsonContent + chalk.gray("</tool_use>");
            }
        }
    );

    return formattedContent;
}

interface DebugSystemPromptOptions {
    agent: string;
    phase: string;
}

export async function runDebugSystemPrompt(options: DebugSystemPromptOptions): Promise<void> {
    try {
        const projectPath = process.cwd();

        // Initialize project context if needed
        await ensureProjectInitialized(projectPath);

        // Load agent from registry
        const agentRegistry = new AgentRegistry(projectPath, false);
        await agentRegistry.loadFromProject();
        const agent = agentRegistry.getAgent(options.agent);

        console.log(chalk.cyan("\n=== Agent Information ==="));
        if (agent) {
            console.log(chalk.white("Name:"), agent.name);
            console.log(chalk.white("Role:"), agent.role);
            console.log(chalk.white("Phase:"), options.phase);
            if (agent.tools && agent.tools.length > 0) {
                console.log(chalk.white("Tools:"), agent.tools.map((t) => t.name).join(", "));
            }
        } else {
            console.log(chalk.yellow(`Note: Agent '${options.agent}' not found in registry`));
        }

        console.log(chalk.cyan("\n=== System Prompt ==="));

        if (agent) {
            const projectCtx = getProjectContext();
            const project = projectCtx.project;
            const titleTag = project.tags.find((tag) => tag[0] === "title");
            const repoTag = project.tags.find((tag) => tag[0] === "repo");

            // Get all available agents for handoffs
            const availableAgents = Array.from(projectCtx.agents.values());

            // Validate phase
            const phase = (
                ALL_PHASES.includes(options.phase as Phase) ? options.phase : "chat"
            ) as Phase;

            // Initialize MCP service to get tools
            let mcpTools: Tool[] = [];
            try {
                await mcpService.initialize(projectPath);
                mcpTools = mcpService.getCachedTools();
                logInfo(`Loaded ${mcpTools.length} MCP tools`);
            } catch (error) {
                logError(`Failed to initialize MCP service: ${error}`);
                // Continue without MCP tools - don't fail the whole debug command
            }

            // Build system prompt using the shared function - exactly as production does
            // Only pass the current agent's lessons
            const agentLessonsMap = new Map<
                string,
                NDKAgentLesson[]
            >();
            const currentAgentLessons = projectCtx.getLessonsForAgent(agent.pubkey);
            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(agent.pubkey, currentAgentLessons);
            }

            const systemMessages = buildSystemPromptMessages({
                agent,
                phase,
                project: projectCtx.project,
                availableAgents,
                conversation: undefined, // No conversation in debug mode
                agentLessons: agentLessonsMap,
                mcpTools,
            });

            // Display each system message separately with metadata
            console.log(chalk.bold.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
            console.log(chalk.bold.cyan("                    SYSTEM PROMPT MESSAGES"));
            console.log(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
            
            for (let i = 0; i < systemMessages.length; i++) {
                const msg = systemMessages[i];
                
                // Display message metadata
                console.log(chalk.bold.yellow(`\n─── Message ${i + 1} ───`));
                if (msg.metadata?.description) {
                    console.log(chalk.dim(`Description: ${msg.metadata.description}`));
                }
                if (msg.metadata?.cacheable) {
                    console.log(chalk.green(`✓ Cacheable (key: ${msg.metadata.cacheKey})`));
                }
                console.log();
                
                // Format and display message content
                const formattedContent = formatContentWithEnhancements(msg.message.content, true);
                console.log(formattedContent);
                
                if (i < systemMessages.length - 1) {
                    console.log(chalk.dim("\n" + "─".repeat(60) + "\n"));
                }
            }
            
            console.log(chalk.bold.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
        } else {
            console.log(chalk.yellow(`Agent '${options.agent}' not found in registry`));
        }

        console.log(chalk.cyan("===================\n"));

        logInfo("System prompt displayed successfully");
        process.exit(0);
    } catch (err) {
        const errorMessage = formatAnyError(err);
        logError(`Failed to generate system prompt: ${errorMessage}`);
        process.exit(1);
    }
}
