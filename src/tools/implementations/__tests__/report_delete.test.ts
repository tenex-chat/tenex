import { beforeEach, describe, expect, it, mock } from "bun:test";

// --- Mocks (must be set up before dynamic imports) ---

const mockDeleteReport = mock(() => Promise.resolve("naddr1deleted"));

mock.module("@/services/reports", () => ({
    ReportService: class {
        deleteReport = mockDeleteReport;
    },
}));

const mockRemoveReport = mock(() => Promise.resolve());

mock.module("@/services/reports/ReportEmbeddingService", () => ({
    getReportEmbeddingService: () => ({
        removeReport: mockRemoveReport,
    }),
}));

const mockTagId = mock(() => "31933:owner:test-project");
mock.module("@/services/projects", () => ({
    getProjectContext: () => ({
        project: { tagId: mockTagId },
    }),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
    },
}));

// Dynamic import after mocks
const { createReportDeleteTool } = await import("../report_delete");

describe("report_delete tool", () => {
    const mockContext = {
        agent: {
            name: "TestAgent",
            slug: "test-agent",
            pubkey: "pubkey123",
            signer: {},
            sign: mock(() => Promise.resolve()),
        },
        conversationId: "test-conv-123",
        workingDirectory: "/tmp/test",
        projectBasePath: "/tmp/test",
        currentBranch: "main",
        triggeringEvent: {},
        getConversation: () => undefined,
        agentPublisher: {},
        ralNumber: 1,
    } as any;

    beforeEach(() => {
        mockDeleteReport.mockClear();
        mockRemoveReport.mockClear();
    });

    it("should call removeReport after a successful delete", async () => {
        const tool = createReportDeleteTool(mockContext);

        const result = await (tool as any).execute({ slug: "test-slug" });

        expect(result.success).toBe(true);
        expect(result.slug).toBe("test-slug");

        // Verify removeReport was called with correct args
        expect(mockRemoveReport).toHaveBeenCalledTimes(1);
        const [slugArg, projectIdArg] = mockRemoveReport.mock.calls[0];
        expect(slugArg).toBe("test-slug");
        expect(projectIdArg).toBe("31933:owner:test-project");
    });

    it("should not fail the delete if RAG removal throws", async () => {
        mockRemoveReport.mockImplementationOnce(() => {
            throw new Error("RAG unavailable");
        });

        const tool = createReportDeleteTool(mockContext);

        const result = await (tool as any).execute({ slug: "test-slug" });

        // Delete should still succeed despite RAG failure
        expect(result.success).toBe(true);
        expect(mockRemoveReport).toHaveBeenCalledTimes(1);
    });
});
