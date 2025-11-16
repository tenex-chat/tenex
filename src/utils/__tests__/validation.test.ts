import { describe, expect, it } from "bun:test";
import {
    isAbsolutePath,
    isMarkdownFile,
    isValidNpub,
    isValidPubkey,
    isValidSlug,
    isValidUuid,
} from "../validation";

describe("Validation Utilities", () => {
    describe("isValidSlug", () => {
        it("should accept valid slugs", () => {
            expect(isValidSlug("valid-slug")).toBe(true);
            expect(isValidSlug("another_slug")).toBe(true);
            expect(isValidSlug("slug123")).toBe(true);
            expect(isValidSlug("UPPERCASE")).toBe(true);
            expect(isValidSlug("mixed-Case_123")).toBe(true);
        });

        it("should reject invalid slugs", () => {
            expect(isValidSlug("has spaces")).toBe(false);
            expect(isValidSlug("has@special!chars")).toBe(false);
            expect(isValidSlug("")).toBe(false);
            expect(isValidSlug("has.dots")).toBe(false);
        });
    });

    describe("isMarkdownFile", () => {
        it("should identify markdown files", () => {
            expect(isMarkdownFile("README.md")).toBe(true);
            expect(isMarkdownFile("document.md")).toBe(true);
            expect(isMarkdownFile("path/to/file.md")).toBe(true);
        });

        it("should reject non-markdown files", () => {
            expect(isMarkdownFile("script.js")).toBe(false);
            expect(isMarkdownFile("style.css")).toBe(false);
            expect(isMarkdownFile("README")).toBe(false);
            expect(isMarkdownFile("file.mdx")).toBe(false);
        });
    });

    describe("isValidPubkey", () => {
        it("should accept valid pubkeys", () => {
            const validPubkey = "a".repeat(64);
            expect(isValidPubkey(validPubkey)).toBe(true);
            expect(isValidPubkey("1234567890abcdef".repeat(4))).toBe(true);
        });

        it("should reject invalid pubkeys", () => {
            expect(isValidPubkey("too-short")).toBe(false);
            expect(isValidPubkey("a".repeat(63))).toBe(false);
            expect(isValidPubkey("a".repeat(65))).toBe(false);
            expect(isValidPubkey("g".repeat(64))).toBe(false); // Invalid hex char
            expect(isValidPubkey(`${"not-hex-characters-here!".repeat(2)}aa`)).toBe(false);
        });
    });

    describe("isValidNpub", () => {
        it("should accept valid npubs", () => {
            const validNpub = `npub1${"a".repeat(58)}`;
            expect(isValidNpub(validNpub)).toBe(true);
        });

        it("should reject invalid npubs", () => {
            expect(isValidNpub("npub1")).toBe(false); // Too short
            expect(isValidNpub(`invalid${"a".repeat(57)}`)).toBe(false); // Wrong prefix
            expect(isValidNpub(`npub1${"a".repeat(57)}`)).toBe(false); // Wrong length
            expect(isValidNpub(`npub1${"a".repeat(59)}`)).toBe(false); // Too long
        });
    });

    describe("isAbsolutePath", () => {
        it("should identify Unix absolute paths", () => {
            expect(isAbsolutePath("/home/user")).toBe(true);
            expect(isAbsolutePath("/")).toBe(true);
            expect(isAbsolutePath("/usr/local/bin")).toBe(true);
        });

        it("should identify Windows absolute paths", () => {
            // These will be recognized on all platforms
            expect(isAbsolutePath("C:\\Users")).toBe(process.platform === "win32");
            expect(isAbsolutePath("D:\\")).toBe(process.platform === "win32");
        });

        it("should reject relative paths", () => {
            expect(isAbsolutePath("relative/path")).toBe(false);
            expect(isAbsolutePath("./current")).toBe(false);
            expect(isAbsolutePath("../parent")).toBe(false);
            expect(isAbsolutePath("file.txt")).toBe(false);
        });
    });

    describe("isValidUuid", () => {
        it("should accept valid UUID v4", () => {
            expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
            expect(isValidUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8")).toBe(true);
            expect(isValidUuid("6BA7B810-9DAD-41D1-80B4-00C04FD430C8")).toBe(true); // Case insensitive
        });

        it("should reject invalid UUIDs", () => {
            expect(isValidUuid("not-a-uuid")).toBe(false);
            expect(isValidUuid("550e8400-e29b-11d4-a716-446655440000")).toBe(false); // v1, not v4
            expect(isValidUuid("550e8400-e29b-41d4-a716-44665544000")).toBe(false); // Too short
            expect(isValidUuid("550e8400-e29b-41d4-a716-4466554400000")).toBe(false); // Too long
            expect(isValidUuid("550e8400e29b41d4a716446655440000")).toBe(false); // No hyphens
        });
    });
});
