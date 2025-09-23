import { ReplaceableEventService } from "../replaceable-event";
import type { NDK } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

describe("ReplaceableEventService", () => {
  let mockNDK: jest.Mocked<NDK>;
  let service: ReplaceableEventService;
  const testPrivateKey = NDKPrivateKeySigner.generate().privateKey;
  const testKind = 14199;

  beforeEach(() => {
    // Create mock NDK
    mockNDK = {
      fetchEvents: jest.fn().mockResolvedValue(new Set()),
      createEvent: jest.fn(),
    } as unknown as jest.Mocked<NDK>;

    service = new ReplaceableEventService(mockNDK, testPrivateKey, testKind);
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
      
      mockNDK.fetchEvents.mockResolvedValue(new Set([mockEvent as any]));
      
      await service.initialize();
      
      expect(mockNDK.fetchEvents).toHaveBeenCalledWith({
        kinds: [testKind],
        authors: [expect.any(String)],
        limit: 1,
      });
      
      expect(service.getTags()).toEqual(existingTags);
    });

    it("should start with empty tags if no existing event", async () => {
      mockNDK.fetchEvents.mockResolvedValue(new Set());
      
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
      
      tags.forEach(tag => service.addTag(tag));
      
      const mockEvent = {
        sign: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn().mockResolvedValue(undefined),
      };
      
      mockNDK.createEvent.mockReturnValue(mockEvent as any);
      
      await service.publish();
      
      expect(mockNDK.createEvent).toHaveBeenCalledWith({
        kind: testKind,
        content: "",
        tags: tags,
        pubkey: expect.any(String),
        created_at: expect.any(Number),
      });
      
      expect(mockEvent.sign).toHaveBeenCalled();
      expect(mockEvent.publish).toHaveBeenCalled();
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