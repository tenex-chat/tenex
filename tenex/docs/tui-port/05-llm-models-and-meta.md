# 05 — LLM Models and Meta-Model Configuration

Pixel-exact port spec for the LLM model selection and meta-model subsystem of the TENEX CLI/TUI.

Scope: choosing a model for a configuration, default-model, meta-models with variants (keywords + system prompts), models.dev cache. Out of scope: providers (covered in 03), API keys (04), live testing (06).

---

## 1. Configuration concept

### 1.1 "Named LLM configuration"

A **named LLM configuration** is a user-defined entry in `llms.json` keyed by a free-form string name (e.g. `anthropic/Claude Sonnet 4.6`). The map of all configurations is `TenexLLMs.configurations: Record<string, AnyLLMConfiguration>` (`src/services/config/types.ts:336-344`).

Every configuration is one of two shapes:

1. **Standard `LLMConfiguration`** — a real provider+model pair. (`src/services/config/types.ts:292-319`).
2. **`MetaModelConfiguration`** — a virtual configuration that resolves at runtime to one of several underlying named standard configurations based on keyword matches. (`src/services/config/types.ts:280-287`).

A meta model is identified by `provider === "meta"` and the presence of a `variants` field. The discriminator is implemented by `isMetaModelConfiguration(config)` (`src/services/config/types.ts:324-326`).

### 1.2 Default vs. named

`TenexLLMs.default?: string` (`src/services/config/types.ts:338`) names which configuration is treated as the system-wide default. `default` is optional. When `getLLMConfig(undefined)` or `getLLMConfig("default")` is requested, `resolveConfigName` returns `llms.default` if set, else falls back to the first available configuration (`src/services/ConfigService.ts:343-356`).

Auxiliary role pointers — `summarization`, `supervision`, `promptCompilation`, `categorization`, `contextDiscovery` — are also names referencing entries in `configurations` (`src/services/config/types.ts:339-343`).

### 1.3 `llms.json` example

```json
{
  "configurations": {
    "anthropic/Claude Sonnet 4.6": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6-20250101"
    },
    "openai/GPT-5": {
      "provider": "openai",
      "model": "gpt-5",
      "temperature": 0.2,
      "maxTokens": 8000
    },
    "codex-fast": {
      "provider": "codex",
      "model": "gpt-5.1-codex-max",
      "effort": "low"
    },
    "smart-router": {
      "provider": "meta",
      "default": "fast",
      "variants": {
        "fast":   { "model": "openai/GPT-5",                  "keywords": ["quick"],      "description": "Fast, cheap responses" },
        "smart":  { "model": "anthropic/Claude Sonnet 4.6",   "keywords": ["think"],      "description": "Default for hard problems" },
        "deep":   { "model": "anthropic/Claude Sonnet 4.6",   "keywords": ["ultrathink"], "description": "Maximum reasoning",
                    "systemPrompt": "Reason step by step before answering." }
      }
    }
  },
  "default": "anthropic/Claude Sonnet 4.6",
  "summarization": "openai/GPT-5",
  "supervision": "anthropic/Claude Sonnet 4.6",
  "promptCompilation": "anthropic/Claude Sonnet 4.6",
  "categorization": "openai/GPT-5",
  "contextDiscovery": "openai/GPT-5"
}
```

The schema is `TenexLLMsSchema` (`src/services/config/types.ts:396-404`) which validates this exact shape; standard configs use `StandardLLMConfigurationSchema` (`src/services/config/types.ts:368-386`) with `.passthrough()` allowing extra provider-specific keys.

---

## 2. Model picker

The picker behavior depends entirely on the selected provider. Dispatch happens in `addConfiguration` (`src/llm/utils/ConfigurationManager.ts:48-78`).

### 2.1 Sources by provider

| Provider | Source | Function | File |
|----------|--------|----------|------|
| `openrouter` | Live HTTPS GET `https://openrouter.ai/api/v1/models` | `fetchOpenRouterModels()` | `src/llm/providers/openrouter-models.ts:26-65` |
| `ollama` | Live HTTP GET `{baseUrl}/api/tags` (default `http://localhost:11434`) | `fetchOllamaModels(baseUrl?)` | `src/llm/providers/ollama-models.ts:18-78` |
| `codex` | Library call `listModels()` from `ai-sdk-provider-codex-cli` | `listCodexModels()` | `src/llm/utils/codex-models.ts:27-36` |
| `anthropic`, `openai`, any other | models.dev disk cache (`getProviderModels`) | `selectModelsDevModel()` | `src/llm/utils/ModelSelector.ts:179-245` |
| `claude-code` | Hardcoded list of 3 entries (sonnet, opus, haiku) | `CLAUDE_CODE_MODELS` | `src/llm/utils/claude-code-models.ts:17-33` |

> **Note:** `claude-code` does not appear in `addConfiguration`'s dispatch — the constant exists but is not wired into the model-add UI. Treat the picker dispatch list as authoritative (`src/llm/utils/ConfigurationManager.ts:53-78`).

### 2.2 OpenRouter ordering and filtering

`fetchOpenRouterModels` sorts results: a hardcoded priority list is matched first, then alphabetical by `name` (`src/llm/providers/openrouter-models.ts:42-60`). Priority order:

```
openai/gpt-4
openai/gpt-4-turbo
anthropic/claude-3-5-sonnet
anthropic/claude-3-opus
google/gemini-2.0-flash
google/gemini-pro
```

