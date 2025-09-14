import { describe, it, expect, beforeEach } from "vitest";
import { ParticipationIndex } from "../ParticipationIndex";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("ParticipationIndex", () => {
    let participationIndex: ParticipationIndex;

    beforeEach(() => {
        participationIndex = new ParticipationIndex();
    });

    // Helper to create mock events
    const createMockEvent = (id: string, pubkey: string): NDKEvent => ({
        id,
        pubkey,
        created_at: Date.now() / 1000,
        kind: 1,
        tags: [],
        content: `Message ${id}`,
        sig: 'mock-sig',
    } as NDKEvent);

    describe("buildIndex", () => {
        it("should build index of agent participations", () => {
            const agent1 = "agent1-pubkey";
            const agent2 = "agent2-pubkey";
            const user = "user-pubkey";

            const history = [
                createMockEvent("1", user),
                createMockEvent("2", agent1),
                createMockEvent("3", user),
                createMockEvent("4", agent2),
                createMockEvent("5", agent1),
            ];

            participationIndex.buildIndex("conv1", history);

            const agent1Participations = participationIndex.getAgentParticipations("conv1", agent1);
            const agent2Participations = participationIndex.getAgentParticipations("conv1", agent2);

            expect(agent1Participations).toHaveLength(2);
            expect(agent1Participations).toContain("2");
            expect(agent1Participations).toContain("5");

            expect(agent2Participations).toHaveLength(1);
            expect(agent2Participations).toContain("4");
        });

        it("should rebuild index when called multiple times", () => {
            const agent1 = "agent1-pubkey";

            const history1 = [
                createMockEvent("1", agent1),
                createMockEvent("2", agent1),
            ];

            const history2 = [
                createMockEvent("3", agent1),
            ];

            // Build with first history
            participationIndex.buildIndex("conv1", history1);
            let participations = participationIndex.getAgentParticipations("conv1", agent1);
            expect(participations).toHaveLength(2);

            // Rebuild with different history
            participationIndex.buildIndex("conv1", history2);
            participations = participationIndex.getAgentParticipations("conv1", agent1);
            expect(participations).toHaveLength(1);
            expect(participations).toContain("3");
        });
    });

    describe("hasAgentParticipated", () => {
        it("should correctly identify agent participation", () => {
            const agent1 = "agent1-pubkey";
            const agent2 = "agent2-pubkey";

            const history = [
                createMockEvent("1", agent1),
            ];

            participationIndex.buildIndex("conv1", history);

            expect(participationIndex.hasAgentParticipated("conv1", agent1)).toBe(true);
            expect(participationIndex.hasAgentParticipated("conv1", agent2)).toBe(false);
        });
    });

    describe("getParticipants", () => {
        it("should return all unique participants", () => {
            const agent1 = "agent1-pubkey";
            const agent2 = "agent2-pubkey";
            const user = "user-pubkey";

            const history = [
                createMockEvent("1", user),
                createMockEvent("2", agent1),
                createMockEvent("3", agent2),
                createMockEvent("4", agent1), // Duplicate participant
            ];

            participationIndex.buildIndex("conv1", history);

            const participants = participationIndex.getParticipants("conv1");

            expect(participants).toHaveLength(3);
            expect(participants).toContain(user);
            expect(participants).toContain(agent1);
            expect(participants).toContain(agent2);
        });
    });

    describe("getParticipationCount", () => {
        it("should return correct participation count", () => {
            const agent1 = "agent1-pubkey";

            const history = [
                createMockEvent("1", agent1),
                createMockEvent("2", agent1),
                createMockEvent("3", agent1),
            ];

            participationIndex.buildIndex("conv1", history);

            expect(participationIndex.getParticipationCount("conv1", agent1)).toBe(3);
            expect(participationIndex.getParticipationCount("conv1", "non-existent")).toBe(0);
        });
    });

    describe("clearConversation", () => {
        it("should clear index for a conversation", () => {
            const agent1 = "agent1-pubkey";

            const history = [
                createMockEvent("1", agent1),
            ];

            participationIndex.buildIndex("conv1", history);
            expect(participationIndex.hasAgentParticipated("conv1", agent1)).toBe(true);

            participationIndex.clearConversation("conv1");
            expect(participationIndex.hasAgentParticipated("conv1", agent1)).toBe(false);
        });
    });
});