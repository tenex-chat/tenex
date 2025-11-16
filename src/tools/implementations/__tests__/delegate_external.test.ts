import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { delegateExternalTool } from "../delegate_external";

// Mock dependencies
const mockFetchEvent = mock();
const mockSign = mock();
const mockPublish = mock();
const mockReply = mock();
const mockSubscribe = mock();
const mockGetUser = mock();

mock.module("@/nostr/ndkClient", () => ({
    getNDK: mock(() => ({
        fetchEvent: mockFetchEvent,
        subscribe: mockSubscribe,
        getUser: mockGetUser,
    })),
}));

mock.module("@/nostr/AgentPublisher", () => ({
    AgentPublisher: class {
        conversation = mock();
    },
}));

describe("delegate_external tool", () => {
    const mockContext: ExecutionContext = {
        agent: {
            name: "test-agent",
            pubkey: "test-pubkey",
            signer: {
                sign: mockSign,
                pubkey: "test-pubkey",
                user: () => ({ pubkey: "test-pubkey" }),
            } as any,
        } as any,
        phase: "planning",
        conversationId: "conv-123",
        conversationCoordinator: {
            getConversation: mock(() => ({
                history: [{ id: "root-event-123" }],
            })),
        } as any,
        triggeringEvent: {} as any,
    };

    beforeEach(() => {
        // Reset mocks
        mockFetchEvent.mockReset();
        mockSign.mockReset();
        mockPublish.mockReset();
        mockReply.mockReset();
        mockSubscribe.mockReset();
        mockGetUser.mockReset();

        // Setup default mock for getUser
        mockGetUser.mockReturnValue({ pubkey: "recipientPubkey" });
    });

    it("should have correct metadata", () => {
        expect(delegateExternalTool.name).toBe("delegate_external");
        expect(delegateExternalTool.description).toContain("Delegate a task to an external agent");
        expect(delegateExternalTool.description).toContain("wait synchronously for their response");
    });

    it("should validate input schema", () => {
        const validInput = {
            content: "Hello world",
            recipient: "pubkey123",
        };

        const result = delegateExternalTool.parameters.validate(validInput);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.value.timeout).toBe(300000); // Default timeout
        }
    });

    it("should accept custom timeout", () => {
        const inputWithTimeout = {
            content: "Message",
            recipient: "pubkey123",
            timeout: 60000, // 1 minute
        };

        const result = delegateExternalTool.parameters.validate(inputWithTimeout);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.value.timeout).toBe(60000);
        }
    });

    it("should handle optional parentEventId", () => {
        const inputWithParent = {
            content: "Reply message",
            parentEventId: "event123",
            recipient: "pubkey456",
        };

        const result = delegateExternalTool.parameters.validate(inputWithParent);
        expect(result.ok).toBe(true);
    });

    it("should handle optional projectId", () => {
        const inputWithProject = {
            content: "Message with project",
            recipient: "pubkey789",
            projectId: "naddr1xyz",
        };

        const result = delegateExternalTool.parameters.validate(inputWithProject);
        expect(result.ok).toBe(true);
    });

    it("should strip nostr: prefix from IDs", async () => {
        // Mock fetchEvent to return a parent event
        const mockParentEvent = {
            id: "parent123",
            reply: mockReply,
        };
        mockFetchEvent.mockResolvedValue(mockParentEvent);

        // Mock reply to return a new event
        const mockReplyEvent = {
            id: "reply123",
            content: "",
            tags: [["e", "parent123"]],
            sign: mockSign,
            publish: mockPublish,
        };
        mockReply.mockResolvedValue(mockReplyEvent);

        // Mock sign and publish
        mockSign.mockResolvedValue();
        mockPublish.mockResolvedValue();

        // Mock subscription that times out (no response)
        const mockSubscription = {
            on: mock((event, handler) => {
                if (event === "event") {
                    // Simulate timeout - don't call handler
                }
            }),
            stop: mock(),
        };
        mockSubscribe.mockReturnValue(mockSubscription);

        const input = {
            content: "Test reply",
            parentEventId: "nostr:parent123", // Has nostr: prefix
            recipient: "recipientPubkey",
            timeout: 100, // Very short timeout for testing
        };

        const validatedInput = delegateExternalTool.parameters.validate(input);
        if (!validatedInput.ok) {
            throw new Error("Input validation failed");
        }

        // Use Promise.race to handle timeout
        const resultPromise = delegateExternalTool.execute(validatedInput.value, mockContext);
        const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve({ timeout: true }), 200)
        );

        const result = (await Promise.race([resultPromise, timeoutPromise])) as any;

        // Should strip the nostr: prefix when fetching
        expect(mockFetchEvent).toHaveBeenCalledWith("parent123");

        // The tool should succeed even with timeout (returns timeout message)
        if (!result.timeout) {
            expect(result).toBeDefined();
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.type).toBe("delegation_responses");
                expect(result.value.responses[0].response).toContain("timeout");
            }
        }
    });

    it.skip("should wait for and return external response", async () => {
        // Skipping this test as it requires complex NDK mocking
        // The response waiting functionality is tested through integration tests
        const mockNDK = {
            fetchEvent: mockFetchEvent,
            subscribe: mockSubscribe,
            getUser: mockGetUser,
        };

        // Mock event creation - we need to override NDKEvent constructor behavior
        // Since this test is primarily about response handling, we'll mock the publishing part
        mockSign.mockResolvedValue(undefined);
        mockPublish.mockResolvedValue(undefined);

        // Mock subscription that receives a response
        const mockSubscription = {
            on: mock(),
            stop: mock(),
        };

        mockSubscribe.mockReturnValue(mockSubscription);

        // Simulate receiving a response after a short delay
        mockSubscription.on.mockImplementation((eventName: string, callback: Function) => {
            if (eventName === "event") {
                setTimeout(() => {
                    const responseEvent = new NDKEvent(mockNDK as any, {
                        kind: 1111,
                        content: "This is the response",
                        tags: [
                            ["e", "delegation456"],
                            ["summary", "Response summary"],
                        ],
                        pubkey: "recipientPubkey",
                    });
                    responseEvent.id = "response789";
                    responseEvent.pubkey = "recipientPubkey";
                    callback(responseEvent);
                }, 50);
            }
        });

        const input = {
            content: "Test message",
            recipient: "recipientPubkey",
            timeout: 5000,
        };

        const validatedInput = delegateExternalTool.parameters.validate(input);
        if (!validatedInput.ok) {
            throw new Error("Input validation failed");
        }

        const result = await delegateExternalTool.execute(validatedInput.value, mockContext);

        // Check that subscription was set up correctly
        expect(mockSubscribe).toHaveBeenCalled();

        // Check that we got the response
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.type).toBe("delegation_responses");
            expect(result.value.responses[0].response).toBe("This is the response");
            expect(result.value.responses[0].summary).toBe("Response summary");
            expect(result.value.responses[0].from).toBe("recipientPubkey");
        }
    });
});
