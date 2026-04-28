//! Strict `.env`-file parser.
//!
//! Mirrors `src/lib/parse-dotenv.ts` byte-for-byte. Each function in this
//! module is a pure transformation — no I/O. The caller reads the file
//! contents and hands the string to [`parse_dotenv`].
//!
//! Compared to the popular `dotenv` crate, this parser is **strict**:
//!
//! - Rejects malformed lines with [`DotenvParseError`] carrying the
//!   line number + reason — instead of silently skipping.
//! - Validates variable names against `^[A-Za-z_][A-Za-z0-9_]*$` —
//!   anything else is rejected.
//! - Honours `export ` prefixes (with whitespace) the way bash / sh do.
//! - Supports double-quoted values (with `\n`/`\r`/`\t`/`\"`/`\\`
//!   escapes), single-quoted values (no escapes), and unquoted values
//!   (with inline `#` comment stripping).
//!
//! These guarantees match the TS contract used by every `.env` consumer
//! in TENEX.

use std::collections::BTreeMap;

/// Error returned by [`parse_dotenv`] for a malformed line. The
/// `Display` shape matches the TS class verbatim:
/// `"Invalid .env syntax on line <line>: <reason>"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DotenvParseError {
    pub line: usize,
    pub reason: String,
}

impl std::fmt::Display for DotenvParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Invalid .env syntax on line {}: {}", self.line, self.reason)
    }
}

impl std::error::Error for DotenvParseError {}

fn is_valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    bytes
        .iter()
        .skip(1)
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// Decode `\n`, `\r`, `\t`, `\"`, `\\` inside a double-quoted value.
/// Other escape sequences pass through with the leading backslash
/// dropped (matches the TS regex behaviour).
fn parse_double_quoted_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Strip an inline comment from an unquoted value. Mirrors TS at
/// `:34-44`: a `#` is a comment-start only when it's at column 0 OR
/// preceded by whitespace.
fn strip_inline_comment(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c == '#' {
            let prev_is_space = if i == 0 {
                true
            } else {
                chars[i - 1].is_whitespace()
            };
            if prev_is_space {
                let head: String = chars[..i].iter().collect();
                return head.trim_end().to_owned();
            }
        }
    }
    value.trim_end().to_owned()
}

/// Parse a value from its raw form. Distinguishes the three flavours:
/// double-quoted, single-quoted, unquoted.
fn parse_value(raw: &str, line: usize) -> Result<String, DotenvParseError> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let mut chars = raw.chars();
    let first = chars.next().expect("non-empty checked above");
    if first != '"' && first != '\'' {
        return Ok(strip_inline_comment(raw));
    }

    let quote = first;
    let mut value = String::new();
    let body: Vec<char> = chars.collect();
    let mut i = 0;
    while i < body.len() {
        let c = body[i];
        // For double quotes, skip if previous was a backslash (escape).
        let escaped = if i > 0 && quote == '"' {
            body[i - 1] == '\\'
        } else {
            false
        };
        if c == quote && (quote == '\'' || !escaped) {
            // Close quote — anything after must be whitespace or `#…`.
            let remainder: String = body[i + 1..].iter().collect();
            let remainder_trimmed = remainder.trim();
            if !remainder_trimmed.is_empty() && !remainder_trimmed.starts_with('#') {
                return Err(DotenvParseError {
                    line,
                    reason: "unexpected characters after quoted value".to_owned(),
                });
            }
            return Ok(if quote == '"' {
                parse_double_quoted_value(&value)
            } else {
                value
            });
        }
        value.push(c);
        i += 1;
    }
    Err(DotenvParseError {
        line,
        reason: "unterminated quoted value".to_owned(),
    })
}