Each choice rendered as: `<id><FREE tag if id ends ":free"> - <ctx in 'k'> ctx, $<prompt>/$<completion>/1M` (`src/llm/utils/ModelSelector.ts:71-81`). A trailing literal entry `→ Type model ID manually` (cyan) appended (`src/llm/utils/ModelSelector.ts:83`). Search-mode fuzzy filter is `c.value.toLowerCase().includes(term.toLowerCase())` (`src/llm/utils/ModelSelector.ts:90-98`).

If the API returned 0 models, a fallback secondary prompt offers `Quick select from popular models` (using `getPopularModels()` — a hardcoded categorized map at `src/llm/providers/openrouter-models.ts:70-102`) or `Type model ID manually` (`src/llm/utils/ModelSelector.ts:121-172`).

### 2.3 Ollama ordering and filtering

`fetchOllamaModels` returns models in the order Ollama's `/api/tags` returns them (no sorting in code; see `src/llm/providers/ollama-models.ts:65-71`). Each choice rendered: `<name> (<size>)` where size is human-formatted (GB/MB) (`src/llm/utils/ModelSelector.ts:30-34`; format at `src/llm/providers/ollama-models.ts:83-93`). Status flow:

- `unreachable` → print `⚠️  Could not reach Ollama. Is Ollama running?` (amber) and throw `OllamaNotRunningError` (`src/llm/utils/ModelSelector.ts:17-20`). Caller catches and re-runs picker (`src/llm/utils/ConfigurationManager.ts:60-65`).
- `not_found` (404) → print `⚠️  Ollama is running but model listing is unavailable (404).` and prompt manual model entry (`src/llm/utils/ModelSelector.ts:22-25`).
- `ok` → list models.

Fuzzy filter: case-insensitive substring on `c.value` (`src/llm/utils/ModelSelector.ts:42-45`).

### 2.4 models.dev picker (Anthropic/OpenAI/etc.)

`selectModelsDevModel` calls `ensureCacheLoaded()` and reads `getProviderModels(provider)` (`src/llm/utils/ModelSelector.ts:182-184`).

`getProviderModels` (`src/llm/utils/models-dev-cache.ts:319-337`):
- Maps our provider id via `PROVIDER_MAPPING` (`src/llm/utils/models-dev-cache.ts:73-80`): `anthropic→anthropic`, `openai→openai`, `openrouter→openrouter`, `ollama→null`, `codex→null` (null = no models.dev data).
- Returns all `cache[mappedProvider].models` entries as `ModelsDevModel[]`.
- **Sorted by `last_updated` descending** (string comparison, missing values treated as empty string).

Each choice rendered: `<name> (<id>) - <ctx>k ctx, $<input>/$<output>/M` (only present fields; built at `src/llm/utils/ModelSelector.ts:188-203`). A trailing `→ Type model ID manually` entry is appended (`src/llm/utils/ModelSelector.ts:204`).

Search filter: matches `value` or `humanName` (case-insensitive substring); the manual entry is always shown (`src/llm/utils/ModelSelector.ts:212-221`).

The picker returns `{ id, name }` so that `addConfiguration` can use the human name (`m.name`) as the default config-name suggestion.

### 2.5 Codex picker

`selectCodexModel` (`src/llm/utils/ConfigurationManager.ts:209-258`):
- Calls `listCodexModels()`. Each option has `{ id, displayName, description, isDefault }`.
- If list empty → falls back to `gpt-5.1-codex-max`.
- Renders each as `<id>[ (default)] <description>` (dim) (`src/llm/utils/ConfigurationManager.ts:226-232`).
- **Second prompt**: select effort. Choices (`src/llm/utils/ConfigurationManager.ts:242-248`):
  - `Use model default` → `undefined`
  - `low`
  - `medium`
  - `high`
  - `xhigh`
- Result `{ model, effort? }` is stored as `LLMConfiguration.model` and `LLMConfiguration.effort`.

### 2.6 Defaults per provider

`getDefaultModelForProvider` returns the seed value passed to `selectModelsDevModel`'s `default` (`src/llm/utils/ConfigurationManager.ts:260-270`):

```
openrouter   → "openai/gpt-4"
anthropic    → "claude-3-5-sonnet-latest"
openai       → "gpt-4"
ollama       → "deepseek-v4-flash:cloud"
codex        → "gpt-5.1-codex-max"
claude-code  → ""
```

### 2.7 Manual model entry

`promptManualModel(defaultValue)` (`src/llm/utils/ModelSelector.ts:250-265`) — single text input with the default seeded; non-empty validation: `"Model name is required"`.

---

## 3. Context window display

### 3.1 Where shown

| Location | Format | File:Line |
|----------|--------|-----------|
| OpenRouter picker rows | `<round(context_length/1000)>k ctx` | `src/llm/utils/ModelSelector.ts:73-77` |
| models.dev picker rows | `<round(limit.context/1000)>k ctx` | `src/llm/utils/ModelSelector.ts:189-194` |
| `tenex config roles` config-choice rows | `<round(info.limit.context/1000)>K ctx` (note **uppercase K**) | `src/commands/config/roles.ts:131-133` |

### 3.2 Source

Three reading paths, all backed by the disk-cached `models.dev` data:

- `getContextWindow(provider, model)` — thin re-export (`src/llm/utils/context-window-cache.ts:12-14`).
- `getContextWindowFromModelsdev(provider, model)` — calls `getModelLimits` (`src/llm/utils/models-dev-cache.ts:311-314`).
- `getModelInfo(provider, model)` — full `{ id, name, cost, limit, last_updated }` (`src/llm/utils/models-dev-cache.ts:294-306`).

All three call `resolveModelData(provider, model)` which has a 3-step lookup (`src/llm/utils/models-dev-cache.ts:240-271`):

1. **Direct**: `cache[mappedProvider].models[model]`. `mappedProvider` from `PROVIDER_MAPPING`.
2. **Vendor split**: if `model` contains `/`, split on first `/` → `cache[vendor].models[bare]`.
3. **Global scan**: linear search across all providers in cache for any with `.models[model]`.

If all three fail → `undefined`. Limits are returned only if both `context` and `output` are defined (`src/llm/utils/models-dev-cache.ts:280-288`).

For OpenRouter, the picker also reads the API's own `model.context_length` field directly — independent of models.dev (`src/llm/utils/ModelSelector.ts:73`).

---

## 4. Meta-model UI

Entry: from main LLM menu, action `Add multi-modal configuration (m)` (key `m`) (`src/llm/LLMConfigEditor.ts:211`). Calls `addMultiModalConfiguration` (`src/llm/utils/ConfigurationManager.ts:159-204`).

### 4.1 Pre-flight

Counts standard (non-meta) configurations: `cfg.provider !== "meta"` (`src/llm/utils/ConfigurationManager.ts:160-163`). If fewer than 2, prints two display calls and returns:

- `display.hint("You need at least 2 standard LLM configurations to create a multi-modal configuration.")`
- `display.context("Create more configurations first with 'Add new configuration'.")`

### 4.2 Header (exact text)

Printed before any prompt (`src/llm/utils/ConfigurationManager.ts:171-177`):

- `display.blank()`
- `display.step(0, 0, "Add Multi-Modal Configuration")`
- `display.context("Multi-modal configurations let you switch between different models using keywords.\nFor example, starting a message with 'ultrathink' can trigger a more powerful model.")`
- `display.blank()`

### 4.3 Name prompt

`inquirer.input` named `metaName` (`src/llm/utils/ConfigurationManager.ts:179-191`). Validation:
- Empty/whitespace → `"Name is required"`
- Already exists in `llmsConfig.configurations` → `"Configuration already exists"`

### 4.4 Variant list prompt (custom)

`variantListPrompt(configName, standardConfigs)` (`src/llm/utils/variant-list-prompt.ts:316-362`). The prompt **forces** an initial `addVariant` call before showing the list (`src/llm/utils/variant-list-prompt.ts:323-327`).

Loop: render `variantListRawPrompt`, dispatch to add/edit/done.

#### 4.4.1 Render layout (`src/llm/utils/variant-list-prompt.ts:114-156`)

```
<prefix> <configName>           // theme.style.message; prefix is amber "?"
<blank>
  Variants:                      // chalk.dim
<cursor> <name> [<model>]<(default) tag if applicable>
   ...
  ────────────────────────────────────────────  // 40 dashes
<cursor> Add variant             // cyan
<cursor> Done                    // amber bold "  Done"  OR  dim "Done (need at least 2 variants)" if <2
  ↑↓ navigate • ⏎ edit • d set default • ⌫ remove   // dim with bold key labels
```

Cursor: `chalk.hex("#FFC107")("›")` (amber `›`) (`src/llm/utils/variant-list-prompt.ts:115`). Inactive prefix is `"  "` (2 spaces).

Default tag: `chalk.dim(" (default)")` (`src/llm/utils/variant-list-prompt.ts:127`). Model display: `chalk.gray("[" + variant.model + "]")` (`src/llm/utils/variant-list-prompt.ts:128`).

#### 4.4.2 Keys (`src/llm/utils/variant-list-prompt.ts:54-112`)

| Key | Behavior |
|-----|----------|
| ↑ | `setActive(max(0, active - 1))` |
| ↓ | `setActive(min(itemCount - 1, active + 1))` |
| ⏎ on variant | done with `{ action: "edit", variantName }` |
| ⏎ on Add | done with `{ action: "add" }` |
| ⏎ on Done | done with `{ action: "done" }` if `≥2` variants; else no-op |
| `d` on variant | set as default (`setDefaultVariant(name)`) |
| Backspace or Delete on variant | delete variant if `>2` exist; if deleting current default, default reassigned to first remaining |

Note bounded navigation (does NOT wrap, unlike the LLM main menu).

#### 4.4.3 `addVariant` flow (`src/llm/utils/variant-list-prompt.ts:263-309`)

1. `inquirer.input` for variant name. Validation: required, unique within `state.variants`.
2. `inquirer.select` with title `"Select model for this variant:"` choices = each standard config name (raw, no decoration).
3. **First variant**: only name+model are collected; auto-becomes default if `state.defaultVariant` empty.
4. **Subsequent variants**: also asks `inquirer.input` `"When to use this variant:"` → stored as `description` (only set if non-empty).

Note: in `addVariant`, `keywords` and `systemPrompt` are NOT prompted at creation — they are filled later by editing the variant.

#### 4.4.4 `editVariantDetail` (`src/llm/utils/variant-list-prompt.ts:160-261`)

Loop showing variant header `Variant: <name> → <model><(default) tag>` (via `display.context`), then a select with these labels (each padded with dim current value):

| Key | Label | Field |
|-----|-------|-------|
| `model` | `Model              <variant.model>` | replaces with another standard config |
| `keywords` | `Trigger keyword    <comma-list or "(none)">` | input prompt `"Trigger keywords (comma-separated):"`; parsed by splitting on `,`, trimming, **lowercasing**, filtering empties; if empty list → set `undefined` |
| `description` | `When to use        <description or "(none)">` | input prompt `"When to use this variant:"`; if empty → `undefined` |
| `systemPrompt` | `Behavior when active  <systemPrompt or "(none)">` (with description "Extra instructions given to the agent when this variant is selected, e.g. 'Reason step by step'") | input prompt `"Behavior when active:"`; if empty → `undefined` |
| `back` | `Back` | exits loop |

Sub-prompt for `model` is `inquirer.select` titled `"Select model:"` with choices = `standardConfigs` (`src/llm/utils/variant-list-prompt.ts:208-216`).

### 4.5 "Keywords" semantics

- Stored as lowercased strings (input is lowercased on parse — `src/llm/utils/variant-list-prompt.ts:226`).
- Multiple keywords per variant allowed.
- At runtime, matched against the **start** of the user's first message (or after leading whitespace), case-insensitively. Keyword must be followed by whitespace or end-of-string. See §5 for exact algorithm.
- A variant without keywords is reachable only via override or as default.

### 4.6 Closing

After the variant list returns `{ action: "done" }`, `variantListPrompt` returns:

```
{ provider: "meta", variants, default: defaultVariant }
```

(`src/llm/utils/variant-list-prompt.ts:340-346`)

Stored under the chosen `metaName`. If `llmsConfig.default` is unset, the new meta config becomes the default (`src/llm/utils/ConfigurationManager.ts:197-199`). Final message: `display.success(`Multi-modal configuration "${metaName}" created with ${variantCount} variants`)` (`src/llm/utils/ConfigurationManager.ts:201-203`).

---

## 5. Resolution algorithm (CRITICAL)

The runtime entry point is `ConfigService.resolveMetaModel(configName?, firstMessage?, variantOverride?)` (`src/services/ConfigService.ts:497-546`). It returns `MetaModelResolutionResult` (`src/services/ConfigService.ts:30-45`).

### 5.1 Top-level pseudocode

```
resolveMetaModel(configName, firstMessage, variantOverride):
    rawConfig = getRawLLMConfig(configName)             # may throw "not found"

    if rawConfig.provider != "meta":
        return {
            config: rawConfig,
            configName: configName or "default",
            isMetaModel: false
        }

    metaConfig = rawConfig as MetaModelConfiguration

    if variantOverride is set:
        resolution = resolveToVariant(metaConfig, variantOverride)
    else:
        resolution = resolveMetaModel(metaConfig, firstMessage, { stripKeywords: true })

    resolvedConfig = getLLMConfig(resolution.configName)   # recursive: meta→meta allowed
    metaModelSystemPrompt = generateSystemPromptFragment(metaConfig)

    log.info("[ConfigService] Resolved meta model", {
        originalConfig: configName,
        resolvedVariant: resolution.variantName,
        resolvedConfig: resolution.configName,
        matchedKeywords: resolution.matchedKeywords,
        usedOverride: variantOverride is set
    })

    return {
        config: resolvedConfig,
        configName: resolution.configName,
        strippedMessage: resolution.strippedMessage,
        variantSystemPrompt: resolution.systemPrompt,
        metaModelSystemPrompt,
        isMetaModel: true,
        variantName: resolution.variantName
    }
```

`getRawLLMConfig` resolves the name without fallback (`src/services/ConfigService.ts:429-440`); `getLLMConfig` recursively resolves meta to default variant when called with a meta config name (`src/services/ConfigService.ts:398-422`).

### 5.2 `resolveToVariant` (override path)

`src/llm/meta/MetaModelResolver.ts:267-290`

```
resolveToVariant(config, variantName):
    variant = config.variants[variantName]
    if not variant:
        throw "Meta model variant \"<name>\" not found. Available variants: <list>"
    return {
        variantName,
        variant,
        configName: variant.model,
        matchedKeywords: [],
        systemPrompt: variant.systemPrompt   # may be undefined
    }
```

Override is used when `change_model` or `self_delegate` provides an explicit variant name.

### 5.3 `resolve` (keyword path)

`src/llm/meta/MetaModelResolver.ts:173-256`

```
resolve(config, message, options = { stripKeywords: true }):
    keywordMap = buildKeywordMap(config)

    # No-message branch → default variant
    if message is empty/undefined:
        defaultVariant = config.variants[config.default]
        if not defaultVariant:
            throw "Meta model default variant \"<config.default>\" not found in variants"
        return { variantName: config.default, variant: defaultVariant,
                 configName: defaultVariant.model, matchedKeywords: [],
                 systemPrompt: defaultVariant.systemPrompt }

    matches = findMatchingKeywords(message, keywordMap)

    # No keyword hit → default variant (same shape as above)
    if matches is empty: <same default branch>

    winner = selectWinningVariant(matches)    # earliest position; null if matches empty

    matchedKeywords = matches.map(m => m.keyword)
    strippedMessage = stripKeywords ? stripKeywordsFromMessage(message, matchedKeywords) : message

    log.debug("[MetaModelResolver] Resolved variant", {
        variantName: winner.variantName,
        matchedKeywords,
        configName: winner.variant.model
    })

    return {
        variantName: winner.variantName,
        variant: winner.variant,
        configName: winner.variant.model,
        strippedMessage,
        matchedKeywords,
        systemPrompt: winner.variant.systemPrompt
    }
```

### 5.4 `buildKeywordMap`

`src/llm/meta/MetaModelResolver.ts:49-64`

```
buildKeywordMap(config):
    map = {}
    for (variantName, variant) in config.variants:
        if variant.keywords is set:
            for keyword in variant.keywords:
                map[keyword.toLowerCase()] = { variantName, variant }
    return map
```

If two variants share a keyword, the **later one wins** (Map.set overwrites).

### 5.5 `findMatchingKeywords`

`src/llm/meta/MetaModelResolver.ts:70-129`

```
findMatchingKeywords(message, keywordMap):
    matches = []
    keywords = keywordMap.keys() sorted by length DESCENDING   # longest first
    messageLower = message.toLowerCase()

    for each keyword:
        # Branch A: at position 0
        if messageLower.startsWith(keyword):
            after = message.charAt(keyword.length)         # may be "" (EOS)
            if after == "" or /\s/.test(after):
                push { keyword, variantName, variant, position: 0 }

        # Branch B: at position after leading whitespace
        leading = messageLower.match(/^\s+/)
        if leading:
            offset = leading[0].length
            restLower = messageLower.substring(offset)
            if restLower.startsWith(keyword):
                after = message.charAt(offset + keyword.length)
                if after == "" or /\s/.test(after):
                    if no existing match has the same keyword:
                        push { keyword, variantName, variant, position: offset }

    return matches
```

Subtleties (port exactly):

- Keywords are tested in length-DESC order.
- Both branches A and B can fire for the same keyword if `position 0` and `offset` are both candidates — but Branch B suppresses duplicates via the `!matches.some(m => m.keyword === keyword)` check, so a given keyword appears at most once.
- "Followed by" check uses `\s` (any whitespace) or end-of-string. A keyword followed by a non-space character (e.g. `"thinkfast"`) does NOT match.

### 5.6 `selectWinningVariant`

`src/llm/meta/MetaModelResolver.ts:135-144`

```
selectWinningVariant(matches):
    if matches.length == 0: return null
    sorted = copy(matches).sort((a,b) => a.position - b.position)
    return sorted[0]
```

Tie-break note: `Array.sort` is stable in modern engines (V8 since 7.0); ties between `position 0` and `position offset` (Branch A always wins) and between two same-position matches keep the first push order, which is the keyword length-DESC order. Port must preserve "earliest position; on tie, longest keyword first; on further tie, first inserted in the variants map".

### 5.7 `stripKeywordsFromMessage`

`src/llm/meta/MetaModelResolver.ts:150-163`

```
stripKeywordsFromMessage(message, matchedKeywords):
    result = message
    for each keyword in matchedKeywords:
        regex = /^\s*<escapeRegExp(keyword)>\s*/i
        result = result.replace(regex, "")
    return result.trim()
```

`escapeRegExp` escapes `.*+?^${}()|[]\` (`src/llm/meta/MetaModelResolver.ts:331-333`).

Loop order is the order of `matchedKeywords` (i.e. the order they were pushed into `matches`, which is keyword length-DESC). Practical effect: the longest matching keyword (always at the start after trimming) is stripped first.

### 5.8 `generateSystemPromptFragment`

`src/llm/meta/MetaModelResolver.ts:299-315`

Pseudocode and **exact strings**:

```
generateSystemPromptFragment(config):
    lines = []
    lines.push("You have access to the following models. Use change_model() to switch within this conversation, or self_delegate() to start a fresh self-delegated run on a specific model:")
    for (variantName, variant) in config.variants:
        description = variant.description or `Model variant "<variantName>"`
        keywords = variant.keywords?.length
            ? " (trigger: " + variant.keywords.join(", ") + ")"
            : ""
        lines.push("* " + variantName + keywords + " → " + description)
    return lines.join("\n")
```

Iteration order is `Object.entries` — insertion order of the `variants` map (string keys preserve insertion order in JS).

Concrete output for the example `smart-router` above:

```
You have access to the following models. Use change_model() to switch within this conversation, or self_delegate() to start a fresh self-delegated run on a specific model:
* fast (trigger: quick) → Fast, cheap responses
* smart (trigger: think) → Default for hard problems
* deep (trigger: ultrathink) → Maximum reasoning
```

### 5.9 `isMetaModel` type guard

`src/llm/meta/MetaModelResolver.ts:320-326` — checks `provider === "meta" && typeof variants === "object" && typeof default === "string"`. Note this is a separate guard from `isMetaModelConfiguration` (`src/services/config/types.ts:324-326`) which checks `provider === "meta" && "variants" in config`.

---

## 6. Defaults

### 6.1 How the default is chosen at write time

In `addConfiguration`, after a new config is saved (`src/llm/utils/ConfigurationManager.ts:147-153`):

```
if !llmsConfig.default OR Object.keys(configurations).length == 1:
    llmsConfig.default = name
    success("Configuration \"<name>\" created and set as default")
else:
    success("Configuration \"<name>\" created")
```

In `addMultiModalConfiguration`: only sets default if no default exists (`src/llm/utils/ConfigurationManager.ts:197-199`); does NOT override existing default.

When deleting a config (`src/llm/LLMConfigEditor.ts:237-250`):

```
delete llmsConfig.configurations[configName]
if llmsConfig.default == configName:
    remaining = Object.keys(llmsConfig.configurations)
    llmsConfig.default = remaining[0]   # may be undefined
    if llmsConfig.default:
        hint('Default changed to "<new>"')
success('Configuration "<name>" deleted')
```

### 6.2 No-default behavior at read time

`resolveConfigName` (`src/services/ConfigService.ts:330-391`):

```
resolveConfigName(configName, { allowFallback, warnOnFallback }):
    if loadedConfig is unset: throw "Config not loaded. Call loadConfig() first."

    available = Object.keys(llms.configurations)
    name = configName

    # 1) Default request
    if name is undefined or name == "default":
        name = llms.default
        if not name:
            if available.length > 0:
                name = available[0]
                if warnOnFallback:
                    warn `No default LLM configured, using first available: <name>`
                return { name }
            throw "No LLM configurations available"

    # 2) Direct hit
    if llms.configurations[name] exists: return { name }

    # 3) Not found
    if not allowFallback: throw 'LLM configuration "<name>" not found'

    # 4) Fallback to default
    if llms.default and llms.configurations[llms.default]:
        warn (if warnOnFallback) `LLM configuration "<name>" not found, falling back to default: <default>`
        return { name: default }

    # 5) Fallback to first available
    if available.length > 0:
        warn (if warnOnFallback) `LLM configuration "<name>" not found, using first available: <first>`
        return { name: first }

    # 6) Total failure
    throw 'No valid LLM configuration found. Requested: "<configName or default>". Available: <list or "none">'
```

`getLLMConfig` calls `resolveConfigName` with `{ allowFallback: true, warnOnFallback: true }` (`src/services/ConfigService.ts:399-402`); `getRawLLMConfig` uses `{ allowFallback: false, warnOnFallback: false }` (`src/services/ConfigService.ts:430-433`).

### 6.3 Auto-select for roles

Triggered by `tenex config roles`. `autoSelectRoles` (`src/commands/config/roles.ts:34-83`) inspects models.dev metadata for each non-meta config and assigns:

- `summarization` ← cheapest with `contextWindow >= 100,000`.
- `supervision` ← most expensive overall (any context).
- `promptCompilation` ← most expensive with `contextWindow >= 100,000`.
- `contextDiscovery` ← cheapest with `contextWindow >= 32,000`, fallback to `>= 8,000`.

If `llms.default` is unset before role assignment, the per-role pre-fill uses `configNames[0]` (`src/commands/config/roles.ts:109`). When only one config exists, all roles are skipped — `llmsConfig.default = configNames[0]` and message `All roles assigned to "<name>"` (`src/commands/config/roles.ts:99-105`).

`getContextDiscoveryLLMConfigName()` (`src/services/ConfigService.ts:629`) chains: `contextDiscovery → categorization → summarization → default`.

---

## 7. Validation

### 7.1 Model name validation

The only validation is non-empty input on the manual entry prompt: `"Model name is required"` (`src/llm/utils/ModelSelector.ts:257-260`). No format checks; no provider-specific normalization. Configs from picker rows pass the model id verbatim.

### 7.2 Configuration name validation

Both `addConfiguration` and `addMultiModalConfiguration` (`src/llm/utils/ConfigurationManager.ts:126-130`, `src/llm/utils/ConfigurationManager.ts:184-188`):

- `!input.trim()` → `"Name is required"`
- `llmsConfig.configurations[input]` exists → `"Configuration already exists"`

### 7.3 `validateProviderReferences`

`src/services/ConfigService.ts:892-909`. Called during `loadConfig` (`src/services/ConfigService.ts:204`) and after provider saves (`src/services/ConfigService.ts:875`).

```
validateProviderReferences(llms, providers):
    missing = Set()
    for cfg in llms.configurations.values:
        if cfg.provider == "meta": continue
        if not providers.providers[cfg.provider]:
            missing.add(cfg.provider)
    if missing.size > 0:
        warn "LLM configurations reference providers not in providers.json: <comma-list>"
```

This is **non-fatal** — only `logger.warn`; configurations remain loaded. Meta entries are skipped.

### 7.4 Schema validation

`TenexLLMsSchema.parse(data)` is invoked in `loadConfigFile` (`src/services/ConfigService.ts:929-934`). `LLMConfigurationSchema` is a union of `MetaModelConfigurationSchema` (strict literal `"meta"` provider) and `StandardLLMConfigurationSchema` (`.passthrough()`, `src/services/config/types.ts:368-394`). Errors propagate; the file is not silently dropped.

### 7.5 Temperature and maxTokens (advanced flag only)

When `--advanced` (`src/llm/utils/ConfigurationManager.ts:84-115`):

- `temperature` input: empty allowed; otherwise `Number.parseFloat`, range `[0, 2]`. Error: `"Temperature must be between 0 and 2"`.
- `maxTokens` input: empty allowed; otherwise `Number.parseInt`, must be `> 0`. Error: `"Max tokens must be a positive number"`.

---

## 8. Persistence

### 8.1 File location

`llms.json` lives at `{getGlobalPath()}/llms.json`. `getGlobalPath()` returns `getTenexBasePath()` — `~/.tenex` by default, overridable via env (`src/services/ConfigService.ts:96-103`). LLM configuration is **global only** — no project-level `llms.json` (`src/services/ConfigService.ts:200`, `src/commands/config/llm.ts:17-18`).

### 8.2 Loading

`loadTenexLLMs(basePath)` reads `<basePath>/llms.json`, validates with `TenexLLMsSchema`, defaults to `{ configurations: {}, default: undefined }` if absent (`src/services/ConfigService.ts:240-245`).

### 8.3 Saving

`LLMConfigEditor.saveConfig` (`src/llm/LLMConfigEditor.ts:264-270`):

```
saveConfig(llmsConfig):
    { providers, ...llmsWithoutProviders } = llmsConfig
    config.saveGlobalProviders({ providers })          # writes providers.json
    config.saveGlobalLLMs(llmsWithoutProviders)        # writes llms.json
    llmServiceFactory.initializeProviders(providers)   # re-init runtime providers
