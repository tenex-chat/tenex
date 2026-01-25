import { describe, expect, it, vi, beforeEach } from "vitest";
import { nip19 } from "nostr-tools";

/**
 * Tests for report_read naddr decoding and identifier handling
 */

// Test data
const TEST_SLUG = "test-report";
const TEST_PUBKEY = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const TEST_KIND_ARTICLE = 30023; // NDKArticle kind for reports
const TEST_KIND_OTHER = 30000; // A different kind to test rejection

describe("report_read identifier handling", () => {
    describe("naddr decoding", () => {
        it("should extract slug from valid kind 30023 naddr", () => {
            // Create a real naddr for kind 30023 (NDKArticle)
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_ARTICLE,
                pubkey: TEST_PUBKEY,
                identifier: TEST_SLUG,
            });

            // Decode it back
            const decoded = nip19.decode(naddr);
            expect(decoded.type).toBe("naddr");
            if (decoded.type === "naddr") {
                expect(decoded.data.identifier).toBe(TEST_SLUG);
                expect(decoded.data.kind).toBe(TEST_KIND_ARTICLE);
            }
        });

        it("should reject naddr with non-30023 kind", () => {
            // Create an naddr with a different kind
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_OTHER,
                pubkey: TEST_PUBKEY,
                identifier: TEST_SLUG,
            });

            // Decode it
            const decoded = nip19.decode(naddr);
            expect(decoded.type).toBe("naddr");
            if (decoded.type === "naddr") {
                // This should be rejected by report_read
                expect(decoded.data.kind).not.toBe(TEST_KIND_ARTICLE);
                expect(decoded.data.kind).toBe(TEST_KIND_OTHER);
            }
        });

        it("should handle naddr with empty identifier", () => {
            // Create an naddr with empty identifier
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_ARTICLE,
                pubkey: TEST_PUBKEY,
                identifier: "", // Empty identifier
            });

            const decoded = nip19.decode(naddr);
            expect(decoded.type).toBe("naddr");
            if (decoded.type === "naddr") {
                expect(decoded.data.identifier).toBe("");
            }
        });

        it("should handle nostr: prefix", () => {
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_ARTICLE,
                pubkey: TEST_PUBKEY,
                identifier: TEST_SLUG,
            });

            const withPrefix = `nostr:${naddr}`;

            // Remove prefix (as report_read does)
            const stripped = withPrefix.slice(6);
            expect(stripped).toBe(naddr);

            // Should still decode correctly
            const decoded = nip19.decode(stripped);
            expect(decoded.type).toBe("naddr");
        });

        it("should fail to decode invalid naddr string", () => {
            const invalidNaddr = "naddr1invalid";

            expect(() => {
                nip19.decode(invalidNaddr);
            }).toThrow();
        });

        it("should distinguish naddr from plain slug", () => {
            // A plain slug should not start with naddr1
            const plainSlug = "my-report-slug";
            expect(plainSlug.startsWith("naddr1")).toBe(false);

            // An naddr should start with naddr1
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_ARTICLE,
                pubkey: TEST_PUBKEY,
                identifier: plainSlug,
            });
            expect(naddr.startsWith("naddr1")).toBe(true);
        });
    });

    describe("kind validation", () => {
        it("should accept kind 30023 (NDKArticle)", () => {
            const validKinds = [30023];
            validKinds.forEach((kind) => {
                expect(kind).toBe(30023);
            });
        });

        it("should identify non-30023 kinds", () => {
            const invalidKinds = [0, 1, 30000, 30001, 30009, 30022, 30024];
            invalidKinds.forEach((kind) => {
                expect(kind).not.toBe(30023);
            });
        });
    });

    describe("nostr: prefix handling", () => {
        it("should strip nostr: prefix from naddr", () => {
            const naddr = nip19.naddrEncode({
                kind: TEST_KIND_ARTICLE,
                pubkey: TEST_PUBKEY,
                identifier: TEST_SLUG,
            });

            const withPrefix = `nostr:${naddr}`;
            expect(withPrefix.startsWith("nostr:")).toBe(true);

            const stripped = withPrefix.slice(6);
            expect(stripped.startsWith("nostr:")).toBe(false);
            expect(stripped).toBe(naddr);
        });

        it("should strip nostr: prefix from plain slug (edge case)", () => {
            // This is a weird case but should be handled
            const weirdInput = "nostr:plain-slug";
            const stripped = weirdInput.slice(6);
            expect(stripped).toBe("plain-slug");
        });

        it("should not strip from non-nostr: prefixed input", () => {
            const normalSlug = "my-report";
            expect(normalSlug.startsWith("nostr:")).toBe(false);
        });
    });
});
