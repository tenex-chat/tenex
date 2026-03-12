/**
 * Tests for branded project identifier types.
 */

import { describe, test, expect } from "bun:test";
import {
    // Type guards
    isProjectDTag,
    isProjectAddress,

    // Factory functions
    createProjectDTag,
    createProjectAddress,

    // Conversion functions
    extractDTagFromAddress,
    buildProjectAddress,
    tryExtractDTagFromAddress,
} from "../project-ids";

const VALID_PUBKEY = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
const VALID_DTAG = "TENEX-ff3ssq";
const VALID_ADDRESS = `31933:${VALID_PUBKEY}:${VALID_DTAG}`;

describe("Type Guards", () => {
    describe("isProjectDTag", () => {
        test("returns true for a plain d-tag string", () => {
            expect(isProjectDTag("TENEX-ff3ssq")).toBe(true);
        });

        test("returns true for a simple slug", () => {
            expect(isProjectDTag("my-project")).toBe(true);
        });

        test("returns false for empty string", () => {
            expect(isProjectDTag("")).toBe(false);
        });

        test("returns false for a NIP-33 address", () => {
            expect(isProjectDTag(VALID_ADDRESS)).toBe(false);
        });
    });

    describe("isProjectAddress", () => {
        test("returns true for a valid NIP-33 address", () => {
            expect(isProjectAddress(VALID_ADDRESS)).toBe(true);
        });

        test("returns false for a plain d-tag", () => {
            expect(isProjectAddress("TENEX-ff3ssq")).toBe(false);
        });

        test("returns false for wrong kind number", () => {
            expect(isProjectAddress(`99999:${VALID_PUBKEY}:slug`)).toBe(false);
        });

        test("returns false for short pubkey", () => {
            expect(isProjectAddress("31933:abc:slug")).toBe(false);
        });

        test("returns false for empty string", () => {
            expect(isProjectAddress("")).toBe(false);
        });
    });
});

describe("Factory Functions", () => {
    describe("createProjectDTag", () => {
        test("creates a ProjectDTag from a valid d-tag", () => {
            const dTag = createProjectDTag("TENEX-ff3ssq");
            expect(dTag).toBe("TENEX-ff3ssq");
            expect(isProjectDTag(dTag)).toBe(true);
        });

        test("throws for empty string", () => {
            expect(() => createProjectDTag("")).toThrow("ProjectDTag cannot be empty");
        });

        test("throws for NIP-33 address (prevents accidental misuse)", () => {
            expect(() => createProjectDTag(VALID_ADDRESS)).toThrow(
                "looks like a NIP-33 address"
            );
        });
    });

    describe("createProjectAddress", () => {
        test("creates a ProjectAddress from a valid NIP-33 address", () => {
            const addr = createProjectAddress(VALID_ADDRESS);
            expect(addr).toBe(VALID_ADDRESS);
            expect(isProjectAddress(addr)).toBe(true);
        });

        test("throws for a d-tag (not an address)", () => {
            expect(() => createProjectAddress("TENEX-ff3ssq")).toThrow(
                "Invalid ProjectAddress"
            );
        });

        test("throws for empty string", () => {
            expect(() => createProjectAddress("")).toThrow("Invalid ProjectAddress");
        });
    });
});

describe("Conversion Functions", () => {
    describe("extractDTagFromAddress", () => {
        test("extracts d-tag from a valid address", () => {
            const addr = createProjectAddress(VALID_ADDRESS);
            const dTag = extractDTagFromAddress(addr);
            expect(dTag).toBe("TENEX-ff3ssq");
            expect(isProjectDTag(dTag)).toBe(true);
        });

        test("handles d-tags with colons", () => {
            const address = `31933:${VALID_PUBKEY}:project:with:colons`;
            const addr = createProjectAddress(address);
            const dTag = extractDTagFromAddress(addr);
            expect(dTag).toBe("project:with:colons");
        });
    });

    describe("buildProjectAddress", () => {
        test("builds a valid NIP-33 address from parts", () => {
            const dTag = createProjectDTag("TENEX-ff3ssq");
            const addr = buildProjectAddress(31933, VALID_PUBKEY, dTag);
            expect(addr).toBe(VALID_ADDRESS);
            expect(isProjectAddress(addr)).toBe(true);
        });
    });

    describe("tryExtractDTagFromAddress", () => {
        test("returns ProjectDTag for a valid address", () => {
            const dTag = tryExtractDTagFromAddress(VALID_ADDRESS);
            expect(dTag).toBe("TENEX-ff3ssq");
        });

        test("returns null for a d-tag (not an address)", () => {
            expect(tryExtractDTagFromAddress("TENEX-ff3ssq")).toBeNull();
        });

        test("returns null for empty string", () => {
            expect(tryExtractDTagFromAddress("")).toBeNull();
        });

        test("returns null for invalid format", () => {
            expect(tryExtractDTagFromAddress("not:a:valid:address")).toBeNull();
        });
    });
});

describe("Round-trip", () => {
    test("extractDTagFromAddress(buildProjectAddress(...)) returns original d-tag", () => {
        const originalDTag = createProjectDTag("my-project-slug");
        const address = buildProjectAddress(31933, VALID_PUBKEY, originalDTag);
        const extractedDTag = extractDTagFromAddress(address);
        expect(extractedDTag).toBe(originalDTag);
    });
});