```

`saveGlobalLLMs(llms)` (`src/services/ConfigService.ts:728-...`) writes via `saveTenexLLMs(globalPath, llms)` (`src/services/ConfigService.ts:283-289`), which goes through `saveConfigFile` (Zod-validated write).

### 8.4 Schema reference (TenexLLMsSchema)

`src/services/config/types.ts:396-404`

```
{
  configurations: Record<string, AnyLLMConfiguration>   # default {}
  default?: string
  summarization?: string
  supervision?: string
  promptCompilation?: string
  categorization?: string
  contextDiscovery?: string
}
```

`LLMConfigurationSchema = z.union([MetaModelConfigurationSchema, StandardLLMConfigurationSchema])` (`src/services/config/types.ts:391-394`).

Standard config recognized fields (`src/services/config/types.ts:292-319`, `:368-386`): `provider`, `model`, `temperature`, `maxTokens`, `topP`, `effort`, `summary`, `personality`, `approvalPolicy`, `sandboxPolicy`, `developerInstructions`, `baseInstructions`, `configOverrides`, `rmcpClient`, `idleTimeoutMs`. The schema is `.passthrough()` so unknown fields are preserved on save.

Meta-model fields (`src/services/config/types.ts:265-287`, `:349-363`): `provider="meta"`, `variants: Record<string, MetaModelVariant>`, `default: string`. Variant fields: `model: string`, `keywords?: string[]`, `description?: string`, `systemPrompt?: string`.

### 8.5 models.dev disk cache

Stored at `{getConfigPath("cache")}/models-dev.json` (`src/llm/utils/models-dev-cache.ts:85-87`). Subdir is the literal string `"cache"` joined under `~/.tenex` (`TenexSubdir | string` accepts arbitrary names — `src/services/ConfigService.ts:96-99`).

Format on disk:

```json
{
  "fetchedAt": 1730000000000,
  "data": { ...models.dev API response... }
}
```

Stale threshold: 24 hours (`STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000` — `src/llm/utils/models-dev-cache.ts:15`). Detected via `mtimeMs` of the file (`src/llm/utils/models-dev-cache.ts:136-143`).

#### 8.5.1 Lifecycle (`ensureCacheLoaded` — `src/llm/utils/models-dev-cache.ts:161-213`)

```
ensureCacheLoaded():
    if cacheLoadPromise is in-flight: await it; return
    if in-memory cache is loaded:
        if isCacheStale(): refreshInBackground (fire-and-forget)
        return
    cacheLoadPromise = async {
        diskCache = readJsonFile(cacheFile)
        if diskCache.data:
            cache = diskCache.data
            log.debug "models.dev cache loaded from disk"
            if isCacheStale(): refreshInBackground (fire-and-forget)
            return
        # No disk cache → blocking fetch
        log.debug "models.dev cache not found, fetching from API"
        fresh = fetchFromApi()
        if fresh:
            cache = fresh
            saveToDisk(fresh)
            log.debug "models.dev cache fetched and saved"
        else:
            log.warn "Could not load models.dev data - model limits will be unavailable"
    }
    await cacheLoadPromise; cacheLoadPromise = null
```

`fetchFromApi` GETs `https://models.dev/api.json`. Non-2xx or thrown → returns `null` and logs warning (`src/llm/utils/models-dev-cache.ts:92-107`).

`refreshInBackground` overwrites `cache` and disk on success; ignores errors (`src/llm/utils/models-dev-cache.ts:148-155`).

`refreshCache()` (forced) throws if API fails (`src/llm/utils/models-dev-cache.ts:218-227`).

#### 8.5.2 Preload trigger

The CLI command `tenex config llm` fires `ensureCacheLoaded().catch(() => {})` immediately on entry, before opening the UI, so model lists are ready (`src/commands/config/llm.ts:14-15`). The same fire-and-forget pattern is used by `tenex config roles` (`src/commands/config/roles.ts:242`).

`ConfigService.loadConfig` also awaits `ensureCacheLoaded()` after loading config files (`src/services/ConfigService.ts:222-223`).

---

## 9. Color usage

Source of truth: `src/utils/cli-theme.ts` (3-13), `src/commands/config/display.ts` (4-12).

