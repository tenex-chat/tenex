//! Pubkey shortening for the two distinct contexts pubkeys get truncated in.
//!
//! Both currently take the first 8 hex characters, but they are kept
//! separate on purpose:
//!
//! - [`shorten_for_path`] feeds the on-disk agent-home and skill directory
//!   layout. It is a serialization contract shared by the publisher and the
//!   reader of kind:0 skill advertisements; changing its length orphans
//!   existing directories.
//! - [`shorten_for_display`] is purely cosmetic — agent labels, log fields,
//!   prompt context.
//!
//! Keeping them apart means a future change to display width cannot silently
//! relocate every agent-home directory.

/// Prefix length for human-facing pubkey display (labels, logs, prompts).
pub const DISPLAY_PREFIX_LENGTH: usize = 8;

/// Prefix length for the on-disk agent-home / skill directory layout.
pub const PATH_PREFIX_LENGTH: usize = 8;

/// Shorten a pubkey for human-facing display.
pub fn shorten_for_display(pubkey: &str) -> String {
    pubkey.chars().take(DISPLAY_PREFIX_LENGTH).collect()
}

/// Shorten a pubkey for the on-disk agent-home / skill directory layout.
///
/// Load-bearing: every producer and consumer of these paths must agree, so
/// they all route through this one function.
pub fn shorten_for_path(pubkey: &str) -> String {
    pubkey.chars().take(PATH_PREFIX_LENGTH).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_takes_first_8_chars() {
        let pubkey = "bbd73ea24afbd2b60574f3ce9a6e8554d3f79cc4b41fd59f110e5fd8b47a32de";
        assert_eq!(shorten_for_display(pubkey), "bbd73ea2");
        assert_eq!(shorten_for_display(pubkey).len(), 8);
    }

    #[test]
    fn path_takes_first_8_chars() {
        let pubkey = "bbd73ea24afbd2b60574f3ce9a6e8554d3f79cc4b41fd59f110e5fd8b47a32de";
        assert_eq!(shorten_for_path(pubkey), "bbd73ea2");
    }

    #[test]
    fn shorter_than_prefix_returns_input() {
        assert_eq!(shorten_for_display("abc"), "abc");
        assert_eq!(shorten_for_path("abc"), "abc");
    }
}
