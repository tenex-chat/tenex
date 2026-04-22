//! Port of `src/services/telegram/telegram-message-renderer.ts`.
//!
//! Converts an agent's Markdown-ish message body into Telegram-compatible
//! HTML (Telegram's `parse_mode=HTML`). The TS behavior is the oracle:
//!
//! - fenced code blocks become `<pre><code class="language-..">` or `<pre>`
//! - inline backticks become `<code>`
//! - the remaining text is HTML-escaped; then, per line:
//!     * `# … ######` headings → `<b>…</b>` with outer `**`/`__` stripped
//!     * `&gt; …` (the escaped `> `) → `<blockquote>…</blockquote>`
//!     * `- ` / `* ` bullets → `• …`
//!     * any remaining line gets inline-markdown applied
//! - inline markdown rewrites are applied after HTML escape: `[label](url)`,
//!   `||spoiler||`, `~~strike~~`, `**bold**`, `__underline__`, `_italic_`,
//!   `*italic*`
//!
//! The port is character-exact against the TS behavior for the inputs
//! covered by the test matrix. Regex-free for determinism and to avoid a
//! dependency; each replacement is an explicit scanner.
//!
//! Return type: `RenderedTelegramMessage { text, parse_mode }` with
//! `parse_mode` always `"HTML"` to mirror TS.

/// Rendered output from [`render_telegram_message`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedTelegramMessage {
    pub text: String,
    /// Always the static string `"HTML"`; kept as a field so callers can
    /// feed this directly to the Bot API `parse_mode` parameter.
    pub parse_mode: &'static str,
}

/// Render Markdown-ish content into Telegram HTML.
pub fn render_telegram_message(content: &str) -> RenderedTelegramMessage {
    let normalized = normalize_newlines(content);
    let (fenced_text, fenced_replacements) = extract_fenced_code_blocks(&normalized);
    let (inline_text, inline_replacements) = extract_inline_code(&fenced_text);

    let escaped = escape_html(&inline_text);
    let rendered_lines = escaped
        .split('\n')
        .map(render_line)
        .collect::<Vec<_>>()
        .join("\n");

    let with_inline_code = restore_placeholders(&rendered_lines, &inline_replacements);
    let with_fenced_blocks = restore_placeholders(&with_inline_code, &fenced_replacements);

    RenderedTelegramMessage {
        text: with_fenced_blocks,
        parse_mode: "HTML",
    }
}

fn normalize_newlines(input: &str) -> String {
    // The TS source uses /\r\n?/g -> "\n". Collapse both CRLF and bare CR.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

fn placeholder(index: usize) -> String {
    format!("%%TENEX_TG_PLACEHOLDER_{index}%%")
}

fn extract_fenced_code_blocks(input: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(input.len());
    let mut replacements: Vec<String> = Vec::new();
    let bytes = input.as_bytes();
    let mut cursor = 0;

    while cursor < bytes.len() {
        if let Some(relative) = find_bytes(&bytes[cursor..], b"```") {
            let open_start = cursor + relative;
            out.push_str(&input[cursor..open_start]);
            let after_open = open_start + 3;
            // Language: consumed greedily while alnum/underscore/plus/dash.
            let (language_end, language) = consume_language(input, after_open);
            // Skip a single newline after the language, if present.
            let body_start = if input.as_bytes().get(language_end) == Some(&b'\n') {
                language_end + 1
            } else {
                language_end
            };
            if let Some(close_rel) = find_bytes(&bytes[body_start..], b"```") {
                let body_end = body_start + close_rel;
                let code = &input[body_start..body_end];
                let code_trimmed_trailing_newline = code.strip_suffix('\n').unwrap_or(code);
                let escaped_code = escape_html(code_trimmed_trailing_newline);
                let replacement = if language.is_empty() {
                    format!("<pre>{escaped_code}</pre>")
                } else {
                    format!(
                        "<pre><code class=\"language-{lang}\">{escaped_code}</code></pre>",
                        lang = escape_html(&language),
                    )
                };
                let idx = replacements.len();
                replacements.push(replacement);
                out.push_str(&placeholder(idx));
                cursor = body_end + 3;
                continue;
            } else {
                // Unterminated: the TS regex would also fail to match, so
                // the literal "```" and everything after it is left as-is.
                out.push_str(&input[open_start..]);
                return (out, replacements);
            }
        } else {
            out.push_str(&input[cursor..]);
            break;
        }
    }

    (out, replacements)
}

fn consume_language(input: &str, start: usize) -> (usize, String) {
    let bytes = input.as_bytes();
    let mut end = start;
    while end < bytes.len() {
        let byte = bytes[end];
        let is_lang_char = byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-');
        if is_lang_char {
            end += 1;
        } else {
            break;
        }
    }
    (end, input[start..end].to_string())
}

fn extract_inline_code(input: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(input.len());
    let mut replacements: Vec<String> = Vec::new();
    let bytes = input.as_bytes();
    let mut cursor = 0;

    while cursor < bytes.len() {
        match bytes[cursor] {
            b'`' => {
                let body_start = cursor + 1;
                let mut end = body_start;
                let mut saw_non_empty = false;
                while end < bytes.len() {
                    match bytes[end] {
                        b'`' => break,
                        b'\n' => {
                            // TS regex disallows newlines inside inline code.
                            end = bytes.len();
                            break;
                        }
                        _ => {
                            saw_non_empty = true;
                            end += 1;
                        }
                    }
                }
                if end < bytes.len() && bytes[end] == b'`' && saw_non_empty {
                    let code = &input[body_start..end];
                    let replacement =
                        format!("<code>{escaped}</code>", escaped = escape_html(code));
                    let idx = replacements.len();
                    replacements.push(replacement);
                    out.push_str(&placeholder(idx));
                    cursor = end + 1;
                } else {
                    // Unterminated or empty; leave the backtick literal.
                    out.push('`');
                    cursor += 1;
                }
            }
            _ => {
                // Advance one UTF-8 character.
                let mut end = cursor + 1;
                while end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
                    end += 1;
                }
                out.push_str(&input[cursor..end]);
                cursor = end;
            }
        }
    }

    (out, replacements)
}

