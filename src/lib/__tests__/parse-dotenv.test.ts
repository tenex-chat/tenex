import { describe, expect, it } from "bun:test";
import { DotenvParseError, parseDotenv } from "../parse-dotenv";

describe("parseDotenv", () => {
    it("parses blank lines, comments, export prefixes, and empty values", () => {
        const parsed = parseDotenv(`
# comment
export FOO=bar
BAR="quoted value"
BAZ='single quoted'
EMPTY=
`);

        expect(parsed).toEqual({
            FOO: "bar",
            BAR: "quoted value",
            BAZ: "single quoted",
            EMPTY: "",
        });
    });

    it("supports inline comments for unquoted values only", () => {
        const parsed = parseDotenv(`
FOO=bar # trailing comment
BAR=literal#hash
BAZ="quoted # hash" # comment
`);

        expect(parsed).toEqual({
            FOO: "bar",
            BAR: "literal#hash",
            BAZ: "quoted # hash",
        });
    });

    it("does not interpolate shell-style variables", () => {
        const parsed = parseDotenv(`
FOO=$BAR
BAR="\${BAZ}"
`);

        expect(parsed).toEqual({
            FOO: "$BAR",
            BAR: "${BAZ}",
        });
    });

    it("throws with line numbers for invalid assignments", () => {
        expect(() => parseDotenv("NOT VALID")).toThrow(DotenvParseError);

        try {
            parseDotenv("NOT VALID");
        } catch (error) {
            expect(error).toBeInstanceOf(DotenvParseError);
            expect((error as DotenvParseError).line).toBe(1);
        }
    });

    it("throws on unterminated quoted values", () => {
        expect(() => parseDotenv("FOO=\"unterminated")).toThrow(
            "Invalid .env syntax on line 1: unterminated quoted value"
        );
    });
});
