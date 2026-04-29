//! Bespoke prompts that need full render control beyond what `inquire`'s
//! [`RenderConfig`] exposes — provider-select with browse/keys panes, the
//! variant-list editor, the role-menu, the agent-select prompt, and the
//! onboarding relay prompt.
//!
//! Each prompt is split into:
//!
//! - A **pure state machine** (no I/O) that maps keypresses to model
//!   transitions — testable in isolation, no terminal needed.
//! - An **I/O loop** that puts the terminal in raw mode via [`RawMode`],
//!   reads `crossterm` keypresses, hands them to the state machine, and
//!   redraws on each frame.
//!
//! Cursor convention (per spec doc 12 §2): the four custom prompts that
//! render their own list (`provider-select-prompt`, `variant-list-prompt`,
//! `roles.ts`, `onboard.ts:319`) all use the **thin chevron** `›` (U+203A)
//! in `#FFC107`, not the heavy `❯` used by stock inquire prompts. The
//! `relayPrompt` (`src/commands/onboard.ts:37-118`) is a bespoke render but
//! still uses `theme.icon.cursor` (`❯`) because it consumes the inquirer
//! theme directly. Reproduce this asymmetry — do not unify.

pub mod agent_select_prompt;
pub mod help_row;
pub mod llm_menu_prompt;
pub mod provider_select_prompt;
pub mod raw_mode;
pub mod relay_prompt;
pub mod role_menu_prompt;
pub mod section_menu_prompt;

pub mod variant_list_prompt;

// Re-exports below cover symbols that are imported by external modules
// via `custom_prompts::Foo` (rather than the deeper
// `custom_prompts::foo_prompt::Foo` path). Anything reached only via the
// submodule path is intentionally NOT re-exported here — keeps the
// surface lean and the "unused import" warning surface clean. Per
// CLAUDE.md "delete unused code".

pub use provider_select_prompt::{
    provider_select_prompt, ApiKeyValue, ProviderCredentialsLite, ProviderMode,
    ProviderSelectResult, ProviderState,
};
pub use raw_mode::RawMode;
pub use relay_prompt::{relay_prompt, RelayItem, RelayPromptConfig};
pub use role_menu_prompt::{role_menu_prompt, RoleKey, RoleMenuResult, RoleMenuState, ROLES};
