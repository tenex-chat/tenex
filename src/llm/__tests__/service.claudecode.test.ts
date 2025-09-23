import { LLMService } from "../service";
import { compileMessagesForClaudeCode, convertSystemMessagesForResume } from "../utils/claudeCodePromptCompiler";
import type { LLMLogger } from "@/logging/LLMLogger";
import type { ModelMessage } from "ai";
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe("LLMService Claude Code Integration", () => {
    let llmLogger: LLMLogger;
    let service: LLMService;

    beforeEach(() => {
        // Mock logger
        llmLogger = {
            logLLMRequest: vi.fn().mockResolvedValue(undefined),
            logLLMResponse: vi.fn().mockResolvedValue(undefined),
        } as unknown as LLMLogger;
    });

    describe("compileMessagesForClaudeCode", () => {
        it("should extract first system message as customSystemPrompt and preserve order", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "You are a helpful assistant." },
                { role: "system", content: "Additional context here." },
                { role: "user", content: "Hello" },
            ];

            const result = compileMessagesForClaudeCode(messages);

            expect(result.customSystemPrompt).toBe("You are a helpful assistant.");
            expect(result.appendSystemPrompt).toContain("[System]: Additional context here");
            expect(result.appendSystemPrompt).toContain("[User]: Hello");
            // Verify order is preserved
            const systemIndex = result.appendSystemPrompt!.indexOf("[System]: Additional context here");
            const userIndex = result.appendSystemPrompt!.indexOf("[User]: Hello");
            expect(systemIndex).toBeLessThan(userIndex);
        });

        it("should compile conversation history preserving order", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "System prompt" },
                { role: "user", content: "First user message" },
                { role: "assistant", content: "First assistant response" },
                { role: "user", content: "Second user message" },
            ];

            const result = compileMessagesForClaudeCode(messages);

            expect(result.customSystemPrompt).toBe("System prompt");
            expect(result.appendSystemPrompt).toContain("=== Conversation History ===");
            expect(result.appendSystemPrompt).toContain("[User]: First user message");
            expect(result.appendSystemPrompt).toContain("[Assistant]: First assistant response");
            expect(result.appendSystemPrompt).toContain("[User]: Second user message");
            expect(result.appendSystemPrompt).toContain("=== End History ===");
        });

        it("should preserve interleaved system messages in order", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Main system prompt" },
                { role: "user", content: "User says hello" },
                { role: "system", content: "Phase transition" },
                { role: "assistant", content: "Assistant response" },
            ];

            const result = compileMessagesForClaudeCode(messages);

            expect(result.customSystemPrompt).toBe("Main system prompt");
            expect(result.appendSystemPrompt).toContain("[User]: User says hello");
            expect(result.appendSystemPrompt).toContain("[System]: Phase transition");
            expect(result.appendSystemPrompt).toContain("[Assistant]: Assistant response");

            // Verify order
            const userIndex = result.appendSystemPrompt!.indexOf("[User]: User says hello");
            const systemIndex = result.appendSystemPrompt!.indexOf("[System]: Phase transition");
            const assistantIndex = result.appendSystemPrompt!.indexOf("[Assistant]: Assistant response");
            expect(userIndex).toBeLessThan(systemIndex);
            expect(systemIndex).toBeLessThan(assistantIndex);
        });

        it("should return undefined appendSystemPrompt when only one system message", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Only system prompt" },
            ];

            const result = compileMessagesForClaudeCode(messages);

            expect(result.customSystemPrompt).toBe("Only system prompt");
            expect(result.appendSystemPrompt).toBeUndefined();
        });

        it("should handle messages without system prompt", () => {
            const messages: ModelMessage[] = [
                { role: "user", content: "User message" },
                { role: "assistant", content: "Assistant response" },
            ];

            const result = compileMessagesForClaudeCode(messages);

            expect(result.customSystemPrompt).toBeUndefined();
            expect(result.appendSystemPrompt).toContain("=== Conversation History ===");
            expect(result.appendSystemPrompt).toContain("[User]: User message");
            expect(result.appendSystemPrompt).toContain("[Assistant]: Assistant response");
        });
    });

    describe("convertSystemMessagesForResume", () => {
        it("should keep initial system messages unchanged", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Initial system prompt" },
                { role: "system", content: "More system context" },
                { role: "user", content: "First user message" },
                { role: "assistant", content: "Response" },
            ];

            const result = convertSystemMessagesForResume(messages);

            expect(result[0]).toEqual({ role: "system", content: "Initial system prompt" });
            expect(result[1]).toEqual({ role: "system", content: "More system context" });
            expect(result[2]).toEqual({ role: "user", content: "First user message" });
            expect(result[3]).toEqual({ role: "assistant", content: "Response" });
        });

        it("should convert system messages after conversation start to user messages", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Initial prompt" },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi there" },
                { role: "system", content: "New system context added" },
                { role: "user", content: "Continue" },
            ];

            const result = convertSystemMessagesForResume(messages);

            expect(result[0]).toEqual({ role: "system", content: "Initial prompt" });
            expect(result[1]).toEqual({ role: "user", content: "Hello" });
            expect(result[2]).toEqual({ role: "assistant", content: "Hi there" });
            expect(result[3]).toEqual({ role: "user", content: "[System Context]: New system context added" });
            expect(result[4]).toEqual({ role: "user", content: "Continue" });
        });

        it("should handle multiple system messages appearing mid-conversation", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Initial" },
                { role: "user", content: "Start" },
                { role: "system", content: "Context 1" },
                { role: "system", content: "Context 2" },
                { role: "assistant", content: "Response" },
                { role: "system", content: "Context 3" },
            ];

            const result = convertSystemMessagesForResume(messages);

            expect(result[0]).toEqual({ role: "system", content: "Initial" });
            expect(result[1]).toEqual({ role: "user", content: "Start" });
            expect(result[2]).toEqual({ role: "user", content: "[System Context]: Context 1" });
            expect(result[3]).toEqual({ role: "user", content: "[System Context]: Context 2" });
            expect(result[4]).toEqual({ role: "assistant", content: "Response" });
            expect(result[5]).toEqual({ role: "user", content: "[System Context]: Context 3" });
        });

        it("should handle case with no system messages", () => {
            const messages: ModelMessage[] = [
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi" },
            ];

            const result = convertSystemMessagesForResume(messages);

            expect(result).toEqual(messages); // Should be unchanged
        });

        it("should handle case with only system messages", () => {
            const messages: ModelMessage[] = [
                { role: "system", content: "Context 1" },
                { role: "system", content: "Context 2" },
            ];

            const result = convertSystemMessagesForResume(messages);

            expect(result).toEqual(messages); // Should be unchanged as no conversation started
        });
    });

    describe("getLanguageModel with Claude Code", () => {
        it("should use resume option when sessionId is provided", () => {
            const mockProviderFunction = vi.fn().mockReturnValue({
                doGenerate: vi.fn(),
                doStream: vi.fn(),
            });

            service = new LLMService(
                llmLogger,
                null,
                "claudeCode",
                "opus",
                undefined,
                undefined,
                mockProviderFunction,
                "existing-session-123" // Session ID for resuming
            );

            // Access private method through any type casting for testing
            const model = (service as any).getLanguageModel([
                { role: "system", content: "System prompt" },
                { role: "user", content: "User message" },
            ]);

            // Verify provider was called with resume option
            expect(mockProviderFunction).toHaveBeenCalledWith("opus", {
                resume: "existing-session-123"
            });
        });

        it("should compile messages when NOT resuming", () => {
            const mockProviderFunction = vi.fn().mockReturnValue({
                doGenerate: vi.fn(),
                doStream: vi.fn(),
            });

            service = new LLMService(
                llmLogger,
                null,
                "claudeCode",
                "opus",
                undefined,
                undefined,
                mockProviderFunction
                // No session ID - not resuming
            );

            const messages: ModelMessage[] = [
                { role: "system", content: "Main prompt" },
                { role: "system", content: "Additional context" },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi there" },
            ];

            // Access private method through any type casting for testing
            const model = (service as any).getLanguageModel(messages);

            // Verify provider was called with compiled prompts
            expect(mockProviderFunction).toHaveBeenCalledWith("opus", {
                customSystemPrompt: "Main prompt",
                appendSystemPrompt: expect.stringContaining("Additional context")
            });

            const call = mockProviderFunction.mock.calls[0];
            expect(call[1].appendSystemPrompt).toContain("[User]: Hello");
            expect(call[1].appendSystemPrompt).toContain("[Assistant]: Hi there");
        });
    });
});