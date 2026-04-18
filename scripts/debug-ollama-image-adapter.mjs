#!/usr/bin/env node

import { generateText } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { prepareMultimodalMessagesForProvider } from "../src/llm/multimodal-preparation.ts";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/api";
const IMAGE_URL =
    process.env.IMAGE_URL ??
    "https://raw.githubusercontent.com/mdn/learning-area/main/html/multimedia-and-embedding/images-in-html/dinosaur_small.jpg";
const DEFAULT_MODEL = process.env.OLLAMA_TEST_MODEL ?? "minimax-m2.7:cloud";
const RAW_ADAPTER = process.env.RAW_ADAPTER === "1";

function messageWithImage(data) {
    return [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "What is in this image? Answer in one short sentence.",
                },
                {
                    type: "file",
                    mediaType: "image/jpeg",
                    data,
                },
            ],
        },
    ];
}

function messageWithTenexImageUrl(imageUrl) {
    return [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "What is in this image? Answer in one short sentence.",
                },
                {
                    type: "image",
                    image: imageUrl,
                },
            ],
        },
    ];
}

async function listModels() {
    const response = await fetch(`${OLLAMA_BASE_URL}/tags`);
    if (!response.ok) {
        throw new Error(`GET /tags failed: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();
    return Array.isArray(json.models) ? json.models.map((model) => model.name) : [];
}

async function downloadImageBase64() {
    const response = await fetch(IMAGE_URL);
    if (!response.ok) {
        throw new Error(`Image fetch failed: ${response.status} ${await response.text()}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.toString("base64");
}

async function captureAdapterRequest({ model, messages, label }) {
    let capturedBody;
    const providerMessages = RAW_ADAPTER
        ? messages
        : await prepareMultimodalMessagesForProvider(messages, {
            provider: "ollama",
            model,
        });
    const ollama = createOllama({
        baseURL: OLLAMA_BASE_URL,
        fetch: async (url, init) => {
            capturedBody = JSON.parse(String(init?.body ?? "{}"));
            return new Response(
                JSON.stringify({
                    model,
                    created_at: new Date().toISOString(),
                    done: true,
                    done_reason: "stop",
                    message: {
                        role: "assistant",
                        content: "captured",
                    },
                    prompt_eval_count: 1,
                    eval_count: 1,
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json", "x-captured-url": String(url) },
                }
            );
        },
    });

    await generateText({
        model: ollama(model),
        messages: providerMessages,
        maxOutputTokens: 32,
    });

    const imageValue = capturedBody?.messages?.[0]?.images?.[0];
    console.log(`\n[capture:${label}]`);
    console.log(JSON.stringify(
        {
            endpointBodyShape: {
                model: capturedBody?.model,
                stream: capturedBody?.stream,
                messageCount: capturedBody?.messages?.length,
                firstMessageKeys: Object.keys(capturedBody?.messages?.[0] ?? {}),
                content: capturedBody?.messages?.[0]?.content,
                imageType: imageValue instanceof URL ? "URL-object" : typeof imageValue,
                imagePreview:
                    typeof imageValue === "string"
                        ? `${imageValue.slice(0, 80)}${imageValue.length > 80 ? "..." : ""}`
                        : String(imageValue),
                imageLength: typeof imageValue === "string" ? imageValue.length : undefined,
            },
        },
        null,
        2
    ));
}

async function liveGenerate({ model, messages, label }) {
    const ollama = createOllama({ baseURL: OLLAMA_BASE_URL });
    const providerMessages = RAW_ADAPTER
        ? messages
        : await prepareMultimodalMessagesForProvider(messages, {
            provider: "ollama",
            model,
        });

    console.log(`\n[live:${label}] model=${model}`);
    try {
        const result = await generateText({
            model: ollama(model),
            messages: providerMessages,
            maxOutputTokens: 80,
        });
        console.log(JSON.stringify(
            {
                ok: true,
                text: result.text,
                usage: result.usage,
            },
            null,
            2
        ));
    } catch (error) {
        console.log(JSON.stringify(
            {
                ok: false,
                name: error?.name,
                message: error?.message,
                statusCode: error?.statusCode,
                responseBody: error?.responseBody,
                data: error?.data,
                cause: error?.cause?.message,
            },
            null,
            2
        ));
    }
}

const models = await listModels();
const liveModel = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
const imageUrl = new URL(IMAGE_URL);
const imageBase64 = await downloadImageBase64();

console.log(JSON.stringify(
    {
        ollamaBaseUrl: OLLAMA_BASE_URL,
        requestedDefaultModel: DEFAULT_MODEL,
        installedModels: models,
        liveModel,
        imageUrl: IMAGE_URL,
        imageBase64Length: imageBase64.length,
        rawAdapterMode: RAW_ADAPTER,
    },
    null,
    2
));

await captureAdapterRequest({
    model: DEFAULT_MODEL,
    messages: messageWithTenexImageUrl(imageUrl),
    label: "tenex-image-url-part",
});
await captureAdapterRequest({
    model: DEFAULT_MODEL,
    messages: messageWithImage(imageUrl),
    label: "file-url-part",
});
await captureAdapterRequest({
    model: DEFAULT_MODEL,
    messages: messageWithImage(imageBase64),
    label: "file-base64-part",
});

if (!liveModel) {
    console.log("\nNo local Ollama models found; skipping live generateText calls.");
    process.exit(0);
}

await liveGenerate({
    model: liveModel,
    messages: messageWithTenexImageUrl(imageUrl),
    label: "tenex-image-url-part",
});
await liveGenerate({
    model: liveModel,
    messages: messageWithImage(imageUrl),
    label: "file-url-part",
});
await liveGenerate({
    model: liveModel,
    messages: messageWithImage(imageBase64),
    label: "file-base64-part",
});
