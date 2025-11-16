import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as path from "path";
import type { ExecutionContext } from "@/agents/execution/types";
import { RAGService } from "@/services/rag/RAGService";
import { RagSubscriptionService, SubscriptionStatus } from "@/services/rag/RagSubscriptionService";
import * as fs from "fs/promises";
import { createRAGSubscriptionCreateTool } from "../rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "../rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "../rag_subscription_get";
import { createRAGSubscriptionListTool } from "../rag_subscription_list";

describe("RAG Subscription Integration Tests", () => {
    const testDir = path.join(process.cwd(), ".tenex-test");
    const originalCwd = process.cwd();

    const validContext: ExecutionContext = {
        agent: {
            name: "test-agent",
            slug: "test-agent",
            pubkey: "test-agent-pubkey-valid",
        } as any,
        conversationId: "test-conversation",
        projectPath: testDir,
        triggeringEvent: {} as any,
        conversationCoordinator: {} as any,
        agentPublisher: {} as any,
    };

    const invalidContext: ExecutionContext = {
        agent: undefined as any,
        conversationId: "test-conversation",
        projectPath: testDir,
        triggeringEvent: {} as any,
        conversationCoordinator: {} as any,
        agentPublisher: {} as any,
    };

    beforeEach(async () => {
        // Reset singleton
        RagSubscriptionService.resetInstance();

        // Create test directory
        await fs.mkdir(testDir, { recursive: true });
        await fs.mkdir(path.join(testDir, ".tenex"), { recursive: true });
        process.chdir(testDir);

        // Initialize service at startup (as it should be)
        const service = RagSubscriptionService.getInstance();
        await service.initialize();
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        RagSubscriptionService.resetInstance();
        mock.restore();
    });

    describe("Agent Identity Validation", () => {
        test("should throw error when agent identity is missing for create", async () => {
            const tool = createRAGSubscriptionCreateTool(invalidContext);

            // Mock RAG service
            const ragService = RAGService.getInstance();
            const listSpy = spyOn(ragService, "listCollections");
            listSpy.mockResolvedValue(["test-collection"]);

            const resultStr = await tool.execute({
                subscriptionId: "test-sub",
                mcpServerId: "test-server",
                resourceUri: "test-resource",
                ragCollection: "test-collection",
                description: "Test subscription",
            });

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Agent identity is required");

            listSpy.mockRestore();
        });

        test("should throw error when agent identity is missing for list", async () => {
            const tool = createRAGSubscriptionListTool(invalidContext);

            const resultStr = await tool.execute();

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Agent identity is required");
        });

        test("should throw error when agent identity is missing for get", async () => {
            const tool = createRAGSubscriptionGetTool(invalidContext);

            const resultStr = await tool.execute({
                subscriptionId: "test-sub",
            });

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Agent identity is required");
        });

        test("should throw error when agent identity is missing for delete", async () => {
            const tool = createRAGSubscriptionDeleteTool(invalidContext);

            const resultStr = await tool.execute({
                subscriptionId: "test-sub",
            });

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Agent identity is required");
        });
    });

    describe("Service Method Mocking", () => {
        test("create tool should call service.createSubscription with correct parameters", async () => {
            const tool = createRAGSubscriptionCreateTool(validContext);
            const service = RagSubscriptionService.getInstance();

            // Mock RAG service
            const ragService = RAGService.getInstance();
            const listSpy = spyOn(ragService, "listCollections");
            listSpy.mockResolvedValue(["test-collection"]);

            // Mock the service method
            const createSpy = spyOn(service, "createSubscription");
            createSpy.mockResolvedValue({
                subscriptionId: "test-sub",
                agentPubkey: "test-agent-pubkey-valid",
                mcpServerId: "test-server",
                resourceUri: "test-resource",
                ragCollection: "test-collection",
                description: "Test subscription",
                status: SubscriptionStatus.RUNNING,
                documentsProcessed: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });

            const resultStr = await tool.execute({
                subscriptionId: "test-sub",
                mcpServerId: "test-server",
                resourceUri: "test-resource",
                ragCollection: "test-collection",
                description: "Test subscription",
            });

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(true);
            expect(createSpy).toHaveBeenCalledWith(
                "test-sub",
                "test-agent-pubkey-valid",
                "test-server",
                "test-resource",
                "test-collection",
                "Test subscription"
            );

            createSpy.mockRestore();
            listSpy.mockRestore();
        });

        test("list tool should call service.listSubscriptions with agent pubkey", async () => {
            const tool = createRAGSubscriptionListTool(validContext);
            const service = RagSubscriptionService.getInstance();

            // Mock the service method
            const listSpy = spyOn(service, "listSubscriptions");
            listSpy.mockResolvedValue([]);

            const resultStr = await tool.execute();

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(true);
            expect(listSpy).toHaveBeenCalledWith("test-agent-pubkey-valid");

            listSpy.mockRestore();
        });
    });

    describe("Resource Update Data Pipeline", () => {
        test("should trigger RAG document addition when resource is updated", async () => {
            const service = RagSubscriptionService.getInstance();
            const ragService = RAGService.getInstance();

            // Mock RAG service methods
            const listCollectionsSpy = spyOn(ragService, "listCollections");
            listCollectionsSpy.mockResolvedValue(["test-collection"]);

            const addDocumentsSpy = spyOn(ragService, "addDocuments");
            addDocumentsSpy.mockResolvedValue(undefined);

            // Create a subscription
            const subscription = await service.createSubscription(
                "pipeline-test",
                "test-agent",
                "test-server",
                "test-resource",
                "test-collection",
                "Pipeline test subscription"
            );

            // Simulate a resource update notification
            const notification = {
                method: "notifications/resources/updated",
                params: {
                    uri: "test-resource",
                    content: "This is updated content from the MCP resource",
                },
            };

            // Access the private handleResourceUpdate method through reflection
            // In a real scenario, this would be triggered by MCP
            const handleUpdate = (service as any).handleResourceUpdate.bind(service);
            await handleUpdate(subscription, notification);

            // Verify RAGService.addDocuments was called with correct data
            expect(addDocumentsSpy).toHaveBeenCalledTimes(1);
            const callArgs = addDocumentsSpy.mock.calls[0];
            expect(callArgs[0]).toBe("test-collection");
            expect(callArgs[1]).toHaveLength(1);
            expect(callArgs[1][0].content).toBe("This is updated content from the MCP resource");
            expect(callArgs[1][0].metadata.subscriptionId).toBe("pipeline-test");
            expect(callArgs[1][0].source).toBe("test-server:test-resource");

            // Verify subscription metrics were updated
            const updatedSub = await service.getSubscription("pipeline-test", "test-agent");
            expect(updatedSub?.documentsProcessed).toBe(1);
            expect(updatedSub?.lastDocumentIngested).toContain("This is updated content");

            addDocumentsSpy.mockRestore();
            listCollectionsSpy.mockRestore();
        });

        test("should handle errors in data pipeline gracefully", async () => {
            const service = RagSubscriptionService.getInstance();
            const ragService = RAGService.getInstance();

            // Mock RAG service methods
            const listCollectionsSpy = spyOn(ragService, "listCollections");
            listCollectionsSpy.mockResolvedValue(["test-collection"]);

            const addDocumentsSpy = spyOn(ragService, "addDocuments");
            addDocumentsSpy.mockImplementation(() =>
                Promise.reject(new Error("RAG service error"))
            );

            // Create a subscription
            const subscription = await service.createSubscription(
                "error-test",
                "test-agent",
                "test-server",
                "test-resource",
                "test-collection",
                "Error test subscription"
            );

            // Simulate a resource update notification
            const notification = {
                method: "notifications/resources/updated",
                params: {
                    content: "This content will fail to be added",
                },
            };

            // Handle the update
            const handleUpdate = (service as any).handleResourceUpdate.bind(service);
            await handleUpdate(subscription, notification);

            // Verify subscription status was updated to ERROR
            const updatedSub = await service.getSubscription("error-test", "test-agent");
            expect(updatedSub?.status).toBe(SubscriptionStatus.ERROR);
            expect(updatedSub?.lastError).toBe("RAG service error");

            addDocumentsSpy.mockRestore();
            listCollectionsSpy.mockRestore();
        });

        test("should handle various notification formats correctly", async () => {
            const service = RagSubscriptionService.getInstance();
            const ragService = RAGService.getInstance();

            // Mock RAG service methods
            const listCollectionsSpy = spyOn(ragService, "listCollections");
            listCollectionsSpy.mockResolvedValue(["test-collection"]);

            const addDocumentsSpy = spyOn(ragService, "addDocuments");
            addDocumentsSpy.mockResolvedValue(undefined);

            // Create a subscription
            const subscription = await service.createSubscription(
                "format-test",
                "test-agent",
                "test-server",
                "test-resource",
                "test-collection",
                "Format test subscription"
            );

            const handleUpdate = (service as any).handleResourceUpdate.bind(service);

            // Test different notification formats
            const formats = [
                { params: { content: "Direct content" } },
                { params: { data: { key: "value", nested: { data: "here" } } } },
                { params: { text: "Text format" } },
                { params: { someField: "fallback format" } },
            ];

            for (const notification of formats) {
                await handleUpdate(subscription, { method: "test", ...notification });
            }

            // Verify all formats were processed
            expect(addDocumentsSpy).toHaveBeenCalledTimes(4);

            // Check each format was handled correctly
            expect(addDocumentsSpy.mock.calls[0][1][0].content).toBe("Direct content");
            expect(addDocumentsSpy.mock.calls[1][1][0].content).toBe(
                '{"key":"value","nested":{"data":"here"}}'
            );
            expect(addDocumentsSpy.mock.calls[2][1][0].content).toBe("Text format");
            expect(addDocumentsSpy.mock.calls[3][1][0].content).toBe(
                '{"someField":"fallback format"}'
            );

            addDocumentsSpy.mockRestore();
            listCollectionsSpy.mockRestore();
        });
    });

    describe("Statistics Optimization", () => {
        test("list tool should calculate statistics in single pass", async () => {
            const service = RagSubscriptionService.getInstance();
            const ragService = RAGService.getInstance();

            // Mock RAG service
            const listCollectionsSpy = spyOn(ragService, "listCollections");
            listCollectionsSpy.mockResolvedValue(["test-collection"]);

            // Create multiple subscriptions with different states
            await service.createSubscription(
                "sub1",
                "test-agent-pubkey-valid",
                "server1",
                "res1",
                "test-collection",
                "Sub 1"
            );
            await service.createSubscription(
                "sub2",
                "test-agent-pubkey-valid",
                "server2",
                "res2",
                "test-collection",
                "Sub 2"
            );
            await service.createSubscription(
                "sub3",
                "test-agent-pubkey-valid",
                "server3",
                "res3",
                "test-collection",
                "Sub 3"
            );

            // Manually update states for testing
            const subs = await service.listSubscriptions("test-agent-pubkey-valid");
            subs[0].status = SubscriptionStatus.RUNNING;
            subs[0].documentsProcessed = 10;
            subs[1].status = SubscriptionStatus.ERROR;
            subs[1].documentsProcessed = 5;
            subs[2].status = SubscriptionStatus.STOPPED;
            subs[2].documentsProcessed = 3;

            // Use list tool
            const tool = createRAGSubscriptionListTool(validContext);
            const resultStr = await tool.execute();

            const result = JSON.parse(resultStr as string);
            expect(result.success).toBe(true);
            expect(result.statistics.total).toBe(3);
            expect(result.statistics.running).toBe(1);
            expect(result.statistics.error).toBe(1);
            expect(result.statistics.stopped).toBe(1);
            expect(result.statistics.totalDocumentsProcessed).toBe(18);

            // Verify subscriptions are formatted correctly
            expect(result.subscriptions).toHaveLength(3);
            expect(result.subscriptions[0].id).toBe("sub1");
            expect(result.subscriptions[0].status).toBe("RUNNING");

            listCollectionsSpy.mockRestore();
        });
    });
});
