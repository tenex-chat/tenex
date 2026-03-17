import { describe, expect, it } from "bun:test";
import { renderTelegramMessage } from "@/services/telegram/telegram-message-renderer";

describe("renderTelegramMessage", () => {
    it("renders common markdown constructs into Telegram HTML", () => {
        const rendered = renderTelegramMessage(
            [
                "Great question! Here are the **tools I have available**:",
                "",
                "## **File & Directory Operations**",
                "- `fs_read` - Read files",
                "- `fs_grep` - Search files",
                "",
                "Use [the docs](https://example.com/docs).",
            ].join("\n")
        );

        expect(rendered).toEqual({
            parseMode: "HTML",
            text: [
                "Great question! Here are the <b>tools I have available</b>:",
                "",
                "<b>File &amp; Directory Operations</b>",
                "• <code>fs_read</code> - Read files",
                "• <code>fs_grep</code> - Search files",
                "",
                "Use <a href=\"https://example.com/docs\">the docs</a>.",
            ].join("\n"),
        });
    });

    it("escapes raw html while preserving code blocks", () => {
        const rendered = renderTelegramMessage(
            [
                "<b>unsafe</b>",
                "```ts",
                "const value = '<tag>';",
                "```",
            ].join("\n")
        );

        expect(rendered.text).toBe(
            [
                "&lt;b&gt;unsafe&lt;/b&gt;",
                "<pre><code class=\"language-ts\">const value = '&lt;tag&gt;';</code></pre>",
            ].join("\n")
        );
    });
});
