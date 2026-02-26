import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// --- Mocks (must be set up before dynamic imports) ---

const mockWriteReport = mock(() =>
    Promise.resolve({
        encodedId: "naddr1test",
        addressableRef: "30023:pubkey123:test-slug",
    })
);

const mockValidateSlug = mock(() => {});
const mockWriteLocalReport = mock(() => Promise.resolve());
const mockGetReportPath = mock(() => "/tmp/reports/test-slug.md");

mock.module("@/services/reports", () => ({
    ReportService: class {
        writeReport = mockWriteReport;
    },
    getLocalReportStore: () => ({
        validateSlug: mockValidateSlug,
        writeReport: mockWriteLocalReport,
        getReportPath: mockGetReportPath,
    }),
    InvalidSlugError: class InvalidSlugError extends Error {
        constructor(slug: string, reason: string) {
            super(`Invalid slug "${slug}": ${reason}`);
            this.name = "InvalidSlugError";
        }
    },
}));

const mockIndexReport = mock(() => Promise.resolve(true));

mock.module("@/services/reports/ReportEmbeddingService", () => ({
    getReportEmbeddingService: () => ({
        indexReport: mockIndexReport,
    }),
}));

const mockTagId = mock(() => "31933:owner:test-project");
mock.module("@/services/projects", () => ({
    getProjectContext: () => ({
        project: { tagId: mockTagId },
    }),
}));

mock.module("@/services/ral", () => ({
    RALRegistry: class {},
    PendingDelegationsRegistry: {
        registerAddressable: mock(() => {}),
    },
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
const { createReportWriteTool } = await import("../report_write");

describe("report_write tool", () => {
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
        mockWriteReport.mockClear();
        mockIndexReport.mockClear();
        mockValidateSlug.mockClear();
        mockWriteLocalReport.mockClear();
    });

    it("should call indexReport after a successful write", async () => {
        const tool = createReportWriteTool(mockContext);

        const result = await (tool as any).execute({
            slug: "test-slug",
            title: "Test Report",
            summary: "A test report",
            content: "Report content here",
            hashtags: ["test"],
            memorize: false,
            memorize_team: false,
        });

        expect(result.success).toBe(true);

        // Verify indexReport was called
        expect(mockIndexReport).toHaveBeenCalledTimes(1);

        const [reportArg, projectIdArg, pubkeyArg, nameArg] = mockIndexReport.mock.calls[0];

        expect(reportArg.slug).toBe("test-slug");
        expect(reportArg.title).toBe("Test Report");
        expect(reportArg.summary).toBe("A test report");
        expect(reportArg.content).toBe("Report content here");
        expect(reportArg.hashtags).toEqual(["test"]);
        // publishedAt should be present and in seconds (not milliseconds)
        expect(reportArg.publishedAt).toBeDefined();
        const nowInSeconds = Math.floor(Date.now() / 1000);
        expect(reportArg.publishedAt).toBeGreaterThan(nowInSeconds - 5);
        expect(reportArg.publishedAt).toBeLessThanOrEqual(nowInSeconds);
        expect(projectIdArg).toBe("31933:owner:test-project");
        expect(pubkeyArg).toBe("pubkey123");
        expect(nameArg).toBe("TestAgent");
    });

    it("should not fail the write if RAG indexing throws", async () => {
        mockIndexReport.mockImplementationOnce(() => {
            throw new Error("RAG unavailable");
        });

        const tool = createReportWriteTool(mockContext);

        const result = await (tool as any).execute({
            slug: "test-slug",
            title: "Test Report",
            summary: "Summary",
            content: "Content",
            hashtags: [],
            memorize: false,
            memorize_team: false,
        });

        // Write should still succeed despite RAG failure
        expect(result.success).toBe(true);
        expect(mockIndexReport).toHaveBeenCalledTimes(1);
    });
});
