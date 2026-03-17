function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function escapeAttribute(text: string): string {
    return escapeHtml(text);
}

function createPlaceholder(index: number): string {
    return `%%TENEX_TG_PLACEHOLDER_${index}%%`;
}

function extractPlaceholders(
    input: string,
    pattern: RegExp,
    render: (...groups: string[]) => string
): { text: string; replacements: string[] } {
    const replacements: string[] = [];
    const text = input.replace(pattern, (...args) => {
        const groups = args.slice(1, -2) as string[];
        const replacement = render(...groups);
        const placeholder = createPlaceholder(replacements.length);
        replacements.push(replacement);
        return placeholder;
    });

    return { text, replacements };
}

function restorePlaceholders(input: string, replacements: string[]): string {
    return replacements.reduce(
        (text, replacement, index) => text.replaceAll(createPlaceholder(index), replacement),
        input
    );
}

function renderInlineMarkdown(input: string): string {
    let text = input;

    text = text.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label: string, url: string) =>
            `<a href="${escapeAttribute(url)}">${label}</a>`
    );
    text = text.replace(/\|\|([^\n]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
    text = text.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
    text = text.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
    text = text.replace(/__([^\n]+?)__/g, "<u>$1</u>");
    text = text.replace(
        /(^|[^\w])_([^_\n][^\n]*?)_(?!\w)/g,
        (_match, prefix: string, content: string) => `${prefix}<i>${content}</i>`
    );
    text = text.replace(
        /(^|[^\w*])\*([^*\n][^\n]*?)\*(?!\w)/g,
        (_match, prefix: string, content: string) => `${prefix}<i>${content}</i>`
    );

    return text;
}

function stripOuterHeadingFormatting(input: string): string {
    const trimmed = input.trim();

    return trimmed
        .replace(/^\*\*(.+)\*\*$/s, "$1")
        .replace(/^__(.+)__$/s, "$1");
}

export function renderTelegramMessage(content: string): {
    text: string;
    parseMode: "HTML";
} {
    const normalized = content.replace(/\r\n?/g, "\n");
    const fencedBlocks = extractPlaceholders(
        normalized,
        /```([A-Za-z0-9_+-]+)?\n?([\s\S]*?)```/g,
        (language = "", code = "") => {
            const escapedCode = escapeHtml(code.replace(/\n$/, ""));
            if (language) {
                return `<pre><code class="language-${escapeAttribute(language)}">${escapedCode}</code></pre>`;
            }

            return `<pre>${escapedCode}</pre>`;
        }
    );
    const inlineCode = extractPlaceholders(
        fencedBlocks.text,
        /`([^`\n]+)`/g,
        (code = "") => `<code>${escapeHtml(code)}</code>`
    );

    const escaped = escapeHtml(inlineCode.text);
    const renderedLines = escaped.split("\n").map((line) => {
        const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
            return `<b>${renderInlineMarkdown(stripOuterHeadingFormatting(headingMatch[1] ?? ""))}</b>`;
        }

        const quoteMatch = line.match(/^&gt;\s?(.*)$/);
        if (quoteMatch) {
            return `<blockquote>${renderInlineMarkdown(quoteMatch[1] ?? "")}</blockquote>`;
        }

        const bulletMatch = line.match(/^[-*]\s+(.+)$/);
        if (bulletMatch) {
            return `• ${renderInlineMarkdown(bulletMatch[1] ?? "")}`;
        }

        return renderInlineMarkdown(line);
    }).join("\n");

    const withInlineCode = restorePlaceholders(renderedLines, inlineCode.replacements);
    const withFencedBlocks = restorePlaceholders(withInlineCode, fencedBlocks.replacements);

    return {
        text: withFencedBlocks,
        parseMode: "HTML",
    };
}
