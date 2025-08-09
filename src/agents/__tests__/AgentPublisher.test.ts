import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { AgentPublisher } from "../AgentPublisher";
import type { AgentConfig } from "../types";
import { EVENT_KINDS } from "@/llm";
import type NDK from "@nostr-dev-kit/ndk";
import { type NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

// Mock implementations
const mockNDKEvent = {
    sign: mock(() => Promise.resolve()),
    publish: mock(() => Promise.resolve()),
    kind: 0,
    pubkey: "",
    content: "",
    tags: [] as string[][],
    ndk: null as any,
};

// Mock the NDKEvent constructor
const mockNDKEventConstructor = mock((ndk: any, data: any) => {
    Object.assign(mockNDKEvent, data, { ndk });
    return mockNDKEvent;
});

// Module mock
mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: mockNDKEventConstructor,
    NDKPrivateKeySigner: class {},
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Import logger after mocking
import { logger } from "@/utils/logger";

describe("AgentPublisher", () => {
    let agentPublisher: AgentPublisher;
    let mockNDK: NDK;
    let mockSigner: NDKPrivateKeySigner;

    beforeEach(() => {
        // Clear all mocks
        mockNDKEventConstructor.mockClear();
        mockNDKEvent.sign.mockClear();
        mockNDKEvent.publish.mockClear();
        (logger.info as any).mockClear();
        (logger.error as any).mockClear();

        // Reset mock event
        mockNDKEvent.sign.mockResolvedValue(undefined);
        mockNDKEvent.publish.mockResolvedValue(undefined);

        mockNDK = {} as NDK;
        mockSigner = {
            pubkey: "test-pubkey-123",
        } as NDKPrivateKeySigner;

        agentPublisher = new AgentPublisher(mockNDK);
    });

    describe("publishAgentProfile", () => {
        it("should publish agent profile with correct data", async () => {
            const agentName = "TestAgent";
            const agentRole = "Executor";
            const projectName = "TestProject";
            const projectPubkey = "project-pubkey-456";

            await agentPublisher.publishAgentProfile(
                mockSigner,
                agentName,
                agentRole,
                projectName,
                projectPubkey
            );

            // Verify NDKEvent was created with correct data
            expect(mockNDKEventConstructor).toHaveBeenCalledWith(mockNDK, {
                kind: 0,
                pubkey: mockSigner.pubkey,
                content: expect.stringContaining(agentName),
                tags: [["p", projectPubkey, "", "project"]],
            });

            // Verify profile content includes all required fields
            const callArgs = mockNDKEventConstructor.mock.calls[0];
            const profileContent = JSON.parse(callArgs[1].content);
            expect(profileContent).toMatchObject({
                name: agentName,
                role: agentRole,
                description: `${agentRole} agent for ${projectName}`,
                capabilities: [agentRole.toLowerCase()],
                picture: expect.stringContaining("dicebear.com"),
                project: projectName,
            });

            // Verify event was signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledWith(mockSigner);
            expect(mockNDKEvent.publish).toHaveBeenCalled();
        });

        it("should generate consistent avatar URL based on pubkey", async () => {
            await agentPublisher.publishAgentProfile(
                mockSigner,
                "TestAgent",
                "Executor",
                "TestProject",
                "project-pubkey"
            );

            const callArgs = mockNDKEventConstructor.mock.calls[0];
            const profileContent = JSON.parse(callArgs[1].content);
            expect(profileContent.picture).toBe(
                `https://api.dicebear.com/7.x/bottts/svg?seed=${mockSigner.pubkey}`
            );
        });

        it("should throw error when publishing fails", async () => {
            const publishError = new Error("Network error");
            mockNDKEvent.publish.mockRejectedValue(publishError);

            await expect(
                agentPublisher.publishAgentProfile(
                    mockSigner,
                    "TestAgent",
                    "Executor",
                    "TestProject",
                    "project-pubkey"
                )
            ).rejects.toThrow("Network error");

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to publish agent profile",
                expect.objectContaining({
                    error: publishError,
                    agentName: "TestAgent",
                })
            );
        });
    });

    describe("publishAgentRequest", () => {
        it("should publish agent request without NDKAgentDefinition event", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const projectPubkey = "project-pubkey-456";

            const result = await agentPublisher.publishAgentRequest(
                mockSigner,
                agentConfig,
                projectPubkey
            );

            // Verify NDKEvent was created with correct data
            expect(mockNDKEventConstructor).toHaveBeenCalledWith(mockNDK, {
                kind: EVENT_KINDS.AGENT_REQUEST,
                content: "",
                tags: [["p", projectPubkey], ["name", agentConfig.name]],
            });

            // Verify event was signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledWith(mockSigner);
            expect(mockNDKEvent.publish).toHaveBeenCalled();

            // Verify returned event
            expect(result).toBe(mockNDKEvent);
        });

        it("should publish agent request with NDKAgentDefinition event reference", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const projectPubkey = "project-pubkey-456";
            const ndkAgentEventId = "ndk-agent-event-789";

            await agentPublisher.publishAgentRequest(
                mockSigner,
                agentConfig,
                projectPubkey,
                ndkAgentEventId
            );

            // Verify e-tag was added for NDKAgentDefinition event
            expect(mockNDKEventConstructor).toHaveBeenCalledWith(mockNDK, {
                kind: EVENT_KINDS.AGENT_REQUEST,
                content: "",
                tags: [
                    ["p", projectPubkey],
                    ["e", ndkAgentEventId, "", "agent-definition"],
                    ["name", agentConfig.name],
                ],
            });
        });

        it("should throw error when publishing fails", async () => {
            const publishError = new Error("Publishing failed");
            mockNDKEvent.publish.mockRejectedValue(publishError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentRequest(mockSigner, agentConfig, "project-pubkey")
            ).rejects.toThrow("Publishing failed");

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to publish agent request",
                expect.objectContaining({
                    error: publishError,
                    agentName: "TestAgent",
                })
            );
        });
    });

    describe("publishAgentCreation", () => {
        it("should publish both profile and request events", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const projectName = "TestProject";
            const projectPubkey = "project-pubkey-456";

            await agentPublisher.publishAgentCreation(
                mockSigner,
                agentConfig,
                projectName,
                projectPubkey
            );

            // Verify both events were created
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(2);

            // First call should be profile event (kind 0)
            expect(mockNDKEventConstructor.mock.calls[0][1].kind).toBe(0);

            // Second call should be request event
            expect(mockNDKEventConstructor.mock.calls[1][1].kind).toBe(
                EVENT_KINDS.AGENT_REQUEST
            );

            // Verify both were signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledTimes(2);
            expect(mockNDKEvent.publish).toHaveBeenCalledTimes(2);
        });

        it("should propagate NDKAgentDefinition event ID to request", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const ndkAgentEventId = "ndk-agent-event-789";

            await agentPublisher.publishAgentCreation(
                mockSigner,
                agentConfig,
                "TestProject",
                "project-pubkey",
                ndkAgentEventId
            );

            // Verify second event (request) has e-tag
            const requestEventCall = mockNDKEventConstructor.mock.calls[1][1];
            expect(requestEventCall.tags).toContainEqual([
                "e",
                ndkAgentEventId,
                "",
                "agent-definition",
            ]);
        });

        it("should handle profile publishing failure", async () => {
            const profileError = new Error("Profile publishing failed");
            mockNDKEvent.publish.mockRejectedValueOnce(profileError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentCreation(
                    mockSigner,
                    agentConfig,
                    "TestProject",
                    "project-pubkey"
                )
            ).rejects.toThrow("Profile publishing failed");

            // Verify request was not attempted after profile failure
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(1);
        });

        it("should handle request publishing failure", async () => {
            const requestError = new Error("Request publishing failed");
            // First publish succeeds, second fails
            mockNDKEvent.publish
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(requestError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentCreation(
                    mockSigner,
                    agentConfig,
                    "TestProject",
                    "project-pubkey"
                )
            ).rejects.toThrow("Request publishing failed");

            // Verify both events were attempted
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(2);
        });
    });
});