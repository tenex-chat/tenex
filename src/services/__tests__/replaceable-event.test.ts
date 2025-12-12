import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NDK } from "@nostr-dev-kit/ndk";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { ReplaceableEventService } from "../replaceable-event";

describe("ReplaceableEventService", () => {
    let mockNDK: Partial<NDK>;
    let service: ReplaceableEventService;
    const testPrivateKey = NDKPrivateKeySigner.generate().privateKey;
    const testKind = 14199;

    beforeEach(() => {
        // Create mock NDK
        mockNDK = {
            fetchEvents: mock(() => Promise.resolve(new Set())),
        } as unknown as Partial<NDK>;

        service = new ReplaceableEventService(mockNDK as NDK, testPrivateKey!, testKind);
    });

    describe("initialize", () => {
        it("should fetch existing event and load tags", async () => {
            const existingTags = [
                ["a", "31337:pubkey1:identifier1"],
                ["g", "agentpubkey1"],
            ];

            const mockEvent = {
                tags: existingTags,
            };

            (mockNDK.fetchEvents as any).mockResolvedValue(new Set([mockEvent as any]));

            await service.initialize();

            expect(mockNDK.fetchEvents).toHaveBeenCalledWith({
                kinds: [testKind],
                authors: [expect.any(String)],
                limit: 1,
            });

            expect(service.getTags()).toEqual(existingTags);
        });

        it("should start with empty tags if no existing event", async () => {
            (mockNDK.fetchEvents as any).mockResolvedValue(new Set());

            await service.initialize();

            expect(service.getTags()).toEqual([]);
        });
    });

    describe("addTag", () => {
        beforeEach(async () => {
            await service.initialize();
        });

        it("should add new tag and return true", () => {
            const newTag = ["a", "31337:pubkey:identifier"];

            const result = service.addTag(newTag);

            expect(result).toBe(true);
            expect(service.getTags()).toContainEqual(newTag);
        });

        it("should not add duplicate tag and return false", () => {
            const tag = ["a", "31337:pubkey:identifier"];

            service.addTag(tag);
            const result = service.addTag(tag);

            expect(result).toBe(false);
            expect(service.getTags()).toHaveLength(1);
        });

        it("should handle different tag types", () => {
            const aTag = ["a", "31337:pubkey:project1"];
            const gTag = ["g", "agentpubkey1"];
            const pTag = ["p", "whitelistedpubkey1"];

            expect(service.addTag(aTag)).toBe(true);
            expect(service.addTag(gTag)).toBe(true);
            expect(service.addTag(pTag)).toBe(true);

            expect(service.getTags()).toHaveLength(3);
            expect(service.getTags()).toContainEqual(aTag);
            expect(service.getTags()).toContainEqual(gTag);
            expect(service.getTags()).toContainEqual(pTag);
        });
    });

    describe("removeTag", () => {
        beforeEach(async () => {
            await service.initialize();
        });

        it("should remove existing tag and return true", () => {
            const tag = ["a", "31337:pubkey:identifier"];

            service.addTag(tag);
            const result = service.removeTag(tag);

            expect(result).toBe(true);
            expect(service.getTags()).not.toContainEqual(tag);
        });

        it("should return false if tag doesn't exist", () => {
            const tag = ["a", "31337:pubkey:nonexistent"];

            const result = service.removeTag(tag);

            expect(result).toBe(false);
        });
    });

    describe("hasTag", () => {
        beforeEach(async () => {
            await service.initialize();
        });

        it("should return true for existing tag", () => {
            const tag = ["g", "agentpubkey"];

            service.addTag(tag);

            expect(service.hasTag(tag)).toBe(true);
        });

        it("should return false for non-existing tag", () => {
            const tag = ["g", "nonexistentpubkey"];

            expect(service.hasTag(tag)).toBe(false);
        });
    });

    describe("publish", () => {
        beforeEach(async () => {
            await service.initialize();
        });

        it("should create and publish event with current tags", async () => {
            const tags = [
                ["a", "31337:pubkey1:project1"],
                ["g", "agentpubkey1"],
                ["p", "whitelistedpubkey1"],
            ];

            tags.forEach((tag) => service.addTag(tag));

            // Mock NDKEvent.prototype methods
            const signSpy = spyOn(NDKEvent.prototype, "sign").mockResolvedValue(undefined as any);
            const publishSpy = spyOn(NDKEvent.prototype, "publish").mockResolvedValue(new Set() as any);

            await service.publish();

            expect(signSpy).toHaveBeenCalled();
            expect(publishSpy).toHaveBeenCalled();

            // Cleanup
            signSpy.mockRestore();
            publishSpy.mockRestore();
        });
    });

    describe("getPubkey", () => {
        it("should return the public key derived from private key", () => {
            const pubkey = service.getPubkey();

            expect(pubkey).toBeDefined();
            expect(typeof pubkey).toBe("string");
            expect(pubkey).toHaveLength(64); // Hex pubkey is 64 chars
        });
    });
});
