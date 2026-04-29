use anyhow::{Context, Result};
use indexmap::IndexMap;
use serde_json::Value;

/// Mirror `JSON.stringify(value, null, 2)` exactly: 2-space indent, no trailing newline.
pub(crate) fn serialize(raw: &IndexMap<String, Value>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(raw, &mut ser).context("serialize agent")?;
    Ok(buf)
}