fn restore_placeholders(input: &str, replacements: &[String]) -> String {
    let mut text = input.to_string();
    for (idx, replacement) in replacements.iter().enumerate() {
        let needle = placeholder(idx);
        text = text.replace(&needle, replacement);
    }
    text
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn render_line(line: &str) -> String {
    if let Some(body) = parse_heading(line) {
        return format!(
            "<b>{rendered}</b>",
            rendered = render_inline_markdown(&strip_outer_heading_formatting(body)),
        );
    }
    if let Some(body) = parse_quote_line(line) {
        return format!(
            "<blockquote>{rendered}</blockquote>",
            rendered = render_inline_markdown(body),
        );
    }
    if let Some(body) = parse_bullet_line(line) {
        return format!("• {rendered}", rendered = render_inline_markdown(body));
    }
    render_inline_markdown(line)
}

fn parse_heading(line: &str) -> Option<&str> {
    // /^#{1,6}\s+(.+)$/
    let bytes = line.as_bytes();
    let mut hash_count = 0;
    while hash_count < bytes.len() && bytes[hash_count] == b'#' {
        hash_count += 1;
    }
    if !(1..=6).contains(&hash_count) {
        return None;
    }
    let mut cursor = hash_count;
    let mut saw_space = false;
    while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
        cursor += 1;
        saw_space = true;
    }
    if !saw_space || cursor >= bytes.len() {
        return None;
    }
    Some(&line[cursor..])
}

fn parse_quote_line(line: &str) -> Option<&str> {
    // After escape_html the literal `>` becomes `&gt;`. TS pattern:
    // /^&gt;\s?(.*)$/
    let prefix = "&gt;";
    if !line.starts_with(prefix) {
        return None;
    }
    let rest = &line[prefix.len()..];
    // Strip a single optional whitespace char (space or tab).
    if let Some(body) = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('\t')) {
        return Some(body);
    }
    Some(rest)
}

fn parse_bullet_line(line: &str) -> Option<&str> {
    // /^[-*]\s+(.+)$/
    let bytes = line.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    if bytes[0] != b'-' && bytes[0] != b'*' {
        return None;
    }
    let mut cursor = 1;
    let mut saw_space = false;
    while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t') {
        cursor += 1;
        saw_space = true;
    }
    if !saw_space || cursor >= bytes.len() {
        return None;
    }
    Some(&line[cursor..])
}

fn strip_outer_heading_formatting(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(stripped) = trimmed
        .strip_prefix("**")
        .and_then(|s| s.strip_suffix("**"))
    {
        return stripped.to_string();
    }
    if let Some(stripped) = trimmed
        .strip_prefix("__")
        .and_then(|s| s.strip_suffix("__"))
    {
        return stripped.to_string();
    }
    trimmed.to_string()
}

