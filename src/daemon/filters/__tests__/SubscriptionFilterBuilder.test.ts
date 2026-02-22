import { describe, test, expect } from "bun:test";
import { SubscriptionFilterBuilder, type SubscriptionConfig } from "../SubscriptionFilterBuilder";
import { NDKKind } from "@/nostr/kinds";

describe("SubscriptionFilterBuilder", () => {
    describe("buildLessonCommentFilter", () => {
        test("returns null when no agent pubkeys", () => {
            const result = SubscriptionFilterBuilder.buildLessonCommentFilter(
                new Set(),
                new Set(["whitelist1"])
            );
            expect(result).toBeNull();
        });

        test("returns null when no whitelisted pubkeys", () => {
            const result = SubscriptionFilterBuilder.buildLessonCommentFilter(
                new Set(["agent1"]),
                new Set()
            );
            expect(result).toBeNull();
        });

        test("returns filter with correct structure", () => {
            const agentPubkeys = new Set(["agent1", "agent2"]);
            const whitelistedPubkeys = new Set(["whitelist1", "whitelist2"]);

            const result = SubscriptionFilterBuilder.buildLessonCommentFilter(
                agentPubkeys,
                whitelistedPubkeys
            );

            expect(result).not.toBeNull();
            expect(result?.kinds).toEqual([NDKKind.Comment]);
            expect(result?.["#K"]).toEqual(["4129"]); // Lessons
            expect(result?.["#p"]).toEqual(expect.arrayContaining(["agent1", "agent2"]));
            expect(result?.authors).toEqual(expect.arrayContaining(["whitelist1", "whitelist2"]));
        });
    });

    describe("buildFilters", () => {
        test("includes lesson comment filter when agents and whitelist present", () => {
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(["def1"]),
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            // Check that a lesson comment filter exists
            const commentFilter = filters.find(f => f.kinds?.includes(NDKKind.Comment));
            expect(commentFilter).toBeDefined();
            expect(commentFilter?.["#K"]).toEqual(["4129"]);
        });

        test("excludes lesson comment filter when no agents", () => {
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(), // no agents
                agentDefinitionIds: new Set(),
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            const commentFilter = filters.find(f => f.kinds?.includes(NDKKind.Comment));
            expect(commentFilter).toBeUndefined();
        });
    });

    describe("since filter", () => {
        test("applies since to project-tagged filter when provided", () => {
            const since = Math.floor(Date.now() / 1000);
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(),
                since,
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            // Find the project-tagged filter (has #a but no specific kind like 30023)
            const projectTaggedFilter = filters.find(
                f => f["#a"] && !f.kinds?.includes(30023)
            );
            expect(projectTaggedFilter).toBeDefined();
            expect(projectTaggedFilter?.since).toBe(since);
        });

        test("applies since to agent mentions filter when provided", () => {
            const since = Math.floor(Date.now() / 1000);
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(),
                since,
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            const agentMentionsFilter = filters.find(f => f["#p"] && !f.kinds);
            expect(agentMentionsFilter).toBeDefined();
            expect(agentMentionsFilter?.since).toBe(since);
        });

        test("does not apply since when not provided", () => {
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(),
                // No since
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            // No filter should have a since property
            for (const filter of filters) {
                expect(filter.since).toBeUndefined();
            }
        });

        test("does not apply since to project events filter (kind 31933)", () => {
            const since = Math.floor(Date.now() / 1000);
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(),
                since,
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);

            // Project events filter (kind 31933) should NOT have since
            // (we always want the latest project definitions)
            const projectFilter = filters.find(f => f.kinds?.includes(31933));
            expect(projectFilter).toBeDefined();
            expect(projectFilter?.since).toBeUndefined();
        });
    });

    describe("getFilterStats", () => {
        test("includes lessonCommentFilter in stats", () => {
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(["agent1"]),
                agentDefinitionIds: new Set(["def1"]),
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);
            const stats = SubscriptionFilterBuilder.getFilterStats(filters);

            expect(stats.lessonCommentFilter).toBe(true);
        });

        test("shows false for lessonCommentFilter when not present", () => {
            const config: SubscriptionConfig = {
                whitelistedPubkeys: new Set(["whitelist1"]),
                knownProjects: new Set(["31933:author:project"]),
                agentPubkeys: new Set(),
                agentDefinitionIds: new Set(),
            };

            const filters = SubscriptionFilterBuilder.buildFilters(config);
            const stats = SubscriptionFilterBuilder.getFilterStats(filters);

            expect(stats.lessonCommentFilter).toBe(false);
        });
    });
});
