import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Mock dependencies before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock NDK
const mockFetchEvents = mock();
const mockNDK = {
    fetchEvents: mockFetchEvents,
};

mock.module("@/nostr", () => ({
    getNDK: () => mockNDK,
}));

// Mock project context
const mockProject = {
    tagId: () => "31933:projectpubkey:project-slug",
};

const mockReportsCache = new Map<string, any>();

const mockProjectContext = {
    project: mockProject,
    reports: mockReportsCache, // Add the reports Map for cache size logging
    getReport: (pubkey: string, slug: string) => mockReportsCache.get(`${pubkey}:${slug}`),
    getReportBySlug: (slug: string) => {
        for (const report of mockReportsCache.values()) {
            if (report.slug === slug) return report;
        }
        return undefined;
    },
    getAllReports: () => Array.from(mockReportsCache.values()),
    addReport: (report: any) => {
        // Extract pubkey from author (simplified for tests)
        const pubkey = report.author.startsWith("npub1") ? "decoded-pubkey" : report.author;
        mockReportsCache.set(`${pubkey}:${report.slug}`, report);
    },
    projectManager: { pubkey: "pm-pubkey" },
    agents: new Map([
        ["agent1", { pubkey: "agent1-pubkey" }],
        ["agent2", { pubkey: "agent2-pubkey" }],
    ]),
};

mock.module("@/services/projects", () => ({
    getProjectContext: () => mockProjectContext,
}));

import { ReportService } from "../ReportService";

describe("ReportService", () => {
    let reportService: ReportService;

    beforeEach(() => {
        mockReportsCache.clear();
        mockFetchEvents.mockReset();
        reportService = new ReportService(mockNDK as any);
    });

    describe("readReport - cross-agent access", () => {
        it("should find a report by slug from cache regardless of author", async () => {
            // Agent 1 creates a report
            const report = {
                id: "nostr:naddr1...",
                slug: "architecture-doc",
                title: "Architecture Documentation",
                content: "Project architecture details",
                author: "agent1-pubkey",
                publishedAt: 1234567890,
            };
            mockReportsCache.set("agent1-pubkey:architecture-doc", report);

            // Agent 2 (different agent) tries to read by slug
            const result = await reportService.readReport("architecture-doc");

            expect(result).not.toBeNull();
            expect(result?.slug).toBe("architecture-doc");
            expect(result?.title).toBe("Architecture Documentation");
            expect(result?.author).toBe("agent1-pubkey");
        });

        it("should call NDK with project-scoped filter when not in cache", async () => {
            // When not in cache, NDK should be called with project-scoped filter
            mockFetchEvents.mockResolvedValue(new Set()); // Empty result

            await reportService.readReport("design-decisions");

            // Verify the filter used project tag (#a) to scope to project
            expect(mockFetchEvents).toHaveBeenCalledWith({
                kinds: [30023],
                "#d": ["design-decisions"],
                "#a": ["31933:projectpubkey:project-slug"],
            });
        });

        it("should return null when report not found in project", async () => {
            mockFetchEvents.mockResolvedValue(new Set());

            const result = await reportService.readReport("non-existent-report");

            expect(result).toBeNull();
        });

        it("should use slug-based search for non-naddr identifiers", async () => {
            mockFetchEvents.mockResolvedValue(new Set());

            // Non-naddr identifier should use project-scoped slug search
            await reportService.readReport("some-slug");

            // Verify it uses the project-scoped filter (not author-based)
            expect(mockFetchEvents).toHaveBeenCalledWith({
                kinds: [30023],
                "#d": ["some-slug"],
                "#a": ["31933:projectpubkey:project-slug"],
            });
        });
    });

    describe("listReports - project-wide listing", () => {
        it("should return all reports when no agent filter provided", async () => {
            // Add reports from different agents
            mockReportsCache.set("agent1-pubkey:report1", {
                id: "nostr:naddr1...",
                slug: "report1",
                title: "Report 1",
                author: "agent1-pubkey",
                publishedAt: 1234567890,
            });
            mockReportsCache.set("agent2-pubkey:report2", {
                id: "nostr:naddr2...",
                slug: "report2",
                title: "Report 2",
                author: "agent2-pubkey",
                publishedAt: 1234567891,
            });

            const reports = await reportService.listReports();

            expect(reports.length).toBe(2);
            expect(reports.map((r) => r.slug)).toContain("report1");
            expect(reports.map((r) => r.slug)).toContain("report2");
        });

        it("should filter by agent pubkey when provided", async () => {
            mockReportsCache.set("agent1-pubkey:report1", {
                id: "nostr:naddr1...",
                slug: "report1",
                title: "Report 1",
                author: "agent1-pubkey",
                publishedAt: 1234567890,
            });
            mockReportsCache.set("agent2-pubkey:report2", {
                id: "nostr:naddr2...",
                slug: "report2",
                title: "Report 2",
                author: "agent2-pubkey",
                publishedAt: 1234567891,
            });

            const reports = await reportService.listReports(["agent1-pubkey"]);

            expect(reports.length).toBe(1);
            expect(reports[0].slug).toBe("report1");
            expect(reports[0].author).toBe("agent1-pubkey");
        });

        it("should exclude deleted reports", async () => {
            mockReportsCache.set("agent1-pubkey:active", {
                id: "nostr:naddr1...",
                slug: "active",
                title: "Active Report",
                author: "agent1-pubkey",
                publishedAt: 1234567890,
                isDeleted: false,
            });
            mockReportsCache.set("agent1-pubkey:deleted", {
                id: "nostr:naddr2...",
                slug: "deleted",
                title: "Deleted Report",
                author: "agent1-pubkey",
                publishedAt: 1234567891,
                isDeleted: true,
            });

            const reports = await reportService.listReports();

            expect(reports.length).toBe(1);
            expect(reports[0].slug).toBe("active");
        });

        it("should sort reports by published date (newest first)", async () => {
            mockReportsCache.set("agent1-pubkey:old", {
                id: "nostr:naddr1...",
                slug: "old",
                title: "Old Report",
                author: "agent1-pubkey",
                publishedAt: 1000000000,
            });
            mockReportsCache.set("agent1-pubkey:new", {
                id: "nostr:naddr2...",
                slug: "new",
                title: "New Report",
                author: "agent1-pubkey",
                publishedAt: 2000000000,
            });

            const reports = await reportService.listReports();

            expect(reports[0].slug).toBe("new");
            expect(reports[1].slug).toBe("old");
        });
    });

    describe("getAllProjectAgentPubkeys", () => {
        it("should return all agent pubkeys from project context", () => {
            const pubkeys = reportService.getAllProjectAgentPubkeys();

            expect(pubkeys).toContain("pm-pubkey");
            expect(pubkeys).toContain("agent1-pubkey");
            expect(pubkeys).toContain("agent2-pubkey");
        });
    });
});
