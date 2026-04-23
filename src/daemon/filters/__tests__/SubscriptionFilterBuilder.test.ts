import { describe, test, expect } from "bun:test";
import { buildStaticFilters, buildProjectTaggedFilter, buildAgentMentionsFilter, buildLessonFilter } from "../SubscriptionFilterBuilder";
import { NDKKind } from "@/nostr/kinds";

describe("SubscriptionFilterBuilder", () => {
    describe("buildStaticFilters", () => {
        test("returns empty array when no whitelisted pubkeys", () => {
            const filters = buildStaticFilters(new Set());
            expect(filters).toEqual([]);
        });

        test("returns three filters: project discovery, ops, and lesson comments", () => {
            const filters = buildStaticFilters(
                new Set(["whitelist1", "whitelist2"])
            );
            expect(filters).toHaveLength(3);

            // First filter: project discovery (replaceable events, no since)
            expect(filters[0].kinds).toEqual([31933]);
            expect(filters[0].authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));
            expect(filters[0].since).toBeUndefined();

            // Second filter: config updates + deletions
            expect(filters[1].kinds).toEqual([
                NDKKind.TenexAgentConfigUpdate,
                NDKKind.TenexAgentDelete,
            ]);
            expect(filters[1].authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));

            // Third filter: lesson comments (no #p filter)
            expect(filters[2].kinds).toEqual([NDKKind.Comment]);
            expect(filters[2]["#K"]).toEqual([String(NDKKind.AgentLesson)]);
            expect(filters[2].authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));
            expect(filters[2]["#p"]).toBeUndefined();
        });

        test("applies since to operational filters but not project discovery", () => {
            const since = Math.floor(Date.now() / 1000);
            const filters = buildStaticFilters(
                new Set(["whitelist1"]),
                since
            );
            expect(filters).toHaveLength(3);

            // Project discovery: no since
            expect(filters[0].since).toBeUndefined();

            // Ops filter: has since
            expect(filters[1].since).toBe(since);

            // Lesson comments: has since
            expect(filters[2].since).toBe(since);
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
