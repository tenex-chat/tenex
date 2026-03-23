import { describe, test, expect } from "bun:test";
import { buildStaticFilters, buildProjectTaggedFilter, buildReportFilter, buildAgentMentionsFilter, buildLessonFilter } from "../SubscriptionFilterBuilder";
import { NDKKind } from "@/nostr/kinds";

describe("SubscriptionFilterBuilder", () => {
    describe("buildStaticFilters", () => {
        test("returns empty array when no whitelisted pubkeys", () => {
            const filters = buildStaticFilters(new Set());
            expect(filters).toEqual([]);
        });

        test("returns project discovery + config update + agent deletion filter and lesson comment filter", () => {
            const filters = buildStaticFilters(
                new Set(["whitelist1", "whitelist2"])
            );
            expect(filters).toHaveLength(2);

            // First filter: project discovery + config updates + agent deletions
            expect(filters[0].kinds).toEqual([31933, NDKKind.TenexAgentConfigUpdate, NDKKind.TenexAgentDelete]);
            expect(filters[0].authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));

            // Second filter: lesson comments (no #p filter)
            expect(filters[1].kinds).toEqual([NDKKind.Comment]);
            expect(filters[1]["#K"]).toEqual([String(NDKKind.AgentLesson)]);
            expect(filters[1].authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));
            expect(filters[1]["#p"]).toBeUndefined();
        });
    });

    describe("buildProjectTaggedFilter", () => {
        test("returns null when no projects", () => {
            const result = buildProjectTaggedFilter(new Set());
            expect(result).toBeNull();
        });

        test("returns filter with #a tags", () => {
            const result = buildProjectTaggedFilter(
                new Set(["31933:author:project"])
            );
            expect(result).not.toBeNull();
            expect(result?.["#a"]).toEqual(["31933:author:project"]);
        });

        test("applies since when provided", () => {
            const since = Math.floor(Date.now() / 1000);
            const result = buildProjectTaggedFilter(
                new Set(["31933:author:project"]),
                since
            );
            expect(result?.since).toBe(since);
        });

        test("does not apply since when not provided", () => {
            const result = buildProjectTaggedFilter(
                new Set(["31933:author:project"])
            );
            expect(result?.since).toBeUndefined();
        });
    });

    describe("buildReportFilter", () => {
        test("returns null when no projects", () => {
            const result = buildReportFilter(new Set());
            expect(result).toBeNull();
        });

        test("returns filter with kind 30023 and #a tags", () => {
            const result = buildReportFilter(
                new Set(["31933:author:project"])
            );
            expect(result).not.toBeNull();
            expect(result?.kinds).toEqual([30023]);
            expect(result?.["#a"]).toEqual(["31933:author:project"]);
        });
    });

    describe("buildAgentMentionsFilter", () => {
        test("returns null when no agent pubkeys", () => {
            const result = buildAgentMentionsFilter(new Set());
            expect(result).toBeNull();
        });

        test("returns filter with #p tags", () => {
            const result = buildAgentMentionsFilter(
                new Set(["agent1", "agent2"])
            );
            expect(result).not.toBeNull();
            expect(result?.["#p"]).toEqual(expect.arrayContaining(["agent1", "agent2"]));
        });

        test("applies since when provided", () => {
            const since = Math.floor(Date.now() / 1000);
            const result = buildAgentMentionsFilter(
                new Set(["agent1"]),
                since
            );
            expect(result?.since).toBe(since);
        });
    });

    describe("buildLessonFilter", () => {
        test("returns filter with kind 4129 and #e tag", () => {
            const result = buildLessonFilter("def123");
            expect(result.kinds).toEqual([NDKKind.AgentLesson]);
            expect(result["#e"]).toEqual(["def123"]);
        });
    });
});
