Querying perplexity using sonar for: AI SDK createProviderRegistry how to get model without string concatenation separate provider and model parameters with maxTokens: 21000
The AI SDK's `createProviderRegistry` API uses string IDs in the format `"providerId:modelId"` (with a `:` separator by default) to access models from different providers, and it expects a single string combining the provider and model identifiers. There is **no built-in method shown in the current official docs to provide the provider and model as separate parameters without string concatenation** when calling `languageModel` or similar methods on the registry[1][3].

### Explanation and Context

- The `createProviderRegistry` function creates a centralized registry for multiple providers, letting you access models via combined string IDs like `"anthropic:claude-3"` or `"openai:gpt-4.1"` by default[1][3].
- You can customize the separator (e.g., `"anthropic > claude-3"`) by passing a `separator` option during registry creation but this still requires the combined string form to select a model[1][3].
- Example from docs:

```ts
const registry = createProviderRegistry({ anthropic, openai });
const model = registry.languageModel('openai:gpt-4.1');  // providerId:modelId format
```

- There is no documented API method accepting separate parameters like `languageModel(providerId, modelId)` that avoids the concatenated string entirely[1][3][4].

### Workaround Suggestions

If you want to avoid manual string concatenation in your code, consider:

- Create a helper function that takes separate parameters and internally constructs the combined string:

```ts
function getModel(providerId: string, modelId: string) {
  return registry.languageModel(`${providerId}:${modelId}`); // constructs string here, centralized
}
```

- Use the custom separator if you want a more readable separator but it still requires concatenation:

```ts
const registry = createProviderRegistry({ anthropic, openai }, { separator: ' > ' });
const model = registry.languageModel(`${providerId} > ${modelId}`);
```

### Summary

- The **official AI SDK requires a single string combining provider and model with a separator** when accessing models from the provider registry.
- There is **no documented API to pass provider and model as separate parameters** to avoid string concatenation.
- You can encapsulate concatenation in utility functions for cleaner code but ultimately the call expects the combined string.

This matches the current official usage patterns documented at AI SDK's site for `createProviderRegistry` and provider/model management[1][3].