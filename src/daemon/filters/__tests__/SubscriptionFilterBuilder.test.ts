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
