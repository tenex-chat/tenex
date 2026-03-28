/**
 * Prompt Compiler Service (TIN-10)
 *
 * Compiles agent lessons with user comments into Effective Agent Instructions.
 *
 * Terminology:
 * - Base Agent Instructions: Raw instructions from agent.instructions (Kind 4199 event)
 * - Effective Agent Instructions: Final compiled result (Base + Lessons + Comments)
 */

export {
    PromptCompilerService,
    type EffectiveInstructionsCacheEntry,
} from "./prompt-compiler-service";
export { PromptCompilerRegistryService } from "./PromptCompilerRegistryService";