fn render_inline_markdown(input: &str) -> String {
    let text = replace_links(input);
    let text = replace_paired_delim(&text, "||", "<tg-spoiler>", "</tg-spoiler>");
    let text = replace_paired_delim(&text, "~~", "<s>", "</s>");
    let text = replace_paired_delim(&text, "**", "<b>", "</b>");
    let text = replace_paired_delim(&text, "__", "<u>", "</u>");
    let text = replace_word_bounded_italic(&text, '_');
    replace_word_bounded_italic(&text, '*')
}

/// Replace `[label](http(s)://url)` with `<a href="url">label</a>`.
///
/// URL attribute is HTML-escaped to match the TS `escapeAttribute` call.
/// Label content stays as-is (already HTML-escaped earlier, plus previously
/// replaced placeholders for inline code get restored afterwards).
fn replace_links(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;

    while cursor < bytes.len() {
        if bytes[cursor] == b'['
            && let Some(end) = try_parse_link(input, cursor)
        {
            let (label, href, total_len) = end;
            // TS renders the label verbatim (no additional escape) so we
            // match that. Href goes through escape_html like escapeAttribute.
            out.push_str(&format!(
                "<a href=\"{href}\">{label}</a>",
                href = escape_html(&href),
                label = label,
            ));
            cursor += total_len;
            continue;
        }
        let mut end = cursor + 1;
        while end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
            end += 1;
        }
        out.push_str(&input[cursor..end]);
        cursor = end;
    }

    out
}

fn try_parse_link(input: &str, start: usize) -> Option<(String, String, usize)> {
    let bytes = input.as_bytes();
    // `[label](`
    if bytes[start] != b'[' {
        return None;
    }
    let label_start = start + 1;
    let mut label_end = label_start;
    while label_end < bytes.len() {
        match bytes[label_end] {
            b']' | b'\n' => break,
            _ => label_end += 1,
        }
    }
    if label_end >= bytes.len() || bytes[label_end] != b']' {
        return None;
    }
    if label_end == label_start {
        return None; // TS requires [^\]\n]+
    }
    let paren_open = label_end + 1;
    if paren_open >= bytes.len() || bytes[paren_open] != b'(' {
        return None;
    }
    let url_start = paren_open + 1;
    let url_scheme_end = url_start + 8; // max("https://")
    let scheme_slice = &input[url_start..url_scheme_end.min(input.len())];
    if !(scheme_slice.starts_with("http://") || scheme_slice.starts_with("https://")) {
        return None;
    }
    let mut url_end = url_start;
    while url_end < bytes.len() {
        match bytes[url_end] {
            b')' => break,
            b' ' | b'\t' | b'\n' => return None,
            _ => url_end += 1,
        }
    }
    if url_end >= bytes.len() || bytes[url_end] != b')' {
        return None;
    }
    let label = input[label_start..label_end].to_string();
    let url = input[url_start..url_end].to_string();
    Some((label, url, url_end - start + 1))
}

