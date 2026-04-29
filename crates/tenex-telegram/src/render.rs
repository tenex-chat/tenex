//! Converts markdown content to Telegram HTML parse mode.
//!
//! Mirrors `src/services/telegram/telegram-message-renderer.ts`.

pub struct RenderedMessage {
    pub text: String,
    pub parse_mode: &'static str,
}

pub fn render_message(content: &str) -> RenderedMessage {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");

    // Extract fenced code blocks before HTML escaping so their content is
    // not double-escaped.
    let (after_fences, fence_replacements) = extract_fenced_blocks(&normalized);
    let (after_inline, inline_replacements) = extract_inline_code(&after_fences);

    let escaped = escape_html(&after_inline);

    let rendered_lines: Vec<String> = escaped.split('\n').map(|line| render_line(line)).collect();

    let joined = rendered_lines.join("\n");
    let with_inline = restore_placeholders(&joined, &inline_replacements);
    let with_fences = restore_placeholders(&with_inline, &fence_replacements);

    RenderedMessage {
        text: with_fences,
        parse_mode: "HTML",
    }
}

fn placeholder(index: usize) -> String {
    format!("%%TENEX_TG_PLACEHOLDER_{index}%%")
}

fn extract_fenced_blocks(input: &str) -> (String, Vec<String>) {
    let mut replacements = Vec::new();
    let mut output = String::new();
    let mut remaining = input;

    while let Some(start) = remaining.find("```") {
        output.push_str(&remaining[..start]);
        let after_ticks = &remaining[start + 3..];

        let (lang, code_start) = if let Some(nl) = after_ticks.find('\n') {
            let possible_lang = after_ticks[..nl].trim();
            if possible_lang.is_empty() {
                ("", after_ticks)
            } else {
                (possible_lang, &after_ticks[nl + 1..])
            }
        } else {
            ("", after_ticks)
        };

        let (code, rest) = if let Some(end) = code_start.find("```") {
            (&code_start[..end], &code_start[end + 3..])
        } else {
            (code_start, "")
        };

        let escaped_code = escape_html(code.trim_end_matches('\n'));
        let html = if lang.is_empty() {
            format!("<pre>{escaped_code}</pre>")
        } else {
            let esc_lang = escape_attribute(lang);
            format!(r#"<pre><code class="language-{esc_lang}">{escaped_code}</code></pre>"#)
        };

        let ph = placeholder(replacements.len());
        replacements.push(html);
        output.push_str(&ph);
        remaining = rest;
    }
    output.push_str(remaining);
    (output, replacements)
}

fn extract_inline_code(input: &str) -> (String, Vec<String>) {
    let mut replacements = Vec::new();
    let mut output = String::new();
    let mut remaining = input;

    while let Some(start) = remaining.find('`') {
        output.push_str(&remaining[..start]);
        let after = &remaining[start + 1..];
        if let Some(end) = after.find('`') {
            let code = &after[..end];
            if !code.contains('\n') {
                let html = format!("<code>{}</code>", escape_html(code));
                let ph = placeholder(replacements.len());
                replacements.push(html);
                output.push_str(&ph);
                remaining = &after[end + 1..];
                continue;
            }
        }
        output.push('`');
        remaining = after;
    }
    output.push_str(remaining);
    (output, replacements)
}

fn restore_placeholders(input: &str, replacements: &[String]) -> String {
    let mut result = input.to_string();
    for (i, replacement) in replacements.iter().enumerate() {
        result = result.replace(&placeholder(i), replacement);
    }
    result
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_attribute(text: &str) -> String {
    escape_html(text)
}

fn render_line(line: &str) -> String {
    // Heading: # ... ###### (after HTML escaping, so no special chars)
    if let Some(rest) = line.strip_prefix('#') {
        let trimmed = rest.trim_start_matches('#').trim_start_matches(' ');
        if !trimmed.is_empty() && rest.starts_with(|c: char| c == ' ' || c == '#') {
            let inner = strip_outer_bold(trimmed);
            return format!("<b>{}</b>", render_inline(inner));
        }
    }

    // Blockquote: &gt; (after escaping >)
    if let Some(rest) = line.strip_prefix("&gt;") {
        let inner = rest.trim_start_matches(' ');
        return format!("<blockquote>{}</blockquote>", render_inline(inner));
    }

    // Bullet: - or * followed by space
    if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return format!("• {}", render_inline(rest));
    }

    render_inline(line).to_string()
}

fn strip_outer_bold(s: &str) -> &str {
    let s = s.trim();
    if s.starts_with("**") && s.ends_with("**") && s.len() > 4 {
        return &s[2..s.len() - 2];
    }
    if s.starts_with("__") && s.ends_with("__") && s.len() > 4 {
        return &s[2..s.len() - 2];
    }
    s
}

fn render_inline(input: &str) -> String {
    let mut text = input.to_string();

    // Links: [label](url)
    text = replace_with(
        &text,
        r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)",
        |caps: &[&str]| format!(r#"<a href="{}">{}</a>"#, escape_attribute(caps[2]), caps[1]),
    );

    // Spoiler: ||text||
    text = replace_with(&text, r"\|\|([^\n]+?)\|\|", |caps: &[&str]| {
        format!("<tg-spoiler>{}</tg-spoiler>", caps[1])
    });

    // Strikethrough: ~~text~~
    text = replace_with(&text, r"~~([^\n]+?)~~", |caps: &[&str]| {
        format!("<s>{}</s>", caps[1])
    });

    // Bold: **text**
    text = replace_with(&text, r"\*\*([^\n]+?)\*\*", |caps: &[&str]| {
        format!("<b>{}</b>", caps[1])
    });

    // Underline: __text__
    text = replace_with(&text, r"__([^\n]+?)__", |caps: &[&str]| {
        format!("<u>{}</u>", caps[1])
    });

    // Italic: _text_ (word-boundary guarded). The Rust `regex` crate does not
    // support look-around, so guards are encoded as captured leading/trailing
    // context that is re-emitted alongside the italic span.
    text = replace_with(
        &text,
        r"(^|[^\w])_([^_\n][^\n]*?)_($|[^\w])",
        |caps: &[&str]| format!("{}<i>{}</i>{}", caps[1], caps[2], caps[3]),
    );

    // Italic: *text* (word-boundary guarded)
    text = replace_with(
        &text,
        r"(^|[^\w*])\*([^*\n][^\n]*?)\*($|[^\w])",
        |caps: &[&str]| format!("{}<i>{}</i>{}", caps[1], caps[2], caps[3]),
    );

    text
}

fn replace_with<F>(input: &str, pattern: &str, replacer: F) -> String
where
    F: Fn(&[&str]) -> String,
{
    let re = regex::Regex::new(pattern).expect("invalid regex");
    re.replace_all(input, |caps: &regex::Captures<'_>| {
        let groups: Vec<&str> = (0..caps.len())
            .map(|i| caps.get(i).map_or("", |m| m.as_str()))
            .collect();
        replacer(&groups)
    })
    .into_owned()
}
