//! Walk-forward, paginated relay reader.
//!
//! Two-pass per page:
//! - **Pass A**: scope filter — `kinds=[1] #a=<owner_a_tags> since=<cursor>
//!   limit=<page>` — events directly tagged at owner-owned projects.
//! - **Pass B**: thread fill — for each new conversation root id seen in
//!   Pass A (resolved via `conversation_id_from_event`), fetch
//!   `kinds=[1] #e=<root_id>` so we don't lose replies that drop the
//!   `a` tag.
//!
//! Both passes use `client.fetch_events` against the configured relay
//! list. The accumulator dedupes by `event.id` because pages overlap on
//! the `since` boundary.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{Context, Result};
use nostr::event::Event;
use nostr_sdk::prelude::*;
use tracing::{debug, warn};

use tenex_protocol::event_filter::{
    conversation_id_from_event, is_conversation_event, CONVERSATION_KINDS_RAW,
};

const FETCH_TIMEOUT_SECS: u64 = 30;

pub struct Relay {
    client: Client,
    relays: Vec<String>,
}

impl Relay {
    /// Build a relay reader connected to every URL in `relays`. The provided
    /// signer authenticates to NIP-42 auth-required relays automatically.
    pub async fn connect(relays: Vec<String>, signer: Keys) -> Result<Self> {
        let client = Client::builder()
            .signer(signer)
            .opts(ClientOptions::new().automatic_authentication(true))
            .build();
        for url in &relays {
            client
                .add_relay(url.as_str())
                .await
                .with_context(|| format!("add relay {url}"))?;
        }
        client.connect().await;
        Ok(Self { client, relays })
    }

    pub fn relays(&self) -> &[String] {
        &self.relays
    }

    /// Fetch one page of events ending at `until_secs` and walking
    /// backward, plus the thread fill for any new roots discovered.
    /// Returns events sorted by `created_at ASC`. The caller pages by
    /// advancing `until` to one second before the oldest event in the
    /// returned set.
    pub async fn fetch_page(
        &self,
        scope_a_tags: &[String],
        until_secs: i64,
        page_limit: usize,
    ) -> Result<Page> {
        let kinds: Vec<Kind> = CONVERSATION_KINDS_RAW
            .iter()
            .copied()
            .map(Kind::from)
            .collect();
        let mut filter = Filter::new().kinds(kinds.clone()).limit(page_limit);
        if until_secs > 0 {
            filter = filter.until(Timestamp::from(until_secs as u64));
        }
        if !scope_a_tags.is_empty() {
            filter = filter.custom_tags(
                SingleLetterTag::lowercase(Alphabet::A),
                scope_a_tags.iter().map(|s| s.as_str()),
            );
        }
        debug!(
            until_secs,
            page_limit,
            scope_a_tags = scope_a_tags.len(),
            "relay fetch_page: pass A starting"
        );
        let pass_a = self
            .client
            .fetch_events(filter, Duration::from_secs(FETCH_TIMEOUT_SECS))
            .await
            .context("relay pass A fetch")?;
        debug!(
            pass_a_count = pass_a.len(),
            "relay fetch_page: pass A complete"
        );

        let mut by_id: HashSet<String> = HashSet::new();
        let mut events: Vec<Event> = Vec::new();
        for ev in pass_a.into_iter() {
            if !is_conversation_event(&ev) {
                continue;
            }
            if by_id.insert(ev.id.to_hex()) {
                events.push(ev);
            }
        }

        // Pass B: thread fill. For each new root id seen in pass A,
        // pull replies that may have dropped the a-tag.
        let mut roots: HashSet<String> = HashSet::new();
        for ev in &events {
            roots.insert(conversation_id_from_event(ev));
        }
        let root_ids: Vec<EventId> = roots
            .iter()
            .filter_map(|s| EventId::parse(s).ok())
            .collect();

        if !root_ids.is_empty() {
            let fill_filter = Filter::new()
                .kinds(kinds.clone())
                .events(root_ids.into_iter());
            match self
                .client
                .fetch_events(fill_filter, Duration::from_secs(FETCH_TIMEOUT_SECS))
                .await
            {
                Ok(extras) => {
                    for ev in extras.into_iter() {
                        if !is_conversation_event(&ev) {
                            continue;
                        }
                        if by_id.insert(ev.id.to_hex()) {
                            events.push(ev);
                        }
                    }
                }
                Err(e) => {
                    warn!(error = %e, "relay pass B fetch failed; continuing with pass A only");
                }
            }
        }

        events.sort_by(|a, b| {
            a.created_at
                .as_secs()
                .cmp(&b.created_at.as_secs())
                .then_with(|| a.id.to_hex().cmp(&b.id.to_hex()))
        });

        let oldest_secs = events.first().map(|e| e.created_at.as_secs() as i64);
        let event_count = events.len();
        let root_count = events
            .iter()
            .map(|e| conversation_id_from_event(e))
            .collect::<HashSet<_>>()
            .len();

        Ok(Page {
            events,
            event_count,
            root_count,
            oldest_secs,
        })
    }
}

#[derive(Debug)]
pub struct Page {
    pub events: Vec<Event>,
    pub event_count: usize,
    pub root_count: usize,
    /// Lowest `created_at` seen on this page; `None` if the page was empty.
    /// Used by the caller to advance the `until` cursor backward.
    pub oldest_secs: Option<i64>,
}