/// Replace every paired occurrence of `delim` with `open`…`close`.
///
/// Pairs are greedy from-left; inner content may not span a newline; TS
/// behavior requires a non-delim character right after the opening and
/// before the closing. The TS regex for `**` is `/\*\*([^\n]+?)\*\*/g` which
/// is non-greedy but linewise, so the shortest non-empty same-line pairing
/// wins. We replicate that with left-to-right scanning.
fn replace_paired_delim(input: &str, delim: &str, open: &str, close: &str) -> String {
    if delim.is_empty() || !input.contains(delim) {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let delim_bytes = delim.as_bytes();
    let mut out = String::with_capacity(input.len() + 32);
    let mut cursor = 0;

    while cursor < bytes.len() {
        if let Some(open_rel) = find_bytes(&bytes[cursor..], delim_bytes) {
            let open_pos = cursor + open_rel;
            // TS regex requires at least one non-delim, non-newline char.
            let inner_start = open_pos + delim_bytes.len();
            if inner_start >= bytes.len() {
                out.push_str(&input[cursor..]);
                break;
            }
            // Find the next delim *before* any newline.
            if let Some(close_pos) = find_delim_before_newline(bytes, inner_start, delim_bytes) {
                if close_pos > inner_start {
                    let content = &input[inner_start..close_pos];
                    out.push_str(&input[cursor..open_pos]);
                    out.push_str(open);
                    out.push_str(content);
                    out.push_str(close);
                    cursor = close_pos + delim_bytes.len();
                    continue;
                }
                // Adjacent delims: skip this opening and continue.
                out.push_str(&input[cursor..open_pos + delim_bytes.len()]);
                cursor = open_pos + delim_bytes.len();
                continue;
            }
            // No close before newline / EOF; treat as literal.
            out.push_str(&input[cursor..]);
            break;
        } else {
            out.push_str(&input[cursor..]);
            break;
        }
    }

    out
}

fn find_delim_before_newline(bytes: &[u8], start: usize, delim: &[u8]) -> Option<usize> {
    let mut i = start;
    while i + delim.len() <= bytes.len() {
        if bytes[i] == b'\n' {
            return None;
        }
        if &bytes[i..i + delim.len()] == delim {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Replace `_word_` / `*word*` paired italic markers that are word-bounded
/// the same way TS does:
///
/// - for `_`: opening has a non-word-char prefix and is not followed by `_`,
///   closing is not followed by another word char
/// - for `*`: opening has a non-word/non-asterisk prefix and is not followed
///   by `*`, closing is not followed by another word char
///
/// Everything between opens and closes must be non-newline and at least one
/// char (the TS pattern uses `[^_\n][^\n]*?` / `[^*\n][^\n]*?`).
fn replace_word_bounded_italic(input: &str, delim: char) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len() + 16);
    let mut cursor = 0;
    while cursor < chars.len() {
        if chars[cursor] == delim {
            // Prefix rule: either at start, or preceded by a non-word
            // (and, for '*', non-'*') character.
            let prefix_ok = if cursor == 0 {
                true
            } else {
                let prev = chars[cursor - 1];
                let is_word_prev = prev.is_alphanumeric() || prev == '_';
                if delim == '*' {
                    !is_word_prev && prev != '*'
                } else {
                    !is_word_prev
                }
            };
            if prefix_ok && cursor + 1 < chars.len() {
                let after_open = chars[cursor + 1];
                // TS: first captured char is `[^_\n]` / `[^*\n]`, plus non-newline.
                let inner_head_ok = after_open != '\n' && after_open != delim;
                if inner_head_ok && let Some(close) = find_italic_close(&chars, cursor + 1, delim) {
                    let content: String = chars[cursor + 1..close].iter().collect();
                    let prefix: String = if cursor == 0 {
                        String::new()
                    } else {
                        chars[cursor - 1].to_string()
                    };
                    // Match TS: replacement keeps the prefix before the
                    // `<i>` so the boundary char is retained.
                    // But we've already appended the prefix to `out`, so
                    // we strip the trailing copy of it and re-append with
                    // the italic tags.
                    if cursor > 0 {
                        // Pop the prefix char we already emitted.
                        let popped_len = prefix.len();
                        out.truncate(out.len() - popped_len);
                        out.push_str(&prefix);
                    }
                    out.push_str("<i>");
                    out.push_str(&content);
                    out.push_str("</i>");
                    cursor = close + 1;
                    continue;
                }
            }
            out.push(delim);
            cursor += 1;
        } else {
            out.push(chars[cursor]);
            cursor += 1;
        }
    }
    out
}

fn find_italic_close(chars: &[char], inner_start: usize, delim: char) -> Option<usize> {
    // Non-greedy: first valid close-candidate that isn't followed by a word-char.
    let mut i = inner_start;
    while i < chars.len() {
        if chars[i] == '\n' {
            return None;
        }
        if chars[i] == delim {
            // Require: closing is not followed by a word-char (the TS
            // negative lookahead `(?!\w)`).
            let next = chars.get(i + 1).copied();
            let is_word_next = matches!(next, Some(c) if c.is_alphanumeric() || c == '_');
            if !is_word_next {
                // Must have at least one inner char.
                if i > inner_start {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let limit = haystack.len() - needle.len();
    let mut i = 0;
    while i <= limit {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(s: &str) -> String {
        let r = render_telegram_message(s);
        assert_eq!(r.parse_mode, "HTML");
        r.text
    }

    #[test]
    fn plain_text_is_escaped_only() {
        assert_eq!(render("hello"), "hello");
        assert_eq!(render("a & b <c>"), "a &amp; b &lt;c&gt;");
    }

    #[test]
    fn crlf_is_normalized() {
        assert_eq!(render("a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn fenced_block_without_language() {
        let out = render("```\nsome <code>\n```");
        assert_eq!(out, "<pre>some &lt;code&gt;</pre>");
    }

    #[test]
    fn fenced_block_with_language_escapes_class_attribute() {
        let out = render("```rust\nlet x = 1;\n```");
        assert_eq!(
            out,
            "<pre><code class=\"language-rust\">let x = 1;</code></pre>"
        );
    }

    #[test]
    fn inline_code_is_escaped_and_wrapped() {
        let out = render("before `x < y` after");
        assert_eq!(out, "before <code>x &lt; y</code> after");
    }

    #[test]
    fn heading_becomes_bold() {
        let out = render("# Title & stuff");
        assert_eq!(out, "<b>Title &amp; stuff</b>");
    }

    #[test]
    fn heading_strips_outer_bold() {
        let out = render("## **Wrapped**");
        assert_eq!(out, "<b>Wrapped</b>");
    }

    #[test]
    fn heading_strips_outer_underline() {
        let out = render("### __Wrapped__");
        assert_eq!(out, "<b>Wrapped</b>");
    }

    #[test]
    fn bullets_are_bulleted() {
        let out = render("- one\n* two");
        assert_eq!(out, "• one\n• two");
    }

    #[test]
    fn quote_becomes_blockquote() {
        let out = render("> quoted line");
        assert_eq!(out, "<blockquote>quoted line</blockquote>");
    }

    #[test]
    fn bold_italic_underline_spoiler_strike() {
        assert_eq!(render("**bold**"), "<b>bold</b>");
        assert_eq!(render("__under__"), "<u>under</u>");
        assert_eq!(render("~~strike~~"), "<s>strike</s>");
        assert_eq!(render("||spoil||"), "<tg-spoiler>spoil</tg-spoiler>");
    }

    #[test]
    fn italic_word_bounded() {
        assert_eq!(render("one _two_ three"), "one <i>two</i> three");
        assert_eq!(render("one *two* three"), "one <i>two</i> three");
    }

    #[test]
    fn italic_skips_underscores_inside_words() {
        // `foo_bar_baz` must not be italicized: both underscores have word
        // chars on both sides.
        let out = render("foo_bar_baz");
        assert_eq!(out, "foo_bar_baz");
    }

    #[test]
    fn link_becomes_anchor() {
        let out = render("see [site](https://example.com)");
        assert_eq!(out, "see <a href=\"https://example.com\">site</a>");
    }

    #[test]
    fn link_escapes_url() {
        // Match the TS renderer: the entire escaped line is fed to
        // `renderInlineMarkdown`, which then runs `escapeAttribute` on the
        // already-escaped URL. The net effect is double-escaped `&`.
        // Existing TS clients already see this output, so Rust preserves it.
        let out = render("[x](https://ex.com/a&b)");
        assert_eq!(out, "<a href=\"https://ex.com/a&amp;amp;b\">x</a>");
    }

    #[test]
    fn code_blocks_are_not_further_formatted() {
        // Without this, "**bold**" inside a fence would be double-rewritten.
        let out = render("```\n**not bold**\n```");
        assert_eq!(out, "<pre>**not bold**</pre>");
    }

    #[test]
    fn inline_code_skips_further_formatting() {
        let out = render("`**not bold**`");
        assert_eq!(out, "<code>**not bold**</code>");
    }

    #[test]
    fn mixed_paragraph() {
        let out = render("# Heading\n\nSome **bold** and `code`.\n- item _one_\n- item two");
        assert_eq!(
            out,
            "<b>Heading</b>\n\nSome <b>bold</b> and <code>code</code>.\n• item <i>one</i>\n• item two"
        );
    }

    #[test]
    fn unterminated_fence_is_left_literal() {
        let out = render("foo ``` bar");
        // Unterminated fence: literal `\`\`\``, rest of text escaped.
        assert!(out.contains("```"));
    }

    #[test]
    fn adjacent_bold_marker_does_not_match() {
        // `****` is two adjacent openers with empty interior; TS regex
        // rejects empty content.
        let out = render("****");
        assert_eq!(out, "****");
    }

    #[test]
    fn html_entities_in_raw_text_are_escaped_once() {
        let out = render("a & b");
        assert_eq!(out, "a &amp; b");
    }
}
