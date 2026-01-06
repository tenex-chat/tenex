import { beforeAll, describe, expect, it } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { normalizeNostrIdentifier, parseNostrEvent, parseNostrUser } from "../nostr-entity-parser";

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
});
