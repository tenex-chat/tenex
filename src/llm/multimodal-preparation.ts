import { trace } from "@opentelemetry/api";
import type { ModelMessage } from "ai";

const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const OLLAMA_VISION_MODEL_PATTERNS = [
    /(?:^|[-_:])llava(?:[-_:]|$)/i,
    /bakllava/i,
    /llama[\w.-]*vision/i,
    /minicpm[\w.-]*v/i,
    /moondream/i,
    /qwen[\w.-]*vl/i,
    /gemini[\w.-]*flash/i,
];

const OLLAMA_SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
]);

type ImageLikePart = {
    type: "image";
    image: URL | string | Uint8Array | ArrayBuffer;
    mediaType?: string;
    providerOptions?: unknown;
};

type FileLikePart = {
    type: "file";
    data: URL | string | Uint8Array | ArrayBuffer;
    filename?: string;
    mediaType: string;
    providerOptions?: unknown;
};

type TextLikePart = {
    type: "text";
    text: string;
    providerOptions?: unknown;
};

type UserContentPart = TextLikePart | ImageLikePart | FileLikePart | Record<string, unknown>;

export type MultimodalPreparationOptions = {
    provider: string;
    model: string;
    abortSignal?: AbortSignal;
};

export async function prepareMultimodalMessagesForProvider(
    messages: ModelMessage[],
    options: MultimodalPreparationOptions
): Promise<ModelMessage[]> {
    if (options.provider !== "ollama") {
        return messages;
    }

    return prepareOllamaMessages(messages, options);
}

