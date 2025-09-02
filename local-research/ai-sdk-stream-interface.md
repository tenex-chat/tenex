Querying perplexity using sonar for: AI SDK v5 streamText function interface fullStream property what does it return and how to use it properly with maxTokens: 21000
The **`fullStream` property** of the `streamText` function in AI SDK v5 provides an **async iterable** that emits all stream events as they arrive, including detailed chunk information in a start/delta/end pattern. This allows you to process the stream data manually in fine-grained ways beyond just accumulating the final text.

Specifically, `fullStream` yields objects for each chunk in the streaming response with types like:

- `text-start`: Signals the start of a new text block with a unique `id`.
- `text-delta`: Contains a partial update to the text with a `delta` string.
- `text-end`: Indicates the end of a text block.
- Similar event types exist for reasoning content (`reasoning-start`, `reasoning-delta`, `reasoning-end`) and raw provider data (`raw`).

This pattern replaces the older single-chunk streaming style and gives you full control to handle the stream however you want, such as for custom UI updates or advanced processing[1][3][5].

Example usage to consume and print streamed text chunks:

```js
const result = streamText({ model: 'some-model', prompt: 'Example prompt' });

for await (const chunk of result.fullStream) {
  switch (chunk.type) {
    case 'text-start':
      console.log(`Start text block: ${chunk.id}`);
      break;
    case 'text-delta':
      process.stdout.write(chunk.delta);
      break;
    case 'text-end':
      console.log(`End text block: ${chunk.id}`);
      break;
  }
}
```

**Key points on using `fullStream` properly:**

- It must be consumed asynchronously with `for await ... of`.
- Use the `type` property on each chunk to determine what kind of event it is.
- Handle `text-start` and `text-end` events to track logical grouping of text.
- Process `text-delta` chunks (or `reasoning-delta`) to append or render partial text updates.
- Optionally, use the `raw` type chunks if you enabled `includeRawChunks` to debug or extend functionality with provider-specific data.
- This gives you real-time streaming control, enabling things like live UI text updates or streaming to clients over network.

In summary, the `fullStream` property exposes the complete raw streaming protocol of `streamText` so you can implement your own stream consumption logic beyond the default assembled text or final promise resolution[1][3][5].