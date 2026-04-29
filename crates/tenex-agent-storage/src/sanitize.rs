use indexmap::IndexMap;
use serde_json::Value;

/// `normalizeLoadedAgent` (`AgentStorage.ts:50-61`):
/// - sanitize top-level `telegram` (drop `chatBindings`; collapse to absent
///   if empty)
/// - if absent, fall back to legacy `default.telegram`
/// - sanitize `default` (drop legacy `default.telegram`; collapse to absent
///   if empty)
///
/// Returns `true` if any structural change was made.
pub(crate) fn normalize_loaded_agent(raw: &mut IndexMap<String, Value>) -> bool {
    let mut changed = false;

    // Capture the legacy default.telegram before mutating `default`.
    let legacy_default_telegram = raw
        .get("default")
        .and_then(Value::as_object)
        .and_then(|d| d.get("telegram"))
        .cloned();

    // Sanitize top-level telegram in place.
    let top_was_some = raw.get("telegram").is_some();
    if let Some(t) = raw.get_mut("telegram") {
        if sanitize_telegram_inplace(t) {
            changed = true;
        }
    }
    let top_is_empty = raw
        .get("telegram")
        .map(value_object_is_empty)
        .unwrap_or(false);
    if top_is_empty {
        raw.shift_remove("telegram");
        changed = true;
    }

    // If no top-level telegram (after sanitization), promote the legacy one.
    let has_top = raw.get("telegram").is_some();
    if !has_top {
        if let Some(mut promoted) = legacy_default_telegram.clone() {
            sanitize_telegram_inplace(&mut promoted);
            if !value_object_is_empty(&promoted) {
                raw.insert("telegram".into(), promoted);
                changed = true;
            }
        }
    } else if top_was_some {
        // Top-level was present and survived; legacy default.telegram is
        // dropped below by the default sanitization.
    }

    // Sanitize default block (drop legacy default.telegram).
    let default_changed = if let Some(d) = raw.get_mut("default") {
        sanitize_default_inplace(d)
    } else {
        false
    };
    if default_changed {
        changed = true;
    }
    let default_is_empty = raw
        .get("default")
        .map(value_object_is_empty)
        .unwrap_or(false);
    if default_is_empty {
        raw.shift_remove("default");
        changed = true;
    }

    changed
}

/// `migrateAgentData` (`AgentStorage.ts:253-264`): strip legacy
/// `projectOverrides` and `pmOverrides`. Returns `true` if anything was
/// removed.
pub(crate) fn migrate_agent_data(raw: &mut IndexMap<String, Value>) -> bool {
    let mut mutated = false;
    if raw.shift_remove("projectOverrides").is_some() {
        mutated = true;
    }
    if raw.shift_remove("pmOverrides").is_some() {
        mutated = true;
    }
    mutated
}

/// `sanitizeStoredAgentForPersistence` (`AgentStorage.ts:63-69`).
pub(crate) fn sanitize_for_persistence(raw: &mut IndexMap<String, Value>) {
    if let Some(t) = raw.get_mut("telegram") {
        sanitize_telegram_inplace(t);
    }
    if raw
        .get("telegram")
        .map(value_object_is_empty)
        .unwrap_or(false)
    {
        raw.shift_remove("telegram");
    }

    if let Some(d) = raw.get_mut("default") {
        sanitize_default_inplace(d);
    }
    if raw
        .get("default")
        .map(value_object_is_empty)
        .unwrap_or(false)
    {
        raw.shift_remove("default");
    }
}

/// `sanitizeTelegramConfig` (`AgentStorage.ts:22-34`):
/// - drop `chatBindings` (legacy)
/// - drop keys whose value is JSON `null` (TS `stripUndefinedValues` filters
///   `undefined` — `null` doesn't appear in TS via that path because
///   `JSON.stringify` drops `undefined` before serialization, so on-disk
///   nulls are an edge case we still scrub for safety)
pub(crate) fn sanitize_telegram_inplace(value: &mut Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if obj.shift_remove("chatBindings").is_some() {
        changed = true;
    }
    let null_keys: Vec<String> = obj
        .iter()
        .filter_map(|(k, v)| if v.is_null() { Some(k.clone()) } else { None })
        .collect();
    for k in null_keys {
        obj.shift_remove(&k);
        changed = true;
    }
    changed
}

/// `sanitizeDefaultConfig` (`AgentStorage.ts:36-48`):
/// - drop legacy `default.telegram`
/// - drop keys whose value is JSON null (parallel to telegram sanitizer)
pub(crate) fn sanitize_default_inplace(value: &mut Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if obj.shift_remove("telegram").is_some() {
        changed = true;
    }
    let null_keys: Vec<String> = obj
        .iter()
        .filter_map(|(k, v)| if v.is_null() { Some(k.clone()) } else { None })
        .collect();
    for k in null_keys {
        obj.shift_remove(&k);
        changed = true;
    }
    changed
}

pub(crate) fn value_object_is_empty(v: &Value) -> bool {
    v.as_object()
        .map(serde_json::Map::is_empty)
        .unwrap_or(false)
}
