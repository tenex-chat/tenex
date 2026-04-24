import * as path from "node:path";
import type { AgentInstance } from "@/agents/types";
import type { AgentCategory } from "@/agents/role-categories";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { ProjectAgentRuntimeInfo } from "@/services/projects/ProjectContext";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import { SchedulerService } from "@/services/scheduling";
import { logger } from "@/utils/logger";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import type { ModelMessage } from "ai";
import { trace } from "@opentelemetry/api";
import type { TeamContext } from "@/prompts/fragments/types";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

/**
 * List of scheduling-related tools that trigger the scheduled tasks context
 */
const SCHEDULING_TOOLS = ["schedule_task"] as const;

export interface BuildSystemPromptOptions {
    // Required data
    agent: AgentInstance;
    project: NDKProject;
    conversation: ConversationStore;
    triggeringEnvelope?: InboundEnvelope;

    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     * Worktrees are in .worktrees/ subdirectory.
     */
    projectBasePath?: string;

    /**
     * Working directory for code execution.
     * - Default branch: same as projectBasePath (~/tenex/{dTag})
     * - Feature branch: ~/tenex/{dTag}/.worktrees/feature_branch/
     * This is displayed as "Absolute Path" in the system prompt.
     */
    workingDirectory?: string;

    /**
     * Current git branch name.
     * Example: "master", "feature/branch-name", "research/foo"
     */
    currentBranch?: string;

    // Optional runtime data
    projectContext?: Pick<ProjectContext, "promptCompilerRegistry" | "getProjectAgentRuntimeInfo">;
    availableAgents?: AgentInstance[];
    agentRuntimeInfo?: ProjectAgentRuntimeInfo[];
    /** Whether to include environment-variables fragment. Defaults to true. */
    environmentVariablesAvailable?: boolean;
    /** Agent category. Used to auto-derive environmentVariablesAvailable (orchestrators don't get it). */
    agentCategory?: AgentCategory;
    teamContext?: TeamContext;
}


export interface SystemMessage {
    message: ModelMessage;
    metadata?: {
        description?: string;
    };
}

/**
 * Add core agent fragments.
 * NOTE: Lessons are not added as raw fragments here. They are compiled into the
 * agent's effective instructions by the runtime-owned prompt compiler registry.
 */
async function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    parentSpan?: import("@opentelemetry/api").Span,
): Promise<void> {
    // Add scheduled tasks context if agent has scheduling tools
    const hasSchedulingTools = agent.tools.some((tool) =>
        SCHEDULING_TOOLS.includes(tool as (typeof SCHEDULING_TOOLS)[number])
    );

    if (hasSchedulingTools) {
        try {
            const t0 = performance.now();
            const schedulerService = SchedulerService.getInstance();
            const allTasks = await schedulerService.getTasks();
            parentSpan?.addEvent("scheduled_tasks_fetched", { "duration_ms": Math.round(performance.now() - t0) });
            builder.add("scheduled-tasks", {
                agent,
                scheduledTasks: allTasks,
            });
        } catch (error) {
            // Scheduler might not be initialized yet, log and continue
            logger.debug("Could not fetch scheduled tasks for prompt:", error);
        }
    }

    // Add todo usage guidance if agent has todo tools
    if (agent.tools.includes("todo_add")) {
        builder.add("todo-usage-guidance", {});
    }

}

/**
 * Add agent-specific fragments.
 * Domain-expert agents receive domain-expert-guidance (no delegation) instead of
 * delegation-tips and todo-before-delegation — including both would be contradictory.
 * Orchestrators additionally receive explicit routing guidance.
 */
function addAgentFragments(
    builder: PromptBuilder,
    agentCategory: AgentCategory | undefined,
    triggeringEnvelope?: BuildSystemPromptOptions["triggeringEnvelope"],
): void {
    if (agentCategory === "orchestrator") {
        builder.add("orchestrator-delegation-guidance", {});
    }

    if (agentCategory !== "domain-expert") {
        builder.add("delegation-tips", {});
        builder.add("todo-before-delegation", {});
    }

    // Add explicit guidance for turns where the user wants no reply.
    if (triggeringEnvelope?.transport === "telegram") {
        builder.add("no-response-guidance", {
            triggeringEnvelope,
        });
    }
}

/**
 * Builds the system prompt messages for an agent, returning an array of messages
 * with optional caching metadata.
 * This is the single source of truth for system prompt generation.
 */
export async function buildSystemPromptMessages(
    options: BuildSystemPromptOptions
): Promise<SystemMessage[]> {
    const messages: SystemMessage[] = [];

    // Build the main system prompt
    const activeSpan = trace.getActiveSpan();
    const mainPrompt = await buildMainSystemPrompt(options, activeSpan);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main system prompt",
        },
    });

    return messages;
}

/**
 * Builds the main system prompt content.
 *
 * Uses the runtime-owned PromptCompilerRegistryService when available to resolve
 * Effective Agent Instructions. The result is then used when building fragments.
 *
 * IMPORTANT: The Effective Agent Instructions should contain ONLY:
 * - Base Agent Instructions (from agent.instructions in Kind 4199 event)
 * - Lessons learned and lesson comments (merged by LLM)
 *
 * Fragments (project context, worktrees, available agents, etc.) are added AFTER compilation.
 */
