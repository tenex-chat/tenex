import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { SupervisorOrchestrator } from "../SupervisorOrchestrator";
import { HeuristicRegistry } from "../heuristics/HeuristicRegistry";
import { SilentAgentHeuristic } from "../heuristics/SilentAgentHeuristic";
import { MAX_SUPERVISION_RETRIES } from "../types";
import type { Heuristic, PostCompletionContext, PreToolContext } from "../types";
import { supervisorLLMService } from "../SupervisorLLMService";
import { resetRegistrationForTesting } from "../registerHeuristics";

// Mock logger
vi.mock("@/utils/logger", () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Mock the LLM service to avoid actual API calls
vi.mock("../SupervisorLLMService", () => ({
    supervisorLLMService: {
        verify: vi.fn().mockResolvedValue({
            verdict: "ok",
            explanation: "Test verification passed",
        }),
    },
}));

describe("SupervisorOrchestrator", () => {
    let orchestrator: SupervisorOrchestrator;

    beforeEach(() => {
        // Reset registration state AND clear registry before each test
        // This allows tests to verify fail-closed behavior when registry is empty
        resetRegistrationForTesting();
        orchestrator = new SupervisorOrchestrator();
    });

    const createContext = (
        overrides: Partial<PostCompletionContext> = {}
    ): PostCompletionContext => ({
        agentSlug: "test-agent",
        agentPubkey: "abc123",
        messageContent: "Hello world",
        toolCallsMade: [],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        hasTodoList: false,
        hasBeenNudgedAboutTodos: false,
        hasBeenRemindedAboutTodos: false,
        todos: [],
        ...overrides,
    });

    describe("supervision state management", () => {
        it("should create new state for unknown execution ID", () => {
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(0);
            expect(state.maxRetries).toBe(MAX_SUPERVISION_RETRIES);
        });

        it("should return existing state for known execution ID", () => {
            orchestrator.incrementRetryCount("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(1);
        });

        it("should increment retry count", () => {
            orchestrator.incrementRetryCount("exec-1");
            orchestrator.incrementRetryCount("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(2);
        });

        it("should detect when max retries exceeded", () => {
            for (let i = 0; i < MAX_SUPERVISION_RETRIES; i++) {
                orchestrator.incrementRetryCount("exec-1");
            }

            expect(orchestrator.hasExceededMaxRetries("exec-1")).toBe(true);
        });

        it("should not exceed max retries when under limit", () => {
            orchestrator.incrementRetryCount("exec-1");

            expect(orchestrator.hasExceededMaxRetries("exec-1")).toBe(false);
        });

        it("should clear state", () => {
            orchestrator.incrementRetryCount("exec-1");
            orchestrator.clearState("exec-1");
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.retryCount).toBe(0);
        });

        it("should initialize enforcedHeuristics as empty Set", () => {
            const state = orchestrator.getSupervisionState("exec-1");

            expect(state.enforcedHeuristics).toBeInstanceOf(Set);
            expect(state.enforcedHeuristics.size).toBe(0);
        });

        it("should return false for unknown heuristic in isHeuristicEnforced", () => {
            expect(orchestrator.isHeuristicEnforced("exec-1", "unknown-heuristic")).toBe(false);
        });

        it("should return true for enforced heuristic after markHeuristicEnforced", () => {
            orchestrator.markHeuristicEnforced("exec-1", "pending-todos");

            expect(orchestrator.isHeuristicEnforced("exec-1", "pending-todos")).toBe(true);
        });

        it("should track multiple enforced heuristics independently", () => {
            orchestrator.markHeuristicEnforced("exec-1", "heuristic-a");
            orchestrator.markHeuristicEnforced("exec-1", "heuristic-b");

            expect(orchestrator.isHeuristicEnforced("exec-1", "heuristic-a")).toBe(true);
            expect(orchestrator.isHeuristicEnforced("exec-1", "heuristic-b")).toBe(true);
            expect(orchestrator.isHeuristicEnforced("exec-1", "heuristic-c")).toBe(false);
        });

        it("should clear enforcedHeuristics when clearState is called", () => {
            orchestrator.markHeuristicEnforced("exec-1", "pending-todos");
            expect(orchestrator.isHeuristicEnforced("exec-1", "pending-todos")).toBe(true);

            orchestrator.clearState("exec-1");

            expect(orchestrator.isHeuristicEnforced("exec-1", "pending-todos")).toBe(false);
        });

        it("should track enforcement separately per execution", () => {
            orchestrator.markHeuristicEnforced("exec-1", "pending-todos");

            expect(orchestrator.isHeuristicEnforced("exec-1", "pending-todos")).toBe(true);
            expect(orchestrator.isHeuristicEnforced("exec-2", "pending-todos")).toBe(false);
        });
    });

    describe("checkPostCompletion", () => {
        it("should throw error when no heuristics registered (fail-closed behavior)", async () => {
            const context = createContext();

            await expect(orchestrator.checkPostCompletion(context)).rejects.toThrow(
                "Supervision system misconfigured: no post-completion heuristics registered"
            );
        });

        it("should return no violation when heuristic does not trigger", async () => {
            HeuristicRegistry.getInstance().register(new SilentAgentHeuristic());

            const context = createContext({
                messageContent: "Here is my response",
            });
            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(false);
        });

        it("should build correction message for suppress-publish type with reEngage", async () => {
            // Create a mock heuristic that returns suppress-publish with reEngage: true
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-suppress-publish",
                name: "Test Suppress Publish",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Please fix the issue"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test violation confirmed",
            });

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("suppress-publish");
            expect(result.correctionAction?.reEngage).toBe(true);
            expect(result.correctionAction?.message).toBe("Please fix the issue");
            expect(mockHeuristic.buildCorrectionMessage).toHaveBeenCalled();
        });

        it("should NOT build correction message for suppress-publish when reEngage is false", async () => {
            // Create a mock heuristic that returns suppress-publish with reEngage: false
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-suppress-publish-no-reengage",
                name: "Test Suppress Publish No ReEngage",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Should not be called"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: false,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test violation confirmed",
            });

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("suppress-publish");
            expect(result.correctionAction?.reEngage).toBe(false);
            // Message should remain undefined when reEngage is false
            expect(result.correctionAction?.message).toBeUndefined();
            expect(mockHeuristic.buildCorrectionMessage).not.toHaveBeenCalled();
        });

        it("should not overwrite existing message for suppress-publish type", async () => {
            // Create a mock heuristic that returns suppress-publish with a pre-set message
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-suppress-publish-with-message",
                name: "Test Suppress Publish With Message",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Should not be called"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: "Pre-existing message",
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test violation confirmed",
            });

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.message).toBe("Pre-existing message");
            expect(mockHeuristic.buildCorrectionMessage).not.toHaveBeenCalled();
        });

        it("should preserve empty string message for suppress-publish type", async () => {
            // Create a mock heuristic that returns suppress-publish with empty string message
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-suppress-publish-empty-string",
                name: "Test Suppress Publish Empty String",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Should not be called"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: "", // intentional empty string
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test violation confirmed",
            });

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.message).toBe("");
            expect(mockHeuristic.buildCorrectionMessage).not.toHaveBeenCalled();
        });

        it("should build correction message for suppress-publish in skip-verification path", async () => {
            // Create a mock heuristic with skipVerification: true that returns suppress-publish
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-skip-verification-suppress",
                name: "Test Skip Verification Suppress",
                timing: "post-completion",
                skipVerification: true, // This triggers the skip-verification code path
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger for skip verification",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Should not be called"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Skip verification correction message"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("suppress-publish");
            expect(result.correctionAction?.reEngage).toBe(true);
            expect(result.correctionAction?.message).toBe("Skip verification correction message");
            expect(mockHeuristic.buildCorrectionMessage).toHaveBeenCalled();
            // Verification prompt should NOT have been called since we skip verification
            expect(mockHeuristic.buildVerificationPrompt).not.toHaveBeenCalled();
        });

        it("should build correction message for inject-message type with undefined message", async () => {
            // This test explicitly covers the inject-message branch of shouldBuildCorrectionMessage
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-inject-message",
                name: "Test Inject Message",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test trigger for inject-message",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Injected correction message"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "inject-message",
                    reEngage: true,
                    message: undefined, // should trigger buildCorrectionMessage
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test violation confirmed",
            });

            const context = createContext({
                messageContent: "",
            });

            const result = await orchestrator.checkPostCompletion(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("inject-message");
            expect(result.correctionAction?.message).toBe("Injected correction message");
            expect(mockHeuristic.buildCorrectionMessage).toHaveBeenCalled();
        });

        it("should skip already-enforced heuristics when executionId is provided", async () => {
            // Register the enforced heuristic
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-skip-enforced",
                name: "Test Skip Enforced",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Should not be called",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            // Also register a second non-triggered heuristic so we don't get the empty registry error
            const dummyHeuristic: Heuristic<PostCompletionContext> = {
                id: "dummy-heuristic",
                name: "Dummy Heuristic",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: false,
                    reason: "Not triggered",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);
            HeuristicRegistry.getInstance().register(dummyHeuristic);

            // Mark the heuristic as enforced
            orchestrator.markHeuristicEnforced("exec-1", "test-skip-enforced");

            const context = createContext();
            const result = await orchestrator.checkPostCompletion(context, "exec-1");

            // Should not have called detect because heuristic was already enforced
            expect(mockHeuristic.detect).not.toHaveBeenCalled();
            // Dummy heuristic should have been checked
            expect(dummyHeuristic.detect).toHaveBeenCalled();
            expect(result.hasViolation).toBe(false);
        });

        it("should still run non-enforced heuristics when one is enforced", async () => {
            const enforcedHeuristic: Heuristic<PostCompletionContext> = {
                id: "enforced-heuristic",
                name: "Enforced Heuristic",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Should not be called",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            const activeHeuristic: Heuristic<PostCompletionContext> = {
                id: "active-heuristic",
                name: "Active Heuristic",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "This should trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Active prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Active correction"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(enforcedHeuristic);
            HeuristicRegistry.getInstance().register(activeHeuristic);

            // Mark only the first heuristic as enforced
            orchestrator.markHeuristicEnforced("exec-1", "enforced-heuristic");

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Active heuristic violation confirmed",
            });

            const context = createContext();
            const result = await orchestrator.checkPostCompletion(context, "exec-1");

            // Enforced heuristic should be skipped
            expect(enforcedHeuristic.detect).not.toHaveBeenCalled();
            // Active heuristic should run and trigger
            expect(activeHeuristic.detect).toHaveBeenCalled();
            expect(result.hasViolation).toBe(true);
            expect(result.heuristicId).toBe("active-heuristic");
        });

        it("should run all heuristics when no executionId is provided (backward compatibility)", async () => {
            const mockHeuristic: Heuristic<PostCompletionContext> = {
                id: "test-no-execution-id",
                name: "Test No Execution ID",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: false,
                    reason: "Not triggered",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mark heuristic as enforced for some execution (but we'll call without executionId)
            orchestrator.markHeuristicEnforced("exec-1", "test-no-execution-id");

            const context = createContext();
            // Call without executionId - should run all heuristics
            const result = await orchestrator.checkPostCompletion(context);

            // Should have called detect because no executionId was provided
            expect(mockHeuristic.detect).toHaveBeenCalled();
            expect(result.hasViolation).toBe(false);
        });

        it("should still run heuristics even when some are enforced (checks all registered)", async () => {
            // This test verifies that having registered heuristics (even if some are enforced)
            // still allows the supervision check to proceed - it runs all applicable heuristics
            const enforcedHeuristic: Heuristic<PostCompletionContext> = {
                id: "only-enforced-heuristic",
                name: "Only Enforced Heuristic",
                timing: "post-completion",
                detect: vi.fn().mockResolvedValue({
                    triggered: false,
                    reason: "Not triggered",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            HeuristicRegistry.getInstance().register(enforcedHeuristic);

            const context = createContext();
            const result = await orchestrator.checkPostCompletion(context, "exec-1");

            // Should work because there's still a registered heuristic
            expect(enforcedHeuristic.detect).toHaveBeenCalled();
            expect(result.hasViolation).toBe(false);
        });
    });

    describe("checkPreTool", () => {
        const createPreToolContext = (
            overrides: Partial<PreToolContext> = {}
        ): PreToolContext => ({
            agentSlug: "test-agent",
            agentPubkey: "abc123",
            toolName: "test-tool",
            toolArgs: {},
            hasTodoList: false,
            systemPrompt: "You are a helpful assistant.",
            conversationHistory: [],
            availableTools: {},
            ...overrides,
        });

        it("should build correction message for suppress-publish in pre-tool path", async () => {
            // Create a mock pre-tool heuristic that returns suppress-publish with reEngage: true
            const mockHeuristic: Heuristic<PreToolContext> = {
                id: "test-pretool-suppress",
                name: "Test PreTool Suppress",
                timing: "pre-tool-execution",
                toolFilter: ["test-tool"],
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test pre-tool trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test pre-tool prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Pre-tool correction message"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: true,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test pre-tool violation confirmed",
            });

            const context = createPreToolContext({
                toolName: "test-tool",
            });

            const result = await orchestrator.checkPreTool(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("suppress-publish");
            expect(result.correctionAction?.reEngage).toBe(true);
            expect(result.correctionAction?.message).toBe("Pre-tool correction message");
            expect(mockHeuristic.buildCorrectionMessage).toHaveBeenCalled();
        });

        it("should NOT build correction message for suppress-publish in pre-tool path when reEngage is false", async () => {
            const mockHeuristic: Heuristic<PreToolContext> = {
                id: "test-pretool-suppress-no-reengage",
                name: "Test PreTool Suppress No ReEngage",
                timing: "pre-tool-execution",
                toolFilter: ["test-tool"],
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Test pre-tool trigger",
                }),
                buildVerificationPrompt: vi.fn().mockReturnValue("Test pre-tool prompt"),
                buildCorrectionMessage: vi.fn().mockReturnValue("Should not be called"),
                getCorrectionAction: vi.fn().mockReturnValue({
                    type: "suppress-publish",
                    reEngage: false,
                    message: undefined,
                }),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mock the LLM service to return a violation
            (supervisorLLMService.verify as Mock).mockResolvedValueOnce({
                verdict: "violation",
                explanation: "Test pre-tool violation confirmed",
            });

            const context = createPreToolContext({
                toolName: "test-tool",
            });

            const result = await orchestrator.checkPreTool(context);

            expect(result.hasViolation).toBe(true);
            expect(result.correctionAction?.type).toBe("suppress-publish");
            expect(result.correctionAction?.reEngage).toBe(false);
            expect(result.correctionAction?.message).toBeUndefined();
            expect(mockHeuristic.buildCorrectionMessage).not.toHaveBeenCalled();
        });

        it("should skip already-enforced pre-tool heuristics when executionId is provided", async () => {
            const mockHeuristic: Heuristic<PreToolContext> = {
                id: "test-pretool-enforced",
                name: "Test PreTool Enforced",
                timing: "pre-tool-execution",
                toolFilter: ["test-tool"],
                detect: vi.fn().mockResolvedValue({
                    triggered: true,
                    reason: "Should not be called",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mark the heuristic as enforced
            orchestrator.markHeuristicEnforced("exec-1", "test-pretool-enforced");

            const context = createPreToolContext({
                toolName: "test-tool",
            });
            const result = await orchestrator.checkPreTool(context, "exec-1");

            // Should not have called detect because heuristic was already enforced
            expect(mockHeuristic.detect).not.toHaveBeenCalled();
            expect(result.hasViolation).toBe(false);
        });

        it("should run pre-tool heuristics without executionId (backward compatibility)", async () => {
            const mockHeuristic: Heuristic<PreToolContext> = {
                id: "test-pretool-no-exec-id",
                name: "Test PreTool No Exec ID",
                timing: "pre-tool-execution",
                toolFilter: ["test-tool"],
                detect: vi.fn().mockResolvedValue({
                    triggered: false,
                    reason: "Not triggered",
                }),
                buildVerificationPrompt: vi.fn(),
                buildCorrectionMessage: vi.fn(),
                getCorrectionAction: vi.fn(),
            };

            HeuristicRegistry.getInstance().register(mockHeuristic);

            // Mark heuristic as enforced for some execution
            orchestrator.markHeuristicEnforced("exec-1", "test-pretool-no-exec-id");

            const context = createPreToolContext({
                toolName: "test-tool",
            });
            // Call without executionId - should run all heuristics
            const result = await orchestrator.checkPreTool(context);

            // Should have called detect because no executionId was provided
            expect(mockHeuristic.detect).toHaveBeenCalled();
            expect(result.hasViolation).toBe(false);
        });
    });
});
