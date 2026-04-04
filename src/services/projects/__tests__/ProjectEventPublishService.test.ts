import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as collectEventsModule from "@/nostr/collectEvents";
import { NDKKind } from "@/nostr/kinds";
import * as ndkClientModule from "@/nostr/ndkClient";
import * as nip46Module from "@/services/nip46";
import { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { ProjectEventPublishService } from "../ProjectEventPublishService";

const OWNER_PUBKEY = "a".repeat(64);
const PROJECT_DTAG = "TENEX-ff3ssq";
const PM_PUBKEY = "b".repeat(64);
const REMOVED_PUBKEY = "c".repeat(64);
const ADDED_PUBKEY = "d".repeat(64);

const mockCollectEvents = mock();
const mockSignEvent = mock();
const mockIsEnabled = mock(() => true);
const mockPublishLog = mock();

function createProjectEvent(overrides: Partial<NDKProject> = {}): NDKProject {
    const event = new NDKProject({} as never);
    event.kind = NDKKind.Project;
    event.id = overrides.id ?? "old-event-id";
    event.sig = overrides.sig ?? "old-sig";
    event.created_at = overrides.created_at ?? 100;
    event.pubkey = overrides.pubkey ?? OWNER_PUBKEY;
    event.content = overrides.content ?? "Old description";
    event.tags = overrides.tags ?? [
        ["d", PROJECT_DTAG],
        ["title", "Old title"],
        ["repo", "https://old.example"],
        ["picture", "https://old.example/image.png"],
        ["p", PM_PUBKEY, "pm"],
        ["p", REMOVED_PUBKEY],
    ];
    return event;
}

describe("ProjectEventPublishService", () => {
    let collectEventsSpy: ReturnType<typeof spyOn>;
    let initNDKSpy: ReturnType<typeof spyOn>;
    let getNDKSpy: ReturnType<typeof spyOn>;
    let getSignerSpy: ReturnType<typeof spyOn>;
    let getSigningLogSpy: ReturnType<typeof spyOn>;
    let publishSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockCollectEvents.mockReset();
        mockSignEvent.mockReset();
        mockIsEnabled.mockReset();
        mockPublishLog.mockReset();
        mockIsEnabled.mockReturnValue(true);

        collectEventsSpy = spyOn(collectEventsModule, "collectEvents")
            .mockImplementation(mockCollectEvents as never);
        initNDKSpy = spyOn(ndkClientModule, "initNDK")
            .mockImplementation(async () => undefined as never);
        getNDKSpy = spyOn(ndkClientModule, "getNDK")
            .mockReturnValue({} as never);
        getSignerSpy = spyOn(nip46Module.Nip46SigningService, "getInstance")
            .mockReturnValue({
                isEnabled: mockIsEnabled,
                signEvent: mockSignEvent,
            } as never);
        getSigningLogSpy = spyOn(nip46Module.Nip46SigningLog, "getInstance")
            .mockReturnValue({ log: mockPublishLog } as never);
        publishSpy = spyOn(NDKEvent.prototype, "publish")
            .mockImplementation(async () => undefined as never);
    });

    afterEach(() => {
        collectEventsSpy?.mockRestore();
        initNDKSpy?.mockRestore();
        getNDKSpy?.mockRestore();
        getSignerSpy?.mockRestore();
        getSigningLogSpy?.mockRestore();
        publishSpy?.mockRestore();
        mock.restore();
    });

    it("publishes canonical metadata and p-tag mutations with stripped signing fields", async () => {
        mockCollectEvents.mockResolvedValue([createProjectEvent()]);

        let signedSnapshot: {
            created_at: number | undefined;
            id: string | undefined;
            sig: string | undefined;
            content: string;
            tags: string[][];
        } | null = null;

        mockSignEvent.mockImplementation(async (_owner: string, event: NDKProject) => {
            signedSnapshot = {
                created_at: event.created_at,
                id: event.id,
                sig: event.sig,
                content: event.content,
                tags: event.tags.map((tag) => [...tag]),
            };
            event.id = "new-event-id";
            return { outcome: "signed" };
        });

        const service = new ProjectEventPublishService();
        const result = await service.publishMutation({
            ownerPubkey: OWNER_PUBKEY,
            projectDTag: PROJECT_DTAG,
            trigger: "modify_project_31933",
            addAgentPubkeys: [ADDED_PUBKEY],
            removeAgentPubkeys: [REMOVED_PUBKEY],
            set: {
                title: "New title",
                repo: "https://new.example",
                image: "https://new.example/image.png",
                description: "New description",
            },
        });

        expect(result.outcome).toBe("published");
        expect(result.eventId).toBe("new-event-id");
        expect(result.addedPubkeys).toEqual([ADDED_PUBKEY]);
        expect(result.removedPubkeys).toEqual([REMOVED_PUBKEY]);
        expect(result.updatedFields).toEqual(["title", "repo", "image", "description"]);
        expect(signedSnapshot).not.toBeNull();
        expect(signedSnapshot?.created_at).toBeUndefined();
        expect(signedSnapshot?.id).toBeUndefined();
        expect(signedSnapshot?.sig).toBeUndefined();
        expect(signedSnapshot?.content).toBe("New description");
        expect(signedSnapshot?.tags).toContainEqual(["d", PROJECT_DTAG]);
        expect(signedSnapshot?.tags).toContainEqual(["title", "New title"]);
        expect(signedSnapshot?.tags).toContainEqual(["repo", "https://new.example"]);
        expect(signedSnapshot?.tags).toContainEqual(["picture", "https://new.example/image.png"]);
        expect(signedSnapshot?.tags).toContainEqual(["p", PM_PUBKEY, "pm"]);
        expect(signedSnapshot?.tags).toContainEqual(["p", ADDED_PUBKEY]);
        expect(signedSnapshot?.tags.some((tag) => tag[0] === "p" && tag[1] === REMOVED_PUBKEY)).toBe(false);
        expect(mockSignEvent).toHaveBeenCalledTimes(1);
        expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it("returns no_changes for idempotent add/remove/set requests", async () => {
        mockCollectEvents.mockResolvedValue([createProjectEvent({
            content: "Existing description",
            tags: [
                ["d", PROJECT_DTAG],
                ["title", "Existing title"],
                ["p", PM_PUBKEY],
            ],
        })]);

        const service = new ProjectEventPublishService();
        const result = await service.publishMutation({
            ownerPubkey: OWNER_PUBKEY,
            projectDTag: PROJECT_DTAG,
            trigger: "modify_project_31933",
            addAgentPubkeys: [PM_PUBKEY],
            removeAgentPubkeys: [REMOVED_PUBKEY],
            set: {
                title: "Existing title",
                description: "Existing description",
            },
        });

        expect(result.outcome).toBe("no_changes");
        expect(result.addedPubkeys).toEqual([]);
        expect(result.removedPubkeys).toEqual([]);
        expect(result.updatedFields).toEqual([]);
        expect(result.skipped).toEqual([
            `agent ${REMOVED_PUBKEY} already absent`,
            `agent ${PM_PUBKEY} already present`,
            "title unchanged",
            "description unchanged",
        ]);
        expect(mockSignEvent).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it("selects the latest event by created_at and id", async () => {
        mockCollectEvents.mockResolvedValue([
            createProjectEvent({ id: "a-event", created_at: 50 }),
            createProjectEvent({ id: "z-event", created_at: 100 }),
            createProjectEvent({ id: "b-event", created_at: 100 }),
        ]);

        const service = new ProjectEventPublishService();
        const latest = await service.fetchLatestProjectEvent({
            projectDTag: PROJECT_DTAG,
            ownerPubkey: OWNER_PUBKEY,
            includeDeleted: true,
        });

        expect(latest?.id).toBe("z-event");
    });

    it("treats a deleted latest project event as unavailable by default", async () => {
        mockCollectEvents.mockResolvedValue([
            createProjectEvent({
                id: "deleted-event",
                tags: [
                    ["d", PROJECT_DTAG],
                    ["deleted", "true"],
                ],
            }),
        ]);

        const service = new ProjectEventPublishService();
        const latest = await service.fetchLatestProjectEvent({
            projectDTag: PROJECT_DTAG,
            ownerPubkey: OWNER_PUBKEY,
        });

        expect(latest).toBeNull();
    });
});