| Token | Definition | File:Line |
|-------|------------|-----------|
| Amber accent (TS) | `chalk.hex("#FFC107")` | `src/utils/cli-theme.ts:3` |
| Amber bold | `chalk.hex("#FFC107").bold` | `src/utils/cli-theme.ts:4` |
| ACCENT (display) | `chalk.ansi256(214)` (== amber #FFC107) | `src/commands/config/display.ts:4` |
| INFO | `chalk.ansi256(117)` (sky blue) | `src/commands/config/display.ts:5` |
| SELECTED | `chalk.ansi256(114)` (bright green) | `src/commands/config/display.ts:6` |
| Inquirer prefix idle | `amber("?")` | `src/utils/cli-theme.ts:7` |
| Inquirer prefix done | `chalk.green("✓")` | `src/utils/cli-theme.ts:7` |
| Cursor (inquirer) | `amber("❯")` | `src/utils/cli-theme.ts:8` |
| Cursor (variant list, roles) | `chalk.hex("#FFC107")("›")` | `src/llm/utils/variant-list-prompt.ts:115`, `src/commands/config/roles.ts:174` |
| Highlight / answer | `amber(text)` | `src/utils/cli-theme.ts:10-11` |
| Done label | `chalk.ansi256(214).bold("  Done")` | `src/commands/config/display.ts:121-123` |

### 9.1 Specific usages in LLM screens

`LLMConfigEditor.ts`:
- Action labels (`Add new configuration (a)`, `Add multi-modal configuration (m)`): `chalk.cyan` (`:130`)
- Hint key labels: `chalk.bold(<key>)`, descriptions: `chalk.dim(<text>)` (`:164-170`)
- Config detail (right-aligned model name): `chalk.dim(detail)` (`:202-203`)
- Empty state: `chalk.dim("  No configurations yet")` (`:139`)
- Test spinner glyph: `chalk.yellow(frame)` (`:150`)
- Test result icons: `chalk.green("✓")` / `chalk.red("✗")` (`:154`)
- Test error hint: `chalk.dim(result.error)` (`:155`)
- Separator: `"─".repeat(40)` (no color) (`:136`)

`variant-list-prompt.ts`:
- Section header `Variants:`: `chalk.dim` (`:120`)
- Model bracket display: `chalk.gray("[" + model + "]")` (`:128`)
- `(default)` tag: `chalk.dim(" (default)")` (`:127`)
- `Add variant`: `chalk.cyan` (`:137`)
- `Done` (enabled): `display.doneLabel()` (amber bold, `:144`)
- `Done (need at least 2 variants)` (disabled): `chalk.dim` (`:142`)

`ModelSelector.ts`:
- Pricing/context metadata: `chalk.gray(...)` (`:31, :77, :198`)
- `[FREE]` tag for `:free` OpenRouter ids: `chalk.green(" [FREE]")` (`:74`)
- Manual entry option: `chalk.cyan("→ Type model ID manually")` (`:83, :204`)
- Search placeholder: `chalk.gray("Search models...")` wrapped in `amber(...)` (`:51, :104, :165, :227`)
- Status messages: `chalk.gray(...)` for "Fetching..."; `chalk.green` for "✓ Found N..."; `amber(...)` for warnings (`:14, :28, :69, :116-119, :164`)

`ConfigurationManager.ts`:
- Codex `(default)` tag: `chalk.dim(" (default)")` (`:227`)
- Codex description: `chalk.dim(m.description)` (`:229`)

`roles.ts`:
- Recommendation hint when active: `chalk.hex("#FFC107").dim(role.recommendation)` (`:185`)
- Recommendation hint when inactive: `chalk.ansi256(240)(role.recommendation)` (`:186`)
- Role label (active or not): `chalk.bold(label)` (`:187`)
- Currently-assigned config: `chalk.dim(assigned)` (`:187`)

`llm.ts`:
- Error: `chalk.red("❌ No providers configured.")` (`:25`)
- Action prompt arrow: `amber("→") + chalk.bold(" Run tenex config providers first")` (`:26`)
- Top-level error: `chalk.red(...)` (`:40`)

---

## 10. Key files

| Concern | Path |
|---------|------|
| LLM command entry | `src/commands/config/llm.ts` |
| Main editor | `src/llm/LLMConfigEditor.ts` |
| Add standard / meta config | `src/llm/utils/ConfigurationManager.ts` |
| Standard model picker | `src/llm/utils/ModelSelector.ts` |
| Provider display labels | `src/llm/utils/ProviderConfigUI.ts` |
| OpenRouter API | `src/llm/providers/openrouter-models.ts` |
| Ollama API | `src/llm/providers/ollama-models.ts` |
| Codex models | `src/llm/utils/codex-models.ts` |
| Claude Code models constant | `src/llm/utils/claude-code-models.ts` |
| Provider id constants | `src/llm/providers/provider-ids.ts` |
| Variant list TUI | `src/llm/utils/variant-list-prompt.ts` |
| Meta resolver | `src/llm/meta/MetaModelResolver.ts` |
| Meta module barrel | `src/llm/meta/index.ts` |
| models.dev cache | `src/llm/utils/models-dev-cache.ts` |
| Context window facade | `src/llm/utils/context-window-cache.ts` |
| Schema and types | `src/services/config/types.ts` |
| ConfigService (load/save/resolve) | `src/services/ConfigService.ts` |
| Roles screen + auto-select | `src/commands/config/roles.ts` |
| Display primitives + colors | `src/commands/config/display.ts` |
| Theme | `src/utils/cli-theme.ts` |