/// Parse a `.env`-style buffer into key/value pairs. Mirrors
/// `parseDotenv` (`parse-dotenv.ts:81-113`).
///
/// Returns a `BTreeMap` rather than a `HashMap` so iteration order is
/// deterministic for any caller that emits the parsed values.
pub fn parse_dotenv(content: &str) -> Result<BTreeMap<String, String>, DotenvParseError> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (idx, original) in content.split('\n').enumerate() {
        // The TS source splits on `\r?\n` — we strip a trailing `\r`
        // here for the same effect (CRLF files).
        let original = original.strip_suffix('\r').unwrap_or(original);
        let line_no = idx + 1;
        let trimmed = original.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let mut line = original.trim_start();
        // Honour `export <KEY>=<value>` with a whitespace separator.
        if line.starts_with("export") {
            let after = &line[6..];
            if after.starts_with(|c: char| c.is_whitespace()) {
                line = after.trim_start();
            }
        }

        let separator_index = line.find('=');
        let separator_index = match separator_index {
            Some(0) | None => {
                return Err(DotenvParseError {
                    line: line_no,
                    reason: "expected KEY=value assignment".to_owned(),
                });
            }
            Some(i) => i,
        };

        let key = line[..separator_index].trim().to_owned();
        if !is_valid_key(&key) {
            return Err(DotenvParseError {
                line: line_no,
                reason: format!("invalid variable name \"{key}\""),
            });
        }
        let raw_value = line[separator_index + 1..].trim_start();
        let value = parse_value(raw_value, line_no)?;
        out.insert(key, value);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Result<BTreeMap<String, String>, DotenvParseError> {
        parse_dotenv(input)
    }

    fn parse_ok(input: &str) -> BTreeMap<String, String> {
        parse(input).unwrap()
    }

    fn err(input: &str) -> DotenvParseError {
        parse(input).unwrap_err()
    }

    // ── empty / comments / whitespace ───────────────────────────────────

    #[test]
    fn empty_input_returns_empty_map() {
        assert!(parse_ok("").is_empty());
    }

    #[test]
    fn pure_comment_lines_are_skipped() {
        let m = parse_ok("# a comment\n# another\n");
        assert!(m.is_empty());
    }

    #[test]
    fn whitespace_only_lines_are_skipped() {
        let m = parse_ok("   \n\t\n\n");
        assert!(m.is_empty());
    }

    // ── basic assignments ───────────────────────────────────────────────

    #[test]
    fn simple_unquoted_assignment() {
        let m = parse_ok("FOO=bar");
        assert_eq!(m.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn multiple_assignments_preserved_in_map() {
        let m = parse_ok("A=1\nB=2\nC=3\n");
        assert_eq!(m.get("A").unwrap(), "1");
        assert_eq!(m.get("B").unwrap(), "2");
        assert_eq!(m.get("C").unwrap(), "3");
    }

    #[test]
    fn empty_value_is_allowed() {
        let m = parse_ok("EMPTY=");
        assert_eq!(m.get("EMPTY").unwrap(), "");
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let m = parse_ok("A=1\r\nB=2\r\n");
        assert_eq!(m.get("A").unwrap(), "1");
        assert_eq!(m.get("B").unwrap(), "2");
    }

    #[test]
    fn export_prefix_is_stripped() {
        let m = parse_ok("export FOO=bar\nexport\tBAZ=qux\n");
        assert_eq!(m.get("FOO").unwrap(), "bar");
        assert_eq!(m.get("BAZ").unwrap(), "qux");
    }

    #[test]
    fn export_without_whitespace_after_is_treated_as_a_key() {
        // `exportFOO=bar` is NOT `export FOO=bar` — the regex requires
        // a whitespace separator after `export`.
        let m = parse_ok("exportFOO=bar");
        assert_eq!(m.get("exportFOO").unwrap(), "bar");
    }

    // ── inline comments ─────────────────────────────────────────────────

    #[test]
    fn inline_comment_in_unquoted_is_stripped() {
        let m = parse_ok("FOO=bar # a comment");
        assert_eq!(m.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn hash_without_preceding_whitespace_is_not_a_comment() {
        let m = parse_ok("FOO=bar#notacomment");
        assert_eq!(m.get("FOO").unwrap(), "bar#notacomment");
    }

    #[test]
    fn inline_comment_at_column_zero_of_value_is_a_comment() {
        // The TS check is `index === 0 || /\s/.test(prev)` — an `#` at
        // the START of the value (after the `=`) IS a comment.
        let m = parse_ok("FOO=#nope");
        assert_eq!(m.get("FOO").unwrap(), "");
    }

    // ── quoted values ───────────────────────────────────────────────────

    #[test]
    fn double_quoted_values_decode_escapes() {
        let m = parse_ok(r#"GREETING="hello\nworld""#);
        assert_eq!(m.get("GREETING").unwrap(), "hello\nworld");
    }

    #[test]
    fn double_quoted_values_handle_escaped_quote() {
        // `\"` is correctly handled — the close-quote scan looks at
        // the preceding character; a `\` cancels the close.
        let m = parse_ok(r#"X="he said \"hi\" today""#);
        assert_eq!(m.get("X").unwrap(), "he said \"hi\" today");
    }

    #[test]
    fn trailing_double_backslash_is_a_known_quirk() {
        // The TS source's close-quote scan checks only the *single*
        // preceding char (`rawValue[index - 1] !== "\\"`), so a value
        // ending in `\\"` is interpreted as an escaped quote — the
        // string never closes and the parser errors out as
        // "unterminated quoted value". Mirrored verbatim. If a user
        // needs a literal trailing backslash they have to put it
        // mid-value or use single quotes.
        let e = err(r#"X="end \\"#);
        assert_eq!(e.reason, "unterminated quoted value");
    }

    #[test]
    fn single_quoted_values_pass_through_literal() {
        // No escape processing inside single quotes.
        let m = parse_ok(r#"X='hello\nworld'"#);
        assert_eq!(m.get("X").unwrap(), r"hello\nworld");
    }

    #[test]
    fn double_quoted_values_handle_internal_hashes() {
        let m = parse_ok(r#"X="value # not a comment""#);
        assert_eq!(m.get("X").unwrap(), "value # not a comment");
    }

    #[test]
    fn quoted_value_can_have_trailing_comment() {
        let m = parse_ok(r#"X="real" # comment"#);
        assert_eq!(m.get("X").unwrap(), "real");
    }

    #[test]
    fn unterminated_double_quote_errors() {
        let e = err(r#"X="hello"#);
        assert_eq!(e.line, 1);
        assert_eq!(e.reason, "unterminated quoted value");
    }

    #[test]
    fn unterminated_single_quote_errors() {
        let e = err(r#"X='hello"#);
        assert_eq!(e.line, 1);
        assert_eq!(e.reason, "unterminated quoted value");
    }

    #[test]
    fn unexpected_chars_after_quoted_value_errors() {
        let e = err(r#"X="hello" extra"#);
        assert_eq!(e.line, 1);
        assert_eq!(e.reason, "unexpected characters after quoted value");
    }

    // ── error paths ─────────────────────────────────────────────────────

    #[test]
    fn missing_equals_errors_with_line_number() {
        let e = err("A=1\nNOEQUALS\n");
        assert_eq!(e.line, 2);
        assert_eq!(e.reason, "expected KEY=value assignment");
    }

    #[test]
    fn equals_at_column_zero_errors() {
        // TS `separatorIndex <= 0` covers both `-1` (no `=`) and `0`
        // (line starts with `=`).
        let e = err("=value");
        assert_eq!(e.reason, "expected KEY=value assignment");
    }

    #[test]
    fn invalid_key_errors_with_quoted_name() {
        let e = err("1FOO=bar");
        assert_eq!(e.reason, "invalid variable name \"1FOO\"");
    }

    #[test]
    fn key_with_dash_is_invalid() {
        let e = err("foo-bar=baz");
        assert!(e.reason.contains("invalid variable name"));
    }

    #[test]
    fn key_with_dot_is_invalid() {
        let e = err("foo.bar=baz");
        assert!(e.reason.contains("invalid variable name"));
    }

    // ── valid key shape ─────────────────────────────────────────────────

    #[test]
    fn valid_keys_accept_underscores_and_digits() {
        let m = parse_ok("_X=1\nFOO_BAR=2\nA1=3");
        assert!(m.contains_key("_X"));
        assert!(m.contains_key("FOO_BAR"));
        assert!(m.contains_key("A1"));
    }

    #[test]
    fn valid_keys_can_be_lowercase() {
        let m = parse_ok("foo=1");
        assert_eq!(m.get("foo").unwrap(), "1");
    }

    // ── verbatim Display ────────────────────────────────────────────────

    #[test]
    fn display_renders_verbatim_ts_message() {
        // Source: parse-dotenv.ts:6 — `Invalid .env syntax on line ${line}: ${reason}`.
        let e = DotenvParseError {
            line: 7,
            reason: "stuff broke".to_owned(),
        };
        assert_eq!(e.to_string(), "Invalid .env syntax on line 7: stuff broke");
    }
}
