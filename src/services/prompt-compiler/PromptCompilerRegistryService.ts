import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { LessonComment } from "@/events/LessonComment";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import { logger } from "@/utils/logger";
import { PromptCompilerService } from "./prompt-compiler-service";

/**
 * Project-scoped coordinator for per-agent prompt compilers.
 * Owns compiler lifecycle for a single ProjectRuntime.
 */
export class PromptCompilerRegistryService {
    private readonly compilers = new Map<string, PromptCompilerService>();
    private readonly registrationPromises = new Map<string, Promise<PromptCompilerService>>();
    private stopped = false;

    constructor(
        private readonly projectId: string,
        private readonly projectTitle: string,
        private readonly projectContext: ProjectContext
    ) {}

    async registerAgent(agent: AgentInstance): Promise<PromptCompilerService> {
        const existingCompiler = this.compilers.get(agent.pubkey);
        if (existingCompiler) {
            this.applyAgentMetadata(existingCompiler, agent);
            existingCompiler.syncBaseInstructions(agent.instructions || "", agent.eventId);
            existingCompiler.syncInputs(
                this.projectContext.getLessonsForAgent(agent.pubkey),
                this.projectContext.getCommentsForAgent(agent.pubkey)
            );
            return existingCompiler;
        }

        const inFlightRegistration = this.registrationPromises.get(agent.pubkey);
        if (inFlightRegistration) {
            return inFlightRegistration;
        }

        const registrationPromise = (async (): Promise<PromptCompilerService> => {
            const compiler = new PromptCompilerService(agent.pubkey, this.projectId);
            this.applyAgentMetadata(compiler, agent);
            await compiler.initialize(
                agent.instructions || "",
                this.projectContext.getLessonsForAgent(agent.pubkey),
                agent.eventId,
                this.projectContext.getCommentsForAgent(agent.pubkey)
            );
            if (this.stopped) return compiler;
            compiler.triggerCompilation();
            this.compilers.set(agent.pubkey, compiler);

            logger.debug("PromptCompilerRegistryService: registered compiler for agent", {
                projectId: this.projectId,
                agentPubkey: agent.pubkey.substring(0, 8),
            });

            return compiler;
        })().finally(() => {
            this.registrationPromises.delete(agent.pubkey);
        });

        this.registrationPromises.set(agent.pubkey, registrationPromise);
        return registrationPromise;
    }

    async syncAgentInputs(
        agentPubkey: string,
        lessons?: NDKAgentLesson[],
        comments?: LessonComment[]
    ): Promise<void> {
        const agent = this.projectContext.getAgentByPubkey(agentPubkey);
        if (!agent) {
            logger.debug("PromptCompilerRegistryService: skipping sync for unknown agent", {
                projectId: this.projectId,
                agentPubkey: agentPubkey.substring(0, 8),
            });
            return;
        }

        const compiler = this.compilers.get(agentPubkey) ?? await this.registerAgent(agent);
        compiler.syncBaseInstructions(agent.instructions || "", agent.eventId);
        compiler.syncInputs(
            lessons ?? this.projectContext.getLessonsForAgent(agentPubkey),
            comments ?? this.projectContext.getCommentsForAgent(agentPubkey)
        );
    }

    getEffectiveInstructionsSync(agentPubkey: string, baseInstructions: string): string {
        const compiler = this.compilers.get(agentPubkey);
        if (!compiler) {
            return baseInstructions;
        }

        return compiler.getEffectiveInstructionsSync().instructions;
    }

    stop(): void {
        this.stopped = true;

        for (const compiler of this.compilers.values()) {
            compiler.stop();
        }

        this.compilers.clear();
        this.registrationPromises.clear();
    }

    private applyAgentMetadata(compiler: PromptCompilerService, agent: AgentInstance): void {
        compiler.setAgentMetadata(
            agent.signer,
            agent.name,
            agent.role,
            this.projectTitle
        );
    }
}
