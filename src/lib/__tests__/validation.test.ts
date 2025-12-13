import { describe, expect, it } from "bun:test";
import { isAbsolutePath, isValidSlug } from "@/lib/validation";

// Note: isMarkdownFile, isValidNpub, isValidPubkey, isValidUuid are Nostr-specific
// and should live in utils/ or a nostr validation module, not in lib/

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

});
