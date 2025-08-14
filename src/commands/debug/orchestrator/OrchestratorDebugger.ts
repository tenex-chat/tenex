import { v4 as uuidv4 } from 'uuid';
import type { Phase } from "@/conversations/phases";
import { PHASES, isValidPhase, getValidTransitions } from "@/conversations/phases";
import type { 
    OrchestratorDebugState, 
    DebugAction, 
    SimulatedCompletion 
} from "./types";
import type { 
    RoutingEntry, 
    OrchestratorTurn, 
    Completion 
} from "@/conversations/types";
import { OrchestratorDebugUI } from "./OrchestratorDebugUI";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { ConversationManager } from "@/conversations/ConversationManager";
import { initNDK, getNDK } from "@/nostr/ndkClient";
import { loadLLMRouter } from "@/llm";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { logger } from "@/utils/logger";
import chalk from "chalk";
import { formatAnyError } from "@/utils/error-formatter";
import { findAgentByName } from "@/agents/utils";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ProjectManager } from "@/daemon/ProjectManager";

export class OrchestratorDebugger {
    private state: OrchestratorDebugState;
    private ui: OrchestratorDebugUI;
    private conversationManager?: ConversationManager;
    private agentExecutor?: AgentExecutor;
    private lastAction?: DebugAction;

    constructor() {
        // Initialize with empty state
        this.state = {
            userRequest: "",
            phase: PHASES.CHAT,
            routingHistory: [],
            currentRouting: null,
            orchestratorTurns: [],
            agentStates: new Map(),
            metadata: {},
            conversationId: `debug-${Date.now()}`
        };
        
        this.ui = new OrchestratorDebugUI();
    }

    async initialize(): Promise<void> {
        // Initialize NDK and services
        await initNDK();
        const ndk = getNDK();
        
        // Initialize project context if not already initialized
        if (!isProjectContextInitialized()) {
            // Use the existing ProjectManager to properly load everything
            const projectPath = process.cwd();
            const projectManager = new ProjectManager();
            await projectManager.loadAndInitializeProjectContext(projectPath, ndk);
        }
        
        const projectPath = process.cwd();
        const llmRouter = await loadLLMRouter(projectPath);
        this.conversationManager = new ConversationManager(projectPath);
        this.agentExecutor = new AgentExecutor(llmRouter, ndk, this.conversationManager);
    }

    async run(): Promise<void> {
        await this.initialize();
        
        logger.info(chalk.cyan("\n🎭 Orchestrator Debug Tool\n"));
        logger.info(chalk.gray("Test orchestrator routing decisions with custom state\n"));

        while (true) {
            this.ui.displayState(this.state);
            const action = await this.ui.promptMainAction(this.state, this.lastAction);
            
            this.lastAction = action;
            
            try {
                switch (action) {
                    case 'user-message':
                        await this.editUserMessage();
                        break;
                    case 'add-completion':
                        await this.simulateCompletion();
                        break;
                    case 'change-phase':
                        await this.changePhase();
                        break;
                    case 'edit-history':
                        await this.editRoutingHistory();
                        break;
                    case 'inject-turn':
                        await this.injectOrchestratorTurn();
                        break;
                    case 'clear-state':
                        await this.clearState();
                        break;
                    case 'load-conversation':
                        await this.loadFromConversation();
                        break;
                    case 'run-orchestrator':
                        await this.runOrchestrator();
                        break;
                    case 'debug-reasoning':
                        await this.debugReasoning();
                        break;
                    case 'list-agents':
                        await this.listAgents();
                        break;
                    case 'export-state':
                        await this.exportState();
                        break;
                    case 'show-context':
                        await this.showOrchestratorContext();
                        break;
                    case 'exit':
                        logger.info(chalk.gray("\nExiting orchestrator debug tool\n"));
                        return;
                }
            } catch (error) {
                logger.error(chalk.red(`Error: ${formatAnyError(error)}`));
            }
        }
    }

    private async editUserMessage(): Promise<void> {
        const message = await this.ui.promptUserMessage(this.state.userRequest);
        this.state.userRequest = message;
        
        // Set original request if not already set
        if (!this.state.originalRequest) {
            this.state.originalRequest = message;
        }
        
        logger.info(chalk.green("✓ User message updated"));
    }

