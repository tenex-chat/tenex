import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { config } from "@/services/ConfigService";
import { InterventionService } from "@/services/intervention";
import { projectContextStore } from "@/services/projects";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Daemon } from "../Daemon";

function getDaemonInternals(daemon: Daemon) {
    const d = daemon as any;
    return {
        setWhitelistedPubkeys: (pubkeys: string[]) => {
            d.whitelistedPubkeys = pubkeys;
        },
        setAgentPubkeyToProjects: (mapping: Map<string, Set<string>>) => {
            d.agentPubkeyToProjects = mapping;
        },
        checkInterventionTriggers: (event: NDKEvent, runtime: any, projectId: string) =>
            d.checkInterventionTriggers(event, runtime, projectId),
    };
}

describe("Daemon intervention triggers", () => {
    const projectId = "project-123";
    const agentPubkey = "a".repeat(64);
    const userPubkey = "b".repeat(64);
    let daemon: Daemon;
    let internals: ReturnType<typeof getDaemonInternals>;
    let mockInterventionService: {
        isEnabled: ReturnType<typeof mock>;
        setProject: ReturnType<typeof mock>;
        onUserResponse: ReturnType<typeof mock>;
        onAgentCompletion: ReturnType<typeof mock>;
    };

    beforeEach(() => {
        spyOn(config, "getConfig").mockReturnValue({});
        spyOn(config, "getConfigPath").mockImplementation(
            (subdir?: string) => `/mock/path/${subdir || ""}`
        );
        spyOn(config, "getWhitelistedPubkeys").mockReturnValue([]);
        spyOn(config, "getBackendSigner").mockResolvedValue({
            pubkey: "mock-backend-pubkey",
        } as any);
        spyOn(projectContextStore, "getContext").mockImplementation(() => undefined);
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});

        mockInterventionService = {
            isEnabled: mock(() => true),
            setProject: mock(() => Promise.resolve()),
            onUserResponse: mock(() => undefined),
            onAgentCompletion: mock(() => undefined),
        };
        spyOn(InterventionService, "getInstance").mockReturnValue(
            mockInterventionService as unknown as InterventionService
        );

        spyOn(ConversationStore, "findByEventId").mockReturnValue({
            id: "conversation-123",
            getRootAuthorPubkey: () => userPubkey,
        } as any);

        daemon = new Daemon();
        internals = getDaemonInternals(daemon);
        internals.setWhitelistedPubkeys([userPubkey]);
        internals.setAgentPubkeyToProjects(new Map([[agentPubkey, new Set([projectId])]]));
    });

    afterEach(() => {
        mock.restore();
    });

    test("ignores non-final agent text events", async () => {
        const event = {
            kind: 1,
            pubkey: agentPubkey,
            created_at: 1_700_000_000,
            tags: [
                ["e", "root-event-id", "", "root"],
                ["p", userPubkey],
            ],
            tagValue(name: string, marker?: string) {
                if (name === "e" && marker === "root") {
                    return "root-event-id";
                }
                if (marker !== undefined) {
                    return undefined;
                }
                return this.tags.find((tag: string[]) => tag[0] === name)?.[1];
            },
        } as unknown as NDKEvent;

        await internals.checkInterventionTriggers(event, { getContext: () => ({}) }, projectId);

        expect(mockInterventionService.setProject).not.toHaveBeenCalled();
        expect(mockInterventionService.onAgentCompletion).not.toHaveBeenCalled();
        expect(mockInterventionService.onUserResponse).not.toHaveBeenCalled();
    });

    test("ignores final completed agent events", async () => {
        const event = {
            kind: 1,
            pubkey: agentPubkey,
            created_at: 1_700_000_000,
            tags: [
                ["e", "root-event-id", "", "root"],
                ["p", userPubkey],
                ["status", "completed"],
            ],
            tagValue(name: string, marker?: string) {
                if (name === "e" && marker === "root") {
                    return "root-event-id";
                }
                if (marker !== undefined) {
                    return undefined;
                }
                return this.tags.find((tag: string[]) => tag[0] === name)?.[1];
            },
        } as unknown as NDKEvent;

        await internals.checkInterventionTriggers(event, { getContext: () => ({}) }, projectId);

        expect(mockInterventionService.setProject).not.toHaveBeenCalled();
        expect(mockInterventionService.onAgentCompletion).not.toHaveBeenCalled();
        expect(mockInterventionService.onUserResponse).not.toHaveBeenCalled();
    });

    test("still cancels intervention on user replies", async () => {
        const event = {
            kind: 1,
            pubkey: userPubkey,
            created_at: 1_700_000_001,
            tags: [["e", "root-event-id", "", "root"]],
            tagValue(name: string, marker?: string) {
                if (name === "e" && marker === "root") {
                    return "root-event-id";
                }
                if (marker !== undefined) {
                    return undefined;
                }
                return this.tags.find((tag: string[]) => tag[0] === name)?.[1];
            },
        } as unknown as NDKEvent;

        await internals.checkInterventionTriggers(event, { getContext: () => ({}) }, projectId);

        expect(mockInterventionService.setProject).toHaveBeenCalledWith(projectId);
        expect(mockInterventionService.onUserResponse).toHaveBeenCalledWith(
            "conversation-123",
            1_700_000_001_000,
            userPubkey
        );
        expect(mockInterventionService.onAgentCompletion).not.toHaveBeenCalled();
    });
});
