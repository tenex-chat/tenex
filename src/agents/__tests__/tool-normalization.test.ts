import { describe, expect, it } from "bun:test";
import { expandFsCapabilities } from "../tool-normalization";

describe("expandFsCapabilities", () => {
    it("should add fs_glob and fs_grep when fs_read is present", () => {
        const result = expandFsCapabilities(["fs_read"]);
        expect(result).toContain("fs_read");
        expect(result).toContain("fs_glob");
        expect(result).toContain("fs_grep");
    });

    it("should add fs_edit when fs_write is present", () => {
        const result = expandFsCapabilities(["fs_write"]);
        expect(result).toContain("fs_write");
        expect(result).toContain("fs_edit");
    });

    it("should expand both fs_read and fs_write together", () => {
        const result = expandFsCapabilities(["fs_read", "fs_write"]);
        expect(result).toContain("fs_read");
        expect(result).toContain("fs_glob");
        expect(result).toContain("fs_grep");
        expect(result).toContain("fs_write");
        expect(result).toContain("fs_edit");
        expect(result).toHaveLength(5);
    });

    it("should not duplicate tools already present", () => {
        const result = expandFsCapabilities(["fs_read", "fs_glob", "fs_grep"]);
        expect(result).toEqual(["fs_read", "fs_glob", "fs_grep"]);
    });

    it("should not modify tools when neither fs_read nor fs_write is present", () => {
        const result = expandFsCapabilities(["bash", "web_search"]);
        expect(result).toEqual(["bash", "web_search"]);
    });

    it("should return empty array for empty input", () => {
        const result = expandFsCapabilities([]);
        expect(result).toEqual([]);
    });

    it("should not add write tools when only fs_read is present", () => {
        const result = expandFsCapabilities(["fs_read"]);
        expect(result).not.toContain("fs_write");
        expect(result).not.toContain("fs_edit");
    });

    it("should not add read tools when only fs_write is present", () => {
        const result = expandFsCapabilities(["fs_write"]);
        expect(result).not.toContain("fs_read");
        expect(result).not.toContain("fs_glob");
        expect(result).not.toContain("fs_grep");
    });

    it("should not mutate the input array", () => {
        const input = ["fs_read"];
        expandFsCapabilities(input);
        expect(input).toEqual(["fs_read"]);
    });
});
