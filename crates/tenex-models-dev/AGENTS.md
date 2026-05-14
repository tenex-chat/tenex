# tenex-models-dev

Library crate. Pure-data types and on-disk parsing for the [models.dev](https://models.dev/api.json) catalog cache. Shared between the supervisor (which fetches and writes the cache) and the agent runtime (which reads it to derive model capabilities like vision support and context window).

The cache file layout — `<base_dir>/cache/models-dev.json` — is the contract. Two independent processes parse the same JSON; both depend on this crate to keep the schema in lockstep.

## Public API

- Types: `ModelsDevModel`, `ModelsDevResponse`, `ModelLimits`, `ModelCost`, `ModelModalities`, `ProviderModels`, `CacheData`.
- I/O: `cache_file_path(base_dir)`, `load_from_disk(base_dir)`, `parse_cache_bytes(bytes)`.
- Lookup: `resolve_model_data(cache, provider, model)` — the three-step lookup (direct map → vendor-prefix split → global scan).
- Provider mapping: `provider_mapping()`, `map_to_models_dev_provider(tenex_provider)`.
- Capability helpers: `image_support_for(cache, provider, model)`.

## Critical invariants

- **Schema is the contract.** The supervisor writes the cache; the agent reads it. New optional fields on `ModelsDevModel` default to `None` on parse so older cache files keep working without regeneration.
- **`provider_mapping` is the single authoritative list of TENEX → models.dev provider names.** Local providers (`ollama`, `codex`) map to `None`; their models reach the catalog only through the vendor-prefix-split or global-scan paths.
- **No HTTP, no clock, no env.** Pure parsing + lookup. The supervisor's fetch/stale/refresh logic stays in `tenex/src/store/models_dev.rs`.
- **Conservative defaults for capability queries.** `image_support_for` returns `false` for unknown models, missing `modalities`, and absent providers — never silently `true`.

## How to approach changes

- Adding a field: extend `ModelsDevModel` with an `Option<T>` (so older caches still parse), bump the corresponding test under `parse_tolerates_missing_*`, and add a capability helper next to `image_support_for` if downstream consumers need to derive behavior from it.
- New provider mapping: extend `provider_mapping()`; update tests in this crate AND in `tenex/src/store/models_dev.rs` (the picker / default-model side).
- Touching `resolve_model_data` lookup order: the three steps are load-bearing in this exact order. OpenRouter-style IDs (`anthropic/claude-3.5-sonnet`) rely on step 2; local providers rely on step 3.