    private async simulateCompletion(): Promise<void> {
        const projectCtx = getProjectContext();
        const agents = Array.from(projectCtx.agents.values());
        
        if (agents.length === 0) {
            logger.warn(chalk.yellow("No agents available in project"));
            return;
        }

        const completion = await this.ui.promptAgentCompletion(agents);
        
        // Add to current routing if exists and agent is expected
        if (this.state.currentRouting) {
            if (this.state.currentRouting.agents.includes(completion.agentSlug)) {
                const completionEntry: Completion = {
                    agent: completion.agentSlug,
                    message: completion.response,
                    timestamp: completion.timestamp || Date.now()
                };
                
                this.state.currentRouting.completions.push(completionEntry);
                
                // Check if all agents have completed
                const completedAgents = new Set(
                    this.state.currentRouting.completions.map(c => c.agent)
                );
                
                if (this.state.currentRouting.agents.every(a => completedAgents.has(a))) {
                    // Move to history
                    this.state.routingHistory.push(this.state.currentRouting);
                    this.state.currentRouting = null;
                    logger.info(chalk.green("✓ All agents completed, routing moved to history"));
                } else {
                    const remaining = this.state.currentRouting.agents.filter(
                        a => !completedAgents.has(a)
                    );
                    logger.info(chalk.green(`✓ Completion added. Waiting for: ${remaining.join(', ')}`));
                }
            } else {
                logger.warn(chalk.yellow(`Agent ${completion.agentSlug} not in current routing`));
                
                // Ask if they want to add it anyway
                const addAnyway = await this.ui.confirm("Add completion anyway?");
                if (addAnyway) {
                    const completionEntry: Completion = {
                        agent: completion.agentSlug,
                        message: completion.response,
                        timestamp: completion.timestamp || Date.now()
                    };
                    this.state.currentRouting.completions.push(completionEntry);
                    logger.info(chalk.green("✓ Completion added"));
                }
            }
        } else {
            logger.warn(chalk.yellow("No current routing. Create one with 'Inject Orchestrator Turn' first"));
        }
    }

    private async changePhase(): Promise<void> {
        const validTransitions = getValidTransitions(this.state.phase);
        const newPhase = await this.ui.promptPhaseChange(this.state.phase, validTransitions);
        
        if (newPhase) {
            const reason = await this.ui.promptTransitionReason();
            
            // If there's a current routing, complete it first
            if (this.state.currentRouting) {
                this.state.routingHistory.push(this.state.currentRouting);
                this.state.currentRouting = null;
            }
            
            this.state.phase = newPhase;
            logger.info(chalk.green(`✓ Phase changed to ${newPhase}`));
            
            if (reason) {
                logger.info(chalk.gray(`  Reason: ${reason}`));
            }
        }
    }

    private async editRoutingHistory(): Promise<void> {
        if (this.state.routingHistory.length === 0) {
            logger.info(chalk.yellow("No routing history to edit"));
            return;
        }

        const action = await this.ui.promptHistoryAction(this.state.routingHistory);
        
        if (action.type === 'delete' && action.index !== undefined) {
            this.state.routingHistory.splice(action.index, 1);
            logger.info(chalk.green("✓ Entry deleted"));
        } else if (action.type === 'edit' && action.index !== undefined) {
            const entry = this.state.routingHistory[action.index];
            const edited = await this.ui.editRoutingEntry(entry);
            this.state.routingHistory[action.index] = edited;
            logger.info(chalk.green("✓ Entry updated"));
        }
    }

    private async injectOrchestratorTurn(): Promise<void> {
        const projectCtx = getProjectContext();
        const agents = Array.from(projectCtx.agents.values());
        
        const turn = await this.ui.promptOrchestratorTurn(agents, this.state.phase);
        
        if (turn.isCompleted) {
            // Add to history
            const routingEntry: RoutingEntry = {
                phase: turn.phase,
                agents: turn.agents,
                completions: turn.completions,
                reason: turn.reason,
                timestamp: turn.timestamp
            };
            this.state.routingHistory.push(routingEntry);
            logger.info(chalk.green("✓ Completed turn added to history"));
        } else {
            // Set as current routing
            this.state.currentRouting = {
                phase: turn.phase,
                agents: turn.agents,
                completions: turn.completions,
                reason: turn.reason,
                timestamp: turn.timestamp
            };
            logger.info(chalk.green("✓ Turn set as current routing"));
        }
        
        // Also add to orchestratorTurns for completeness
        this.state.orchestratorTurns.push(turn);
    }

    private async clearState(): Promise<void> {
        const confirm = await this.ui.confirm("Clear all state and start fresh?");
        
        if (confirm) {
            this.state = {
                userRequest: "",
                phase: PHASES.CHAT,
                routingHistory: [],
                currentRouting: null,
                orchestratorTurns: [],
                agentStates: new Map(),
                metadata: {},
                conversationId: `debug-${Date.now()}`
            };
            logger.info(chalk.green("✓ State cleared"));
        }
    }

    private async loadFromConversation(): Promise<void> {
        const conversationId = await this.ui.promptConversationId();
        
        if (!this.conversationManager) {
            logger.error(chalk.red("Conversation manager not initialized"));
            return;
        }

        try {
            const conversation = await this.conversationManager.getConversation(conversationId);
            
            if (!conversation) {
                logger.error(chalk.red(`Conversation ${conversationId} not found`));
                return;
            }

            // Extract state from conversation
            this.state = {
                userRequest: conversation.metadata.last_user_message || "",
                originalRequest: conversation.history[0]?.content || "",
                phase: conversation.phase,
                routingHistory: [],
                currentRouting: null,
                orchestratorTurns: conversation.orchestratorTurns,
                agentStates: conversation.agentStates,
                metadata: conversation.metadata,
                conversationId: conversation.id,
                loadedFrom: conversationId
            };

            // Build routing history from orchestrator turns
            for (const turn of conversation.orchestratorTurns) {
                if (turn.isCompleted) {
                    this.state.routingHistory.push({
                        phase: turn.phase,
                        agents: turn.agents,
                        completions: turn.completions,
                        reason: turn.reason,
                        timestamp: turn.timestamp
                    });
                } else {
                    this.state.currentRouting = {
                        phase: turn.phase,
                        agents: turn.agents,
                        completions: turn.completions,
                        reason: turn.reason,
                        timestamp: turn.timestamp
                    };
                }
            }

            logger.info(chalk.green(`✓ Loaded conversation ${conversationId}`));
            logger.info(chalk.gray(`  ${this.state.routingHistory.length} completed routings`));
            logger.info(chalk.gray(`  Current phase: ${this.state.phase}`));
        } catch (error) {
            logger.error(chalk.red(`Failed to load conversation: ${formatAnyError(error)}`));
        }
    }

    private async runOrchestrator(): Promise<void> {
        if (!this.state.userRequest) {
            logger.warn(chalk.yellow("Please set a user message first"));
            return;
        }

        const context = this.buildOrchestratorContext();
        
        // Show the context that will be sent
        logger.info(chalk.cyan("\n📋 Orchestrator Context:"));
        logger.info(chalk.gray(JSON.stringify(context, null, 2)));

        try {
            // Get the orchestrator agent
            const projectCtx = getProjectContext();
            const orchestrator = Array.from(projectCtx.agents.values()).find(a => a.isOrchestrator);
            
            if (!orchestrator) {
                logger.error(chalk.red("No orchestrator agent found in project"));
                return;
            }

            // Create a mock triggering event
            const mockEvent: Partial<NDKEvent> = {
                content: this.state.userRequest,
                kind: 14,
                tags: [["t", "user"]],
                created_at: Math.floor(Date.now() / 1000)
            };

            // Run the orchestrator's routing backend
            logger.info(chalk.cyan("\n🚀 Running orchestrator..."));
            
            const llmRouter = await loadLLMRouter(process.cwd());
            const { RoutingBackend } = await import("@/agents/execution/RoutingBackend");
            const routingBackend = new RoutingBackend(llmRouter, this.conversationManager!);
            
            // Build messages for orchestrator
            const messages = await this.buildOrchestratorMessages(context);
            
            // Get routing decision
            const getRoutingDecision = (routingBackend as any).getRoutingDecision.bind(routingBackend);
            const decision = await getRoutingDecision(
                messages,
                { 
                    agent: orchestrator, 
                    conversationId: this.state.conversationId,
                    phase: this.state.phase
                },
                null,
                null
            );

            // Display the decision
            logger.info(chalk.green("\n✨ Routing Decision:"));
            logger.info(chalk.white(JSON.stringify(decision, null, 2)));
            
            // Ask if they want to apply it
            const apply = await this.ui.confirm("\nApply this routing to current state?");
            
            if (apply) {
                // Create new routing entry
                this.state.currentRouting = {
                    phase: decision.phase || this.state.phase,
                    agents: decision.agents,
                    completions: [],
                    reason: decision.reason,
                    timestamp: Date.now()
                };
                
                // Update phase if changed
                if (decision.phase && decision.phase !== this.state.phase) {
                    this.state.phase = decision.phase as Phase;
                    logger.info(chalk.green(`✓ Phase changed to ${decision.phase}`));
                }
                
                logger.info(chalk.green("✓ Routing applied to state"));
            }
        } catch (error) {
            logger.error(chalk.red(`Failed to run orchestrator: ${formatAnyError(error)}`));
        }
    }

    private buildOrchestratorContext() {
        return {
            user_request: this.state.userRequest,
            routing_history: this.state.routingHistory,
            current_routing: this.state.currentRouting
        };
    }

    private async buildOrchestratorMessages(context: any) {
        const { Message } = await import("multi-llm-ts");
        const projectCtx = getProjectContext();
        const orchestrator = Array.from(projectCtx.agents.values()).find(a => a.isOrchestrator);
        
        if (!orchestrator) {
            throw new Error("No orchestrator found");
        }

        // Build system prompt
        const { buildSystemPromptMessages } = await import("@/prompts/utils/systemPromptBuilder");
        const systemMessages = buildSystemPromptMessages({
            agent: orchestrator,
            phase: this.state.phase,
            project: projectCtx.project!,
            availableAgents: Array.from(projectCtx.agents.values()),
            conversation: {
                id: this.state.conversationId!,
                title: "Debug Session",
                phase: this.state.phase,
                history: [],
                agentStates: this.state.agentStates,
                phaseTransitions: [],
                orchestratorTurns: this.state.orchestratorTurns,
                metadata: this.state.metadata,
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now()
                }
            },
            agentLessons: new Map(),
            mcpTools: [],
            triggeringEvent: undefined
        });

        const messages = systemMessages.map(sm => sm.message);
        
        // Add the routing context as user message
        messages.push(new Message("user", JSON.stringify(context, null, 2)));
        
        return messages;
    }

    private async exportState(): Promise<void> {
        const format = await this.ui.promptExportFormat();
        
        if (format.type === 'json') {
            const filename = format.filename || `orchestrator-state-${Date.now()}.json`;
            const content = JSON.stringify(this.state, null, 2);
            
            const fs = await import("fs/promises");
            await fs.writeFile(filename, content);
            logger.info(chalk.green(`✓ Exported to ${filename}`));
        } else if (format.type === 'typescript') {
            const filename = format.filename || `orchestrator-state-${Date.now()}.test.ts`;
            const content = this.generateTestCase();
            
            const fs = await import("fs/promises");
            await fs.writeFile(filename, content);
            logger.info(chalk.green(`✓ Exported test case to ${filename}`));
        } else if (format.type === 'markdown') {
            const filename = format.filename || `orchestrator-state-${Date.now()}.md`;
            const content = this.generateMarkdown();
            
            const fs = await import("fs/promises");
            await fs.writeFile(filename, content);
            logger.info(chalk.green(`✓ Exported documentation to ${filename}`));
        }
    }

    private generateTestCase(): string {
        const agentSlugs = Array.from(this.state.agentStates.keys());
        return `import { describe, it, expect } from 'vitest';
import type { OrchestratorRoutingContext } from '@/conversations/types';

describe('Orchestrator Routing Test', () => {
    it('should handle ${this.state.phase} phase routing', () => {
        const context: OrchestratorRoutingContext = ${JSON.stringify(this.buildOrchestratorContext(), null, 8)};
        
        // Verify context structure
        expect(context).toBeDefined();
        expect(context.phase).toBe('${this.state.phase}');
        expect(context.availableAgents).toBeInstanceOf(Array);
        expect(context.availableAgents.length).toBeGreaterThan(0);
        
        // Verify phase-specific routing logic
        const orchestratorResponse = routeToAgent(context);
        expect(orchestratorResponse).toBeDefined();
        expect(orchestratorResponse.agent).toMatch(/^(${agentSlugs.join('|')})$/);
    });
});`;
    }

    private generateMarkdown(): string {
        let md = `# Orchestrator Debug State\n\n`;
        md += `**Generated:** ${new Date().toISOString()}\n\n`;
        md += `## Current State\n\n`;
        md += `- **Phase:** ${this.state.phase}\n`;
        md += `- **User Request:** ${this.state.userRequest}\n\n`;
        
        if (this.state.routingHistory.length > 0) {
            md += `## Routing History\n\n`;
            for (const entry of this.state.routingHistory) {
                md += `### ${entry.phase} → ${entry.agents.join(', ')}\n`;
                md += `**Reason:** ${entry.reason}\n\n`;
                if (entry.completions.length > 0) {
                    md += `**Completions:**\n`;
                    for (const comp of entry.completions) {
                        md += `- **${comp.agent}:** ${comp.message}\n`;
                    }
                    md += `\n`;
                }
            }
        }
        
        if (this.state.currentRouting) {
            md += `## Current Routing\n\n`;
            md += `- **Phase:** ${this.state.currentRouting.phase}\n`;
            md += `- **Agents:** ${this.state.currentRouting.agents.join(', ')}\n`;
            md += `- **Reason:** ${this.state.currentRouting.reason}\n`;
            md += `- **Completions:** ${this.state.currentRouting.completions.length}\n\n`;
        }
        
        return md;
    }

    private async showOrchestratorContext(): Promise<void> {
        const context = this.buildOrchestratorContext();
        
        logger.info(chalk.cyan("\n📋 Current Orchestrator Context:"));
        logger.info(chalk.white(JSON.stringify(context, null, 2)));
        
        await this.ui.promptToContinue();
    }
    
    private async debugReasoning(): Promise<void> {
        if (!this.state.userRequest) {
            logger.warn(chalk.yellow("Please set a user message first"));
            return;
        }

        const question = await this.ui.promptDebugQuestion();
        if (!question) {
            return;
        }

        const context = this.buildOrchestratorContext();
        
        logger.info(chalk.cyan("\n🤔 Asking Orchestrator..."));
        
        try {
            // Get the orchestrator agent
            const projectCtx = getProjectContext();
            const orchestrator = Array.from(projectCtx.agents.values()).find(a => a.isOrchestrator);
            
            if (!orchestrator) {
                logger.error(chalk.red("No orchestrator agent found in project"));
                return;
            }

            // Build messages for orchestrator WITHOUT the routing context
            const { Message } = await import("multi-llm-ts");
            const { buildSystemPromptMessages } = await import("@/prompts/utils/systemPromptBuilder");
            
            // Get just the system prompt, not the routing context
            const systemMessages = buildSystemPromptMessages({
                agent: orchestrator,
                phase: this.state.phase,
                project: projectCtx.project!,
                availableAgents: Array.from(projectCtx.agents.values()),
                conversation: {
                    id: this.state.conversationId!,
                    title: "Debug Session",
                    phase: this.state.phase,
                    history: [],
                    agentStates: this.state.agentStates,
                    phaseTransitions: [],
                    orchestratorTurns: this.state.orchestratorTurns,
                    metadata: this.state.metadata,
                    executionTime: {
                        totalSeconds: 0,
                        isActive: false,
                        lastUpdated: Date.now()
                    }
                },
                agentLessons: new Map(),
                mcpTools: [],
                triggeringEvent: undefined
            });

            const debugMessages = systemMessages.map(sm => sm.message);
            
            // Add the context as reference, not as a routing request
            debugMessages.push(new Message("user", `
=== METACOGNITIVE DEBUG MODE ===

You are NOT being asked to make a routing decision. Instead, you are being asked to explain your reasoning process in detail.

Here is the conversation context that you would normally use for routing:
${JSON.stringify(context, null, 2)}

Now, the user has a question about your decision-making process:
"${question}"

Please provide a DETAILED METACOGNITIVE ANALYSIS that includes:

1. **SYSTEM PROMPT ANALYSIS**: Quote the specific parts of your system prompt that influenced this decision. Be exact - show me which rules or instructions guided you.

2. **DECISION TREE**: Walk through your step-by-step reasoning:
   - What did you notice first in the context?
   - What patterns did you recognize?
   - What rules did you apply?
   - What priorities did you weigh?

3. **ALTERNATIVES CONSIDERED**: What other routing options did you evaluate? Why did you reject them? Be specific about each alternative.

4. **CONFIDENCE & UNCERTAINTY**: 
   - How confident were you in this decision (0-100%)?
   - What aspects were you uncertain about?
   - What additional information would have helped?

5. **PHASE REASONING**: If you chose or maintained a specific phase, explain:
   - Why this phase instead of others?
   - What phase transition rules applied?
   - What would trigger a different phase?

6. **AGENT SELECTION LOGIC**: For each agent you would route to:
   - Why this specific agent?
   - What capabilities made them suitable?
   - Why not other agents?

7. **POTENTIAL IMPROVEMENTS**: Looking at your decision critically:
   - What could have been better?
   - Are there edge cases you might have missed?
   - How would you improve the system prompt to make better decisions?

Remember: This is a debugging session. Be completely transparent about your internal process, including any confusion, competing priorities, or aspects of the system prompt that might be unclear or contradictory.

DO NOT output a routing decision JSON. Output a detailed explanation in plain text or markdown.`));

            // Get response from orchestrator
            const llmRouter = await loadLLMRouter(process.cwd());
            const response = await llmRouter.complete({
                messages: debugMessages,
                options: {
                    configName: orchestrator.llmConfig || "orchestrator",
                    agentName: orchestrator.name,
                    temperature: 0.5, // Slightly higher for more detailed reasoning
                    maxTokens: 2000 // Allow for detailed explanations
                }
            });

            if (response.type === "text") {
                logger.info(chalk.green("\n✨ Orchestrator Reasoning:"));
                logger.info(chalk.white(response.content));
                
                // Ask if they want to save this insight
                const saveInsight = await this.ui.confirm("\nSave this reasoning insight to a file?");
                if (saveInsight) {
                    const fs = await import("fs/promises");
                    const filename = `orchestrator-debug-${Date.now()}.md`;
                    const content = `# Orchestrator Debug Session\n\n## Context\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n## Question\n${question}\n\n## Response\n${response.content}`;
                    await fs.writeFile(filename, content);
                    logger.info(chalk.green(`✓ Saved to ${filename}`));
                }
            }
        } catch (error) {
            logger.error(chalk.red(`Failed to debug reasoning: ${formatAnyError(error)}`));
        }
        
        await this.ui.promptToContinue();
    }
    
    private async listAgents(): Promise<void> {
        const projectCtx = getProjectContext();
        const agents = Array.from(projectCtx.agents.values());
        
        logger.info(chalk.cyan("\n📋 Available Agents:\n"));
        
        // Group agents by type
        const orchestrator = agents.filter(a => a.isOrchestrator);
        const specialists = agents.filter(a => !a.isOrchestrator);
        
        if (orchestrator.length > 0) {
            logger.info(chalk.yellow("Orchestrator:"));
            for (const agent of orchestrator) {
                logger.info(chalk.white(`  • ${agent.name} (${agent.slug})`));
                if (agent.description) {
                    logger.info(chalk.gray(`    ${agent.description}`));
                }
            }
            logger.info("");
        }
        
        logger.info(chalk.yellow("Specialist Agents:"));
        for (const agent of specialists) {
            const tools = agent.tools || [];
            const toolCount = tools.length;
            const backend = agent.backend || "reason-act-loop";
            
            logger.info(chalk.white(`  • ${agent.name} (${agent.slug})`));
            
            if (agent.description) {
                logger.info(chalk.gray(`    ${agent.description}`));
            }
            
            logger.info(chalk.gray(`    Backend: ${backend}, Tools: ${toolCount}`));
            logger.info("");
        }
        
        logger.info(chalk.gray(`Total: ${agents.length} agents (${orchestrator.length} orchestrator, ${specialists.length} specialists)\n`));
        
        await this.ui.promptToContinue();
    }
}