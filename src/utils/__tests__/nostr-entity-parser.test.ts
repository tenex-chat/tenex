import { beforeAll, describe, expect, it, spyOn, afterEach } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { normalizeNostrIdentifier, parseNostrEvent, parseNostrUser, isHexPrefix, resolvePrefixToId, normalizeLessonEventId } from "../nostr-entity-parser";
import { prefixKVStore } from "@/services/storage";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

describe("nostr-entity-parser", () => {
    let ndk: NDK;

    beforeAll(() => {
        ndk = new NDK();
    });

    describe("parseNostrUser", () => {
        it("should parse hex pubkey", () => {
            const pubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(parseNostrUser(pubkey)).toBe(pubkey);
        });

        it("should parse hex pubkey with nostr: prefix", () => {
            const pubkey = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(parseNostrUser(`nostr:${pubkey}`)).toBe(pubkey);
        });

        it("should parse npub", () => {
            const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
            const expectedPubkey =
                "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(parseNostrUser(npub)).toBe(expectedPubkey);
        });

        it("should parse npub with nostr: prefix", () => {
            const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
            const expectedPubkey =
                "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(parseNostrUser(`nostr:${npub}`)).toBe(expectedPubkey);
        });

        it("should parse nprofile", () => {
            const nprofile =
                "nprofile1qqs0awzzutnzfj6cudj03a7txc7qxsrma9ge44yrym6337tkkd23qkg32nsh9";
            const expectedPubkey =
                "feb842e2e624cb58e364f8f7cb363c03407be9519ad48326f518f976b3551059";
            expect(parseNostrUser(nprofile)).toBe(expectedPubkey);
        });

        it("should return null for invalid input", () => {
            expect(parseNostrUser("invalid")).toBe(null);
            expect(parseNostrUser("")).toBe(null);
            expect(parseNostrUser(undefined)).toBe(null);
        });

        it("should handle uppercase hex", () => {
            const pubkey = "82341F882B6EABCD2BA7F1EF90AAD961CF074AF15B9EF44A09F9D2A8FBFBE6A2";
            expect(parseNostrUser(pubkey)).toBe(pubkey.toLowerCase());
        });
    });

    describe("normalizeNostrIdentifier", () => {
        it("should normalize hex event ID", () => {
            const eventId = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(normalizeNostrIdentifier(eventId)).toBe(eventId);
        });

        it("should strip nostr: prefix", () => {
            const eventId = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            expect(normalizeNostrIdentifier(`nostr:${eventId}`)).toBe(eventId);
        });

        it("should normalize nevent", () => {
            const nevent =
                "nevent1qqswygerx2p74tyku96lh0n4m9s8n5z0zhfh9ryz5f7df2zlaukg5gpp4mhxue69uhkummn9ekx7mqzyrhxagf6h8l9cjngatumrg60unh22v66qz979pm32v985ek54ndvqcyqqqqqqgpz4mhxue69uhhyetvv9ujuerpd46hxtnfduhsz9thwden5te0wfjkccte9ejxzmt4wvhxjme0qyv8wumn8ghj7mn0wd68ytnxd46zuamf0ghxy6t69u";
            expect(normalizeNostrIdentifier(nevent)).toBe(nevent);
        });

        it("should normalize note", () => {
            const note = "note1gmx7hm39cywty8tgjx24utj44z7spqlpdnc5jr2u4j5m6z96ua9qfgv8v9";
            expect(normalizeNostrIdentifier(note)).toBe(note);
        });

        it("should return null for invalid identifiers", () => {
            expect(normalizeNostrIdentifier("invalid")).toBe(null);
            expect(normalizeNostrIdentifier("")).toBe(null);
            expect(normalizeNostrIdentifier(undefined)).toBe(null);
        });
    });

    describe("parseNostrEvent", () => {
        // This would require mocking NDK.fetchEvent since it's async
        // and would make network calls in a real scenario
        it("should handle nevent format", async () => {
            const nevent =
                "nevent1qqswygerx2p74tyku96lh0n4m9s8n5z0zhfh9ryz5f7df2zlaukg5gpp4mhxue69uhkummn9ekx7mqzyrhxagf6h8l9cjngatumrg60unh22v66qz979pm32v985ek54ndvqcyqqqqqqgpz4mhxue69uhhyetvv9ujuerpd46hxtnfduhsz9thwden5te0wfjkccte9ejxzmt4wvhxjme0qyv8wumn8ghj7mn0wd68ytnxd46zuamf0ghxy6t69u";

            // Mock NDK fetchEvent
            const mockNdk = {
                fetchEvent: async (id: string) => {
                    if (id === nevent) {
                        return new NDKEvent(ndk, { id: "test-id", content: "test" });
                    }
                    return null;
                },
            } as any;

            const result = await parseNostrEvent(nevent, mockNdk);
            expect(result).toBeTruthy();
        });

        it("should strip nostr: prefix from events", async () => {
            const nevent =
                "nevent1qqswygerx2p74tyku96lh0n4m9s8n5z0zhfh9ryz5f7df2zlaukg5gpp4mhxue69uhkummn9ekx7mqzyrhxagf6h8l9cjngatumrg60unh22v66qz979pm32v985ek54ndvqcyqqqqqqgpz4mhxue69uhhyetvv9ujuerpd46hxtnfduhsz9thwden5te0wfjkccte9ejxzmt4wvhxjme0qyv8wumn8ghj7mn0wd68ytnxd46zuamf0ghxy6t69u";

            const mockNdk = {
                fetchEvent: async (id: string) => {
                    if (id === nevent) {
                        return new NDKEvent(ndk, { id: "test-id", content: "test" });
                    }
                    return null;
                },
            } as any;

            const result = await parseNostrEvent(`nostr:${nevent}`, mockNdk);
            expect(result).toBeTruthy();
        });

        it("should return null for invalid event", async () => {
            const mockNdk = {
                fetchEvent: async () => null,
            } as any;

            const result = await parseNostrEvent("invalid", mockNdk);
            expect(result).toBe(null);
        });
    });

    describe("isHexPrefix", () => {
        it("should return true for valid 12-char hex prefix", () => {
            expect(isHexPrefix("82341f882b6e")).toBe(true);
            expect(isHexPrefix("abcdef123456")).toBe(true);
            expect(isHexPrefix("000000000000")).toBe(true);
        });

        it("should return true for uppercase hex prefix", () => {
            expect(isHexPrefix("82341F882B6E")).toBe(true);
            expect(isHexPrefix("ABCDEF123456")).toBe(true);
        });

        it("should return false for non-12-char strings", () => {
            expect(isHexPrefix("82341f882b")).toBe(false); // too short
            expect(isHexPrefix("82341f882b6eab")).toBe(false); // too long
            expect(isHexPrefix("82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2")).toBe(false); // full 64-char
        });

        it("should return false for non-hex characters", () => {
            expect(isHexPrefix("ghijkl123456")).toBe(false);
            expect(isHexPrefix("hello-world!")).toBe(false);
        });

        it("should return false for empty/undefined input", () => {
            expect(isHexPrefix("")).toBe(false);
            expect(isHexPrefix(undefined)).toBe(false);
        });

        it("should handle whitespace trimming", () => {
            expect(isHexPrefix("  82341f882b6e  ")).toBe(true);
        });
    });

    describe("resolvePrefixToId", () => {
        let isInitializedSpy: ReturnType<typeof spyOn>;
        let lookupSpy: ReturnType<typeof spyOn>;

        afterEach(() => {
            isInitializedSpy?.mockRestore();
            lookupSpy?.mockRestore();
        });

        it("should return null when PrefixKVStore is not initialized", () => {
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(false);

            const result = resolvePrefixToId("82341f882b6e");
            expect(result).toBe(null);
        });

        it("should return null for invalid prefix format", () => {
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);

            expect(resolvePrefixToId("invalid")).toBe(null);
            expect(resolvePrefixToId("82341f")).toBe(null); // too short
            expect(resolvePrefixToId("")).toBe(null);
            expect(resolvePrefixToId(undefined)).toBe(null);
        });

        it("should resolve valid prefix when store is initialized", () => {
            const fullId = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
            lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(fullId);

            const result = resolvePrefixToId("82341f882b6e");
            expect(result).toBe(fullId);
            expect(lookupSpy).toHaveBeenCalledWith("82341f882b6e");
        });

        it("should normalize uppercase to lowercase before lookup", () => {
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
            lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);

            resolvePrefixToId("ABCDEF123456");
            expect(lookupSpy).toHaveBeenCalledWith("abcdef123456");
        });

        it("should handle LMDB lookup errors gracefully", () => {
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
            lookupSpy = spyOn(prefixKVStore, "lookup").mockImplementation(() => {
                throw new Error("LMDB read error");
            });

            // Should return null gracefully, not throw
            const result = resolvePrefixToId("82341f882b6e");
            expect(result).toBe(null);
        });

        it("should return null when prefix not found in store", () => {
            isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
            lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);

            const result = resolvePrefixToId("abcdef123456");
            expect(result).toBe(null);
        });
    });

    describe("normalizeLessonEventId", () => {
        const fullEventId = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
        const eventIdPrefix = "82341f882b6e";

        let isInitializedSpy: ReturnType<typeof spyOn>;
        let lookupSpy: ReturnType<typeof spyOn>;

        afterEach(() => {
            isInitializedSpy?.mockRestore();
            lookupSpy?.mockRestore();
        });

        describe("64-char hex IDs", () => {
            it("should accept full 64-char lowercase hex ID", () => {
                const result = normalizeLessonEventId(fullEventId);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should accept full 64-char uppercase hex ID and normalize to lowercase", () => {
                const result = normalizeLessonEventId(fullEventId.toUpperCase());
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should handle nostr: prefix with hex ID", () => {
                const result = normalizeLessonEventId(`nostr:${fullEventId}`);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should trim whitespace", () => {
                const result = normalizeLessonEventId(`  ${fullEventId}  `);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });
        });

        describe("12-char hex prefixes", () => {
            it("should resolve prefix via PrefixKVStore when initialized", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
                lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(fullEventId);

                const result = normalizeLessonEventId(eventIdPrefix);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should fall back to in-memory scan when PrefixKVStore not initialized", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(false);

                const mockLessons: NDKAgentLesson[] = [
                    { id: fullEventId, title: "Test Lesson", lesson: "content", content: "content" } as NDKAgentLesson,
                ];

                const result = normalizeLessonEventId(eventIdPrefix, mockLessons);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should fall back to in-memory scan when PrefixKVStore lookup fails", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
                lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);

                const mockLessons: NDKAgentLesson[] = [
                    { id: fullEventId, title: "Test Lesson", lesson: "content", content: "content" } as NDKAgentLesson,
                ];

                const result = normalizeLessonEventId(eventIdPrefix, mockLessons);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should return error for ambiguous prefix (multiple matches)", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
                lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);

                const mockLessons: NDKAgentLesson[] = [
                    { id: fullEventId, title: "Lesson 1", lesson: "content", content: "content" } as NDKAgentLesson,
                    { id: "82341f882b6e9999999999999999999999999999999999999999999999999999", title: "Lesson 2", lesson: "content", content: "content" } as NDKAgentLesson,
                ];

                const result = normalizeLessonEventId(eventIdPrefix, mockLessons);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("prefix_not_found");
                    expect(result.error).toContain("ambiguous");
                }
            });

            it("should return error with distinct message when store not initialized and no in-memory match", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(false);

                const result = normalizeLessonEventId(eventIdPrefix, []);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("store_not_initialized");
                    expect(result.error).toContain("PrefixKVStore is not initialized");
                }
            });

            it("should return error when prefix not found anywhere", () => {
                isInitializedSpy = spyOn(prefixKVStore, "isInitialized").mockReturnValue(true);
                lookupSpy = spyOn(prefixKVStore, "lookup").mockReturnValue(null);

                const result = normalizeLessonEventId(eventIdPrefix, []);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("prefix_not_found");
                }
            });
        });

        describe("NIP-19 formats", () => {
            // Valid test data generated from fullEventId using nip19.noteEncode/neventEncode
            const validNote = "note1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q7k28gn";
            const validNevent = "nevent1qqsgydql3q4ka27d9wnlrmus4tvkrnc8ftc4h8h5fgyln54gl0a7dgsg5q3sz";

            it("should decode note1... format", () => {
                const result = normalizeLessonEventId(validNote);
                expect(result.success).toBe(true);
                if (result.success) {
                    // Should decode back to our known eventId
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should decode nevent1... format", () => {
                const result = normalizeLessonEventId(validNevent);
                expect(result.success).toBe(true);
                if (result.success) {
                    // Should decode back to our known eventId
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should handle nostr: prefix with NIP-19 format", () => {
                const result = normalizeLessonEventId(`nostr:${validNote}`);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.eventId).toBe(fullEventId);
                }
            });

            it("should reject npub (not an event ID)", () => {
                const npub = "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m";
                const result = normalizeLessonEventId(npub);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("invalid_format");
                    expect(result.error).toContain("npub");
                }
            });

            it("should reject nprofile (not an event ID)", () => {
                const nprofile = "nprofile1qqs0awzzutnzfj6cudj03a7txc7qxsrma9ge44yrym6337tkkd23qkg32nsh9";
                const result = normalizeLessonEventId(nprofile);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("invalid_format");
                }
            });
        });

        describe("invalid formats", () => {
            it("should reject completely invalid input", () => {
                const result = normalizeLessonEventId("not-a-valid-id");
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("invalid_format");
                }
            });

            it("should reject too-short hex strings", () => {
                const result = normalizeLessonEventId("82341f");
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("invalid_format");
                }
            });

            it("should reject hex strings between 12 and 64 chars", () => {
                const result = normalizeLessonEventId("82341f882b6eabcd2ba7f1ef90aad961"); // 32 chars
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.errorType).toBe("invalid_format");
                }
            });
        });
    });
});
