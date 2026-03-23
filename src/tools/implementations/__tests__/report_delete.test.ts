import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as nostrModule from "@/nostr";
import * as projectsModule from "@/services/projects";
import * as reportEmbeddingModule from "@/services/reports/ReportEmbeddingService";
import * as reportsModule from "@/services/reports";
import { logger } from "@/utils/logger";
import { createReportDeleteTool } from "../report_delete";

const mockDeleteReport = mock(() => Promise.resolve("naddr1deleted"));
const mockRemoveReport = mock(() => Promise.resolve());
const mockTagId = mock(() => "31933:owner:test-project");

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
        triggeringEnvelope: {},
        getConversation: () => undefined,
        agentPublisher: {},
        ralNumber: 1,
    } as any;

    beforeEach(() => {
        mockDeleteReport.mockClear();
        mockRemoveReport.mockClear();
        mockTagId.mockClear();

        spyOn(nostrModule, "getNDK").mockReturnValue({} as ReturnType<typeof nostrModule.getNDK>);
        spyOn(reportsModule.ReportService.prototype, "deleteReport").mockImplementation(
            mockDeleteReport as typeof reportsModule.ReportService.prototype.deleteReport
        );
        spyOn(reportEmbeddingModule, "getReportEmbeddingService").mockReturnValue({
            removeReport: mockRemoveReport,
        } as ReturnType<typeof reportEmbeddingModule.getReportEmbeddingService>);
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: { tagId: mockTagId },
        } as ReturnType<typeof projectsModule.getProjectContext>);
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    it("should call removeReport after a successful delete", async () => {
        const tool = createReportDeleteTool(mockContext);

        const result = await (tool as any).execute({ slug: "test-slug" });

        expect(result.success).toBe(true);
        expect(result.slug).toBe("test-slug");

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

        expect(result.success).toBe(true);
        expect(mockRemoveReport).toHaveBeenCalledTimes(1);
    });
});