async function buildMainSystemPrompt(options: BuildSystemPromptOptions, parentSpan?: import("@opentelemetry/api").Span): Promise<string> {
    const {
        agent,
        project,
        triggeringEnvelope,
        projectBasePath,
        workingDirectory,
        currentBranch,
        projectContext,
        availableAgents = [],
        agentRuntimeInfo,
        conversation,
        environmentVariablesAvailable: environmentVariablesAvailableOption,
        agentCategory,
        teamContext,
    } = options;

    // Fall back to the agent object's own category when the caller omits agentCategory.
    // This ensures callers like PostCompletionChecker and ToolSupervisionWrapper
    // that rebuild the prompt without an explicit category still apply correct policy.
    const effectiveAgentCategory = agentCategory ?? agent.category;

    // Auto-derive availability based on agent category (orchestrators don't get environment-variables)
    const isOrchestrator = effectiveAgentCategory === "orchestrator";
    const environmentVariablesAvailable = environmentVariablesAvailableOption ?? !isOrchestrator;

    const baseAgentInstructions = agent.instructions || "";
    const effectiveAgentRuntimeInfo =
        agentRuntimeInfo ??
        (typeof projectContext?.getProjectAgentRuntimeInfo === "function"
            ? projectContext.getProjectAgentRuntimeInfo()
            : undefined);
    const rawDTag = project.dTag;
    const dTag: ProjectDTag | undefined = rawDTag ? createProjectDTag(rawDTag) : undefined;
    const effectiveAgentInstructions = projectContext?.promptCompilerRegistry
        ? projectContext.promptCompilerRegistry.getEffectiveInstructionsSync(agent.pubkey, baseAgentInstructions)
        : baseAgentInstructions;

    logger.debug("✅ Retrieved Effective Agent Instructions (sync)", {
        agentName: agent.name,
        baseInstructionsLength: baseAgentInstructions.length,
        effectiveInstructionsLength: effectiveAgentInstructions.length,
        usedPromptCompilerRegistry: !!projectContext?.promptCompilerRegistry,
    });

    // Create an agent copy with Effective Agent Instructions (if available)
    // This ensures fragments use the compiled version instead of raw Base Agent Instructions
    const agentForFragments: AgentInstance = effectiveAgentInstructions
        ? { ...agent, instructions: effectiveAgentInstructions }
        : agent;

    const systemPromptBuilder = new PromptBuilder();
    let t0: number;

    // Add agent identity
    // NOTE: Uses agentForFragments which has Effective Agent Instructions (lessons merged in)
    systemPromptBuilder.add("agent-identity", {
        agent: agentForFragments,
    });

    // Add agent home directory context
    systemPromptBuilder.add("agent-home-directory", {
        agent: agentForFragments,
        projectId: dTag,
    });

    // Explain <system-reminder> tags before agents encounter them
    systemPromptBuilder.add("system-reminders-explanation", {});

    // Add global system prompt if configured (ordered by fragment priority)
    systemPromptBuilder.add("global-system-prompt", {});

    systemPromptBuilder.add("telegram-chat-context", {
        triggeringEnvelope,
    });
    systemPromptBuilder.add("telegram-delivery-rules", {
        triggeringEnvelope,
    });

    // Add environment path variables (shell + file tool usage)
    if (environmentVariablesAvailable) {
        systemPromptBuilder.add("environment-variables", {
            agent: agentForFragments,
            projectBasePath,
        });
    }

    // Add consolidated project context (workspace, team, channels, agents.md, other-projects)
    systemPromptBuilder.add("project-context", {
        agent: agentForFragments,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectId: dTag,
        projectOwnerPubkey: project.pubkey,
        conversationId: conversation.getId(),
        projectBasePath,
        workingDirectory,
        currentBranch,
        projectDocsPath: projectBasePath ? path.join(projectBasePath, "docs") : undefined,
        availableAgents,
        agentRuntimeInfo: effectiveAgentRuntimeInfo,
        teamContext,
    });

    // Add delegation chain if present (shows agent their position in multi-agent workflow)
    // The chain entries already have full conversation IDs stored - no need to pass currentConversationId
    if (conversation?.metadata?.delegationChain && conversation.metadata.delegationChain.length > 0) {
        systemPromptBuilder.add("delegation-chain", {
            delegationChain: conversation.metadata.delegationChain,
            currentAgentPubkey: agentForFragments.pubkey,
            currentConversationId: conversation.getId(),
        });
    }

    // NOTE: agent-todos is NOT included here - it's injected as a late system message
    // in AgentExecutor.executeStreaming() to ensure it appears at the end of messages

    // Add domain expert guidance for domain-expert agents
    if (effectiveAgentCategory === "domain-expert") {
        systemPromptBuilder.add("domain-expert-guidance", {});
    }

    // Add tool description guidance (universal — all agents benefit)
    systemPromptBuilder.add("tool-description-guidance", {});

    // Add core agent fragments using shared composition
    t0 = performance.now();
    await addCoreAgentFragments(
        systemPromptBuilder,
        agentForFragments,
        parentSpan,
    );
    parentSpan?.addEvent("core_agent_fragments_added", { "duration_ms": Math.round(performance.now() - t0) });

    // Add agent-specific fragments
    addAgentFragments(
        systemPromptBuilder,
        effectiveAgentCategory,
        triggeringEnvelope,
    );

    // Build and return the complete prompt with all fragments
    t0 = performance.now();
    const result = await systemPromptBuilder.build();
    parentSpan?.addEvent("fragments_built", { "duration_ms": Math.round(performance.now() - t0), "fragment.count": systemPromptBuilder.getFragmentCount() });
    return result;
}
