import { describe, expect, it } from "bun:test";

import { escapeSqlLikeValue } from "../sqlEscaping";

describe("escapeSqlLikeValue", () => {
    it("should escape double quotes", () => {
        expect(escapeSqlLikeValue('test"value')).toBe('test\\"value');
    });

    it("should escape single quotes by doubling", () => {
        expect(escapeSqlLikeValue("test'value")).toBe("test''value");
    });

    it("should escape backslashes", () => {
        expect(escapeSqlLikeValue("test\\value")).toBe("test\\\\value");
    });

    it("should escape LIKE wildcards", () => {
        expect(escapeSqlLikeValue("test%value")).toBe("test\\%value");
        expect(escapeSqlLikeValue("test_value")).toBe("test\\_value");
    });

    it("should handle hex pubkeys (no escaping needed)", () => {
        const hexPubkey = "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd";
        expect(escapeSqlLikeValue(hexPubkey)).toBe(hexPubkey);
    });
});
