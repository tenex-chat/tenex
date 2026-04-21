import { describe, expect, it } from "bun:test";
import subscriptionFilterFixture from "@/test-utils/fixtures/daemon/subscription-filters.compat.json";
import {
    buildAgentMentionsFilter,
    buildLessonFilter,
    buildProjectTaggedFilter,
    buildStaticFilters,
} from "../SubscriptionFilterBuilder";

describe("SubscriptionFilterBuilder compatibility fixtures", () => {
    it("matches canonical daemon subscription filters", () => {
        const since = subscriptionFilterFixture.since;
        const whitelistedPubkeys = new Set(subscriptionFilterFixture.whitelistedPubkeys);
        const knownProjects = new Set(subscriptionFilterFixture.knownProjectAddresses);
        const agentPubkeys = new Set(subscriptionFilterFixture.agentPubkeys);

        expect(buildStaticFilters(whitelistedPubkeys, since)).toEqual(
            subscriptionFilterFixture.filters.static
        );
        expect(buildProjectTaggedFilter(knownProjects, since)).toEqual(
            subscriptionFilterFixture.filters.projectTagged
        );
        expect(buildAgentMentionsFilter(agentPubkeys, since)).toEqual(
            subscriptionFilterFixture.filters.agentMentions
        );
        expect(buildLessonFilter(subscriptionFilterFixture.lessonDefinitionId)).toEqual(
            subscriptionFilterFixture.filters.lesson
        );
        expect(buildStaticFilters(new Set())).toEqual(
            subscriptionFilterFixture.filters.emptyStatic
        );
        expect(buildProjectTaggedFilter(new Set())).toBe(
            subscriptionFilterFixture.filters.emptyProjectTagged
        );
        expect(buildAgentMentionsFilter(new Set())).toBe(
            subscriptionFilterFixture.filters.emptyAgentMentions
        );
    });
});