function isOllamaVisionModel(model: string): boolean {
    return OLLAMA_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

async function prepareOllamaMessages(
    messages: ModelMessage[],
    options: MultimodalPreparationOptions
): Promise<ModelMessage[]> {
    let changed = false;
    const visionModel = isOllamaVisionModel(options.model);

    const prepared = await Promise.all(messages.map(async (message) => {
        if (message.role !== "user" || !Array.isArray(message.content)) {
            return message;
        }

        const content = await prepareOllamaUserContent(message.content as UserContentPart[], {
            ...options,
            visionModel,
        });

        if (content === message.content) {
            return message;
        }

        changed = true;
        return {
            ...message,
            content,
        } as ModelMessage;
    }));

    return changed ? prepared : messages;
}

async function prepareOllamaUserContent(
    content: UserContentPart[],
    options: MultimodalPreparationOptions & { visionModel: boolean }
): Promise<UserContentPart[]> {
    let changed = false;
    const prepared: UserContentPart[] = [];

    for (const part of content) {
        if (!isImagePart(part) && !isImageFilePart(part)) {
            prepared.push(part);
            continue;
        }

        if (!options.visionModel) {
            changed = true;
            emitMultimodalEvent("multimodal.image.unsupported_model", {
                provider: options.provider,
                model: options.model,
                source: getImageSourceKind(part),
            });
            continue;
        }

        const preparedPart = await prepareOllamaImagePart(part, options);
        if (preparedPart) {
            changed = true;
            prepared.push(preparedPart);
        } else {
            changed = true;
        }
    }

    return changed ? prepared : content;
}

async function prepareOllamaImagePart(
    part: ImageLikePart | FileLikePart,
    options: MultimodalPreparationOptions
): Promise<FileLikePart | undefined> {
    const data = getImageData(part);
    const declaredMediaType = getImageMediaType(part);

    if (data instanceof URL) {
        const fetched = await fetchImageAsBase64(data, options.abortSignal);
        if (!fetched) {
            return undefined;
        }

        return {
            type: "file",
            data: fetched.base64,
            mediaType: fetched.mediaType,
            providerOptions: part.providerOptions,
        };
    }

    const mediaType = normalizeImageMediaType(declaredMediaType);
    if (!mediaType || !OLLAMA_SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        emitMultimodalEvent("multimodal.image.skipped", {
            provider: options.provider,
            model: options.model,
            reason: "unsupported_media_type",
            mediaType: declaredMediaType ?? "unknown",
        });
        return undefined;
    }

    const base64 = imageDataToBase64(data);
    if (!base64) {
        emitMultimodalEvent("multimodal.image.skipped", {
            provider: options.provider,
            model: options.model,
            reason: "unsupported_data_type",
            mediaType,
        });
        return undefined;
    }

    return {
        type: "file",
        data: base64,
        mediaType,
        providerOptions: part.providerOptions,
    };
}

async function fetchImageAsBase64(
    url: URL,
    abortSignal?: AbortSignal
): Promise<{ base64: string; mediaType: string; byteLength: number } | undefined> {
    const { signal, dispose } = createFetchSignal(abortSignal);

    try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
            emitMultimodalEvent("multimodal.image.fetch_failed", {
                sourceUrl: url.href,
                status: response.status,
            });
            return undefined;
        }

        const contentLength = response.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
            emitMultimodalEvent("multimodal.image.skipped", {
                sourceUrl: url.href,
                reason: "image_too_large",
                bytes: Number(contentLength),
            });
            return undefined;
        }

        const mediaType = normalizeImageMediaType(response.headers.get("content-type"))
            ?? inferImageMediaTypeFromUrl(url);
        if (!mediaType || !OLLAMA_SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
            emitMultimodalEvent("multimodal.image.skipped", {
                sourceUrl: url.href,
                reason: "unsupported_media_type",
                mediaType: mediaType ?? response.headers.get("content-type") ?? "unknown",
            });
            return undefined;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
            emitMultimodalEvent("multimodal.image.skipped", {
                sourceUrl: url.href,
                reason: "image_too_large",
                bytes: bytes.byteLength,
            });
            return undefined;
        }

        emitMultimodalEvent("multimodal.image.prepared", {
            sourceUrl: url.href,
            strategy: "base64",
            mediaType,
            bytes: bytes.byteLength,
        });

        return {
            base64: bytes.toString("base64"),
            mediaType,
            byteLength: bytes.byteLength,
        };
    } catch (error) {
        if (abortSignal?.aborted) {
            throw error;
        }

        emitMultimodalEvent("multimodal.image.fetch_failed", {
            sourceUrl: url.href,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    } finally {
        dispose();
    }
}

function createFetchSignal(abortSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, IMAGE_FETCH_TIMEOUT_MS);

    const dispose = (): void => {
        clearTimeout(timeout);
    };

    if (abortSignal) {
        if (abortSignal.aborted) {
            controller.abort();
        } else {
            abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
    }

    return { signal: controller.signal, dispose };
}

function isImagePart(part: UserContentPart): part is ImageLikePart {
    return part.type === "image" && "image" in part;
}

function isImageFilePart(part: UserContentPart): part is FileLikePart {
    return part.type === "file"
        && typeof part.mediaType === "string"
        && part.mediaType.startsWith("image/")
        && "data" in part;
}

function getImageData(part: ImageLikePart | FileLikePart): URL | string | Uint8Array | ArrayBuffer {
    return part.type === "image" ? part.image : part.data;
}

function getImageMediaType(part: ImageLikePart | FileLikePart): string | undefined {
    return part.type === "image" ? part.mediaType : part.mediaType;
}

function getImageSourceKind(part: ImageLikePart | FileLikePart): string {
    const data = getImageData(part);
    if (data instanceof URL) return "url";
    if (typeof data === "string") return data.startsWith("data:") ? "data-url" : "base64";
    return "binary";
}

function imageDataToBase64(data: URL | string | Uint8Array | ArrayBuffer): string | undefined {
    if (data instanceof URL) {
        return undefined;
    }

    if (typeof data === "string") {
        return stripDataUrlPrefix(data);
    }

    if (data instanceof Uint8Array) {
        return Buffer.from(data).toString("base64");
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("base64");
    }

    return undefined;
}

function stripDataUrlPrefix(data: string): string {
    const marker = ";base64,";
    const markerIndex = data.indexOf(marker);
    if (data.startsWith("data:") && markerIndex !== -1) {
        return data.slice(markerIndex + marker.length);
    }
    return data;
}

function normalizeImageMediaType(mediaType: string | null | undefined): string | undefined {
    if (!mediaType) return undefined;
    const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
    if (normalized === "image/jpg") return "image/jpeg";
    return normalized || undefined;
}

function inferImageMediaTypeFromUrl(url: URL): string | undefined {
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".gif")) return "image/gif";
    return undefined;
}

function emitMultimodalEvent(name: string, attributes: Record<string, string | number | boolean>): void {
    trace.getActiveSpan()?.addEvent(name, attributes);
}
