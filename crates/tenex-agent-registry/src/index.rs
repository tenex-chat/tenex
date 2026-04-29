use anyhow::{anyhow, Context, Result};
use indexmap::IndexMap;
use serde_json::Value;

use crate::atomic;
use crate::paths::index_file_path;
use crate::serde_util::serialize;

/// Single slug-index entry. Mirrors `SlugEntry` at `AgentStorage.ts:179-182`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlugEntry {
    pub pubkey: String,
    pub project_ids: Vec<String>,
}

/// Loaded `index.json` — preserves insertion order on round-trip.
#[derive(Clone, Default)]
pub struct AgentIndexDoc {
    /// `bySlug`, in source order.
    pub(crate) by_slug: IndexMap<String, SlugEntry>,
    /// `byEventId`, in source order.
    pub(crate) by_event_id: IndexMap<String, String>,
}

impl AgentIndexDoc {
    /// Load `<base>/agents/index.json`. If absent, returns an empty index.
    /// If the on-disk format is the old flat `bySlug: Record<string,string>`,
    /// migrates in-memory and writes the canonicalized form back to disk —
    /// matching `loadIndex` + `migrateIndexFormat` at
    /// `AgentStorage.ts:291-321, 341-361`. Any legacy `byProject` field is
    /// silently dropped.
    pub fn load(base_dir: &std::path::Path) -> Result<Self> {
        let path = index_file_path(base_dir);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let raw: Value =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

        let (doc, needs_migration) = parse_index(&raw)?;

        if needs_migration {
            let canonical = doc.serialize_bytes()?;
            atomic::write(&path, &canonical)?;
        }
        Ok(doc)
    }

    pub fn save(&self, base_dir: &std::path::Path) -> Result<()> {
        let bytes = self.serialize_bytes()?;
        atomic::write(&index_file_path(base_dir), &bytes)?;
        Ok(())
    }

    pub fn by_slug(&self) -> &IndexMap<String, SlugEntry> {
        &self.by_slug
    }

    pub fn by_event_id(&self) -> &IndexMap<String, String> {
        &self.by_event_id
    }

    pub fn lookup_pubkey_by_slug(&self, slug: &str) -> Option<&str> {
        self.by_slug.get(slug).map(|e| e.pubkey.as_str())
    }

    pub fn lookup_pubkey_by_event_id(&self, event_id: &str) -> Option<&str> {
        self.by_event_id.get(event_id).map(String::as_str)
    }

    pub fn serialize_bytes(&self) -> Result<Vec<u8>> {
        // Preserve declared shape: { "bySlug": {...}, "byEventId": {...} }.
        let mut out = IndexMap::<String, Value>::new();

        let mut by_slug = IndexMap::<String, Value>::new();
        for (slug, entry) in &self.by_slug {
            let mut e = IndexMap::<String, Value>::new();
            e.insert("pubkey".into(), Value::String(entry.pubkey.clone()));
            e.insert(
                "projectIds".into(),
                Value::Array(
                    entry
                        .project_ids
                        .iter()
                        .map(|p| Value::String(p.clone()))
                        .collect(),
                ),
            );
            by_slug.insert(slug.clone(), serde_json::to_value(e)?);
        }
        out.insert("bySlug".into(), serde_json::to_value(by_slug)?);

        let mut by_event_id = IndexMap::<String, Value>::new();
        for (eid, pk) in &self.by_event_id {
            by_event_id.insert(eid.clone(), Value::String(pk.clone()));
        }
        out.insert("byEventId".into(), serde_json::to_value(by_event_id)?);

        serialize(&out)
    }
}

pub(crate) fn parse_index(raw: &Value) -> Result<(AgentIndexDoc, bool)> {
    let obj = raw
        .as_object()
        .ok_or_else(|| anyhow!("agent index.json: top-level must be an object"))?;

    let mut by_slug: IndexMap<String, SlugEntry> = IndexMap::new();
    let mut needs_migration = false;

    if let Some(by_slug_val) = obj.get("bySlug") {
        let by_slug_obj = by_slug_val
            .as_object()
            .ok_or_else(|| anyhow!("bySlug must be an object"))?;
        for (slug, val) in by_slug_obj {
            match val {
                // Old format: `bySlug[slug] = pubkey` (flat string).
                Value::String(pubkey) => {
                    needs_migration = true;
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey: pubkey.clone(),
                            project_ids: Vec::new(),
                        },
                    );
                }
                Value::Object(entry) => {
                    let pubkey = entry
                        .get("pubkey")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("bySlug.{slug}.pubkey missing"))?
                        .to_owned();
                    let project_ids = entry
                        .get("projectIds")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    by_slug.insert(
                        slug.clone(),
                        SlugEntry {
                            pubkey,
                            project_ids,
                        },
                    );
                }
                _ => {
                    return Err(anyhow!("bySlug.{slug} must be string (legacy) or object"));
                }
            }
        }
    }

    let mut by_event_id: IndexMap<String, String> = IndexMap::new();
    if let Some(by_event_id_val) = obj.get("byEventId") {
        let by_event_id_obj = by_event_id_val
            .as_object()
            .ok_or_else(|| anyhow!("byEventId must be an object"))?;
        for (eid, val) in by_event_id_obj {
            let pk = val
                .as_str()
                .ok_or_else(|| anyhow!("byEventId.{eid} must be a string"))?
                .to_owned();
            by_event_id.insert(eid.clone(), pk);
        }
    }

    // Drop legacy `byProject` key — `migrateIndexFormat` ignores it
    // (`AgentStorage.ts:341-361`).
    if obj.contains_key("byProject") {
        needs_migration = true;
    }

    // Detect "extra unknown fields" — TS migration also ignores those, so
    // we treat them as a force-rewrite signal so the on-disk file gets
    // canonicalized to {bySlug, byEventId}.
    for k in obj.keys() {
        if k != "bySlug" && k != "byEventId" && k != "byProject" {
            needs_migration = true;
        }
    }

    Ok((
        AgentIndexDoc {
            by_slug,
            by_event_id,
        },
        needs_migration,
    ))
}
