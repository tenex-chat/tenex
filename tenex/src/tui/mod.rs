//! Shared TUI primitives: theme palette, banner, glyphs.
//!
//! This module is the canonical source for visual styling. Any color or glyph
//! used by the TENEX CLI MUST come from here — never hardcoded — so that the
//! palette stays coherent and the two oranges (see `theme`) cannot collapse.

pub mod banner;
pub mod custom_prompts;
pub mod display;
pub mod glyphs;
pub mod prompts;
pub mod theme;
