//! Outbound Nostr publishing — sign-and-send substrate for one-shot events.
//!
//! Mirrors the TS `InstalledAgentListService` (`src/services/status/`) and
//! the helpers around it (`config.getBackendSigner`,
//! `config.ensureBackendPrivateKey`).
//!
//! The daemon already maintains a long-running `Client` for subscriptions.
//! These helpers run from short-lived CLI commands (`tenex agent delete`,
//! the interactive manager, etc.), where we want to:
//!
//! 1. Load (or generate-and-persist) the backend signer.
//! 2. Build a single event.
//! 3. Connect → publish → drop.
//!
//! Each helper is bounded to a single Nostr kind. Adding a new kind = new
//! file, no shared abstractions.

pub mod backend_signer;
pub mod installed_agents;
