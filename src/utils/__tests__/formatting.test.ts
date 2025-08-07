import { describe, test, expect } from "bun:test";
import { formatDuration, formatMarkdown, colorizeJSON } from "../formatting";

describe("formatDuration", () => {
    test("formats milliseconds correctly", () => {
        expect(formatDuration(45)).toBe("45ms");
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(999)).toBe("999ms");
    });

    test("formats seconds correctly", () => {
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(1500)).toBe("1.5s");
        expect(formatDuration(59999)).toBe("60.0s");
    });

    test("formats minutes and seconds correctly", () => {
        expect(formatDuration(60000)).toBe("1m 0s");
        expect(formatDuration(65000)).toBe("1m 5s");
        expect(formatDuration(119000)).toBe("1m 59s");
        expect(formatDuration(120000)).toBe("2m 0s");
    });
});

describe("formatMarkdown", () => {
    test("formats headers", () => {
        const input = "# Header 1\n## Header 2";
        const result = formatMarkdown(input);
        expect(result).toContain("Header 1");
        expect(result).toContain("Header 2");
    });

    test("formats bold and italic text", () => {
        const input = "This is **bold** and this is *italic*";
        const result = formatMarkdown(input);
        expect(result).toContain("bold");
        expect(result).toContain("italic");
    });

    test("formats code blocks", () => {
        const input = "```javascript\nconst x = 1;\n```";
        const result = formatMarkdown(input);
        expect(result).toContain("const x = 1;");
    });

    test("formats inline code", () => {
        const input = "Use `npm install` to install";
        const result = formatMarkdown(input);
        expect(result).toContain("`npm install`");
    });

    test("formats links", () => {
        const input = "[Google](https://google.com)";
        const result = formatMarkdown(input);
        expect(result).toContain("[Google]");
        expect(result).toContain("(https://google.com)");
    });

    test("formats bullet lists", () => {
        const input = "- Item 1\n* Item 2\n+ Item 3";
        const result = formatMarkdown(input);
        expect(result).toContain("Item 1");
        expect(result).toContain("Item 2");
        expect(result).toContain("Item 3");
    });

    test("formats numbered lists", () => {
        const input = "1. First\n2. Second";
        const result = formatMarkdown(input);
        expect(result).toContain("First");
        expect(result).toContain("Second");
    });
});

describe("colorizeJSON", () => {
    test("colorizes object keys", () => {
        const input = '{"name": "test"}';
        const result = colorizeJSON(input);
        expect(result).toContain('"name":');
        expect(result).toContain('"test"');
    });

    test("colorizes numbers", () => {
        const input = '{"count": 42}';
        const result = colorizeJSON(input);
        expect(result).toContain("42");
    });

    test("colorizes booleans", () => {
        const input = '{"active": true, "disabled": false}';
        const result = colorizeJSON(input);
        expect(result).toContain("true");
        expect(result).toContain("false");
    });

    test("colorizes null values", () => {
        const input = '{"value": null}';
        const result = colorizeJSON(input);
        expect(result).toContain("null");
    });

    test("handles nested objects", () => {
        const input = '{"user": {"name": "John", "age": 30}}';
        const result = colorizeJSON(input);
        expect(result).toContain('"user":');
        expect(result).toContain('"name":');
        expect(result).toContain('"John"');
        expect(result).toContain("30");
    });
});