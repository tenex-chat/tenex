Querying perplexity using sonar for: ai-sdk extract-reasoning-middleware implementation details and usage with maxTokens: 21000
The **extractReasoningMiddleware** is a middleware function from the AI SDK that extracts reasoning content embedded in XML-style tags from an AI model's generated text and separates it from the final output text. It is designed to capture the model's internal reasoning (e.g., thinking steps) that is enclosed within specific XML tags like `<reasoning>` or `<think>`, exposing this content as a separate property on the result.

### Key Implementation Details:

- **Import:**

```ts
import { extractReasoningMiddleware } from 'ai';
```

- **Usage:**

Create middleware by specifying the XML tag name to extract reasoning from and optional parameters:

```ts
const middleware = extractReasoningMiddleware({
  tagName: 'reasoning',      // the XML tag to extract, e.g., <reasoning>...</reasoning>
  separator: '\n',           // string to separate reasoning and main text in the final output (optional, default '\n')
  startWithReasoning: false, // if true, assumes reasoning starts the output without initial tag (optional)
});
```

- **Functionality:**

  - Works with both streaming and non-streaming model responses.
  - Extracts content between specified XML tags.
  - Removes the reasoning tags and content from the main text.
  - Adds a `reasoning` property to the result object containing the extracted reasoning text.
  - Ensures proper separation between reasoning and main output text using the provided separator.

- **Typical Integration:**

You wrap a language model with this middleware and then call generation functions as usual, accessing both the normal text and the extracted reasoning:

```ts
import { groq } from '@ai-sdk/groq';
import { generateText, wrapLanguageModel, extractReasoningMiddleware } from 'ai';

const enhancedModel = wrapLanguageModel({
  model: groq('deepseek-r1-distill-llama-70b'),
  middleware: extractReasoningMiddleware({ tagName: 'think' }),
});

const { reasoning, text } = await generateText({
  model: enhancedModel,
  prompt: 'Explain quantum entanglement.',
});
```

Here, everything inside `<think>...</think>` is extracted as `reasoning`, and the remaining text is in `text`[1][3][6].

### Usage Recommendations:

- When using models like DeepSeek R1 from various providers, it’s common to set `startWithReasoning: true` because some models start output immediately with reasoning without tagging it explicitly[3].

- The middleware is compatible with multiple providers (Fireworks, Azure, Groq, Together AI, etc.) and useful when you want to analyze or display the model's reasoning separately from the final generated text[3][5][6].

### Summary of Parameters

| Parameter         | Type    | Description                                                      | Default   |
|-------------------|---------|------------------------------------------------------------------|-----------|
| `tagName`         | string  | XML tag name to extract reasoning from (without <>)             | none      |
| `separator`       | string? | Separator between reasoning and main text in output              | `"\n"`    |
| `startWithReasoning` | boolean?| Whether response starts directly with reasoning without a tag   | `false`   |

### What the Middleware Returns

An object with:

- The cleaned **text** (original output minus reasoning sections)
- A separate **reasoning** string containing the extracted content between the tags

This allows seamless integration in apps that want to show or log the model's thought process distinctly from its answer[1][3][6].

---

This explanation is synthesized primarily from the official AI SDK documentation and usage guides from the AI SDK website and related provider docs[1][3][6].