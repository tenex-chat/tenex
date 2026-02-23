import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { getNDK } from "@/nostr/ndkClient";
import { Nip46SigningService } from "@/services/nip46";
import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKNip46Signer, NDKPrivateKeySigner, type NDKSigner } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const UPLOAD_TIMEOUT_MS = 60_000;
const NIP46_CONNECT_TIMEOUT_MS = 30_000; // 30 seconds for NIP-46 connection
const NIP46_SIGNING_TIMEOUT_MS = 120_000; // 2 minutes for NIP-46 remote signing

const fileReferenceSchema = z.object({
    path: z.string().describe("Absolute path to the file on disk"),
    name: z.string().describe("Filename/relative path for the agent's home directory (used in the kind:1063 name tag)"),
});

const agentsPublishSchema = z.object({
    slug: z.string().describe("The slug identifier of the agent to publish"),
    description: z.string().describe("Short one-line description of the agent definition"),
    category: z.string().describe("Category for the agent (e.g., 'developer', 'analyst', 'assistant')"),
    rich_description: z.string().describe("Comprehensive homepage-style description of what the agent definition is all about (markdown). This becomes the event content."),
    image: z
        .string()
        .url("image must be a valid URL")
        .optional()
        .describe("Optional image URL for the agent definition. Published as an 'image' tag in the kind:4199 event."),
    publish_as_user: z
        .boolean()
        .default(true)
        .describe(
            "When true (default), the kind:4199 event is signed by the project owner via NIP-46 remote signing " +
            "(the agent sends the signing request). When false, the event is signed with the TENEX backend key."
        ),
    files: z
        .array(fileReferenceSchema)
        .optional()
        .describe(
            "Optional array of files to bundle with the agent. Each file will be uploaded to Blossom, " +
            "a kind:1063 NIP-94 event created, and an e-tag added to the agent definition."
        ),
});

type AgentsPublishInput = z.infer<typeof agentsPublishSchema>;

interface BlossomConfig {
    serverUrl: string;
}

interface UploadResult {
    url: string;
    sha256: string;
    size: number;
    type?: string;
}

interface FileMetadataEvent {
    eventId: string;
    name: string;
    url: string;
    sha256: string;
}

/**
 * Get Blossom server configuration from global config
 */
async function getBlossomConfig(): Promise<BlossomConfig> {
    try {
        const tenexConfig = await config.loadTenexConfig(config.getGlobalPath());
        return {
            serverUrl: tenexConfig.blossomServerUrl || "https://blossom.primal.net",
        };
    } catch {
        return {
            serverUrl: "https://blossom.primal.net",
        };
    }
}

/**
 * Detect MIME type from file extension
 */
function detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".pdf": "application/pdf",
        ".json": "application/json",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".js": "text/javascript",
        ".ts": "text/typescript",
        ".py": "text/x-python",
        ".sh": "text/x-shellscript",
        ".rb": "text/x-ruby",
        ".pl": "text/x-perl",
    };
    return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Calculate SHA256 hash of data
 */
function calculateSHA256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Create Blossom authorization event (kind 24242)
 */
async function createBlossomAuthEvent(
    sha256Hash: string,
    description: string,
    signer: NDKSigner
): Promise<NDKEvent> {
    const event = new NDKEvent();
    event.kind = 24242;
    event.content = description;
    event.created_at = Math.floor(Date.now() / 1000);
    event.tags = [
        ["t", "upload"],
        ["x", sha256Hash],
        ["expiration", String(Math.floor(Date.now() / 1000) + 3600)], // 1 hour expiration
    ];

    await event.sign(signer);
    return event;
}

/**
 * Upload data to Blossom server
 */
async function uploadToBlossomServer(
    serverUrl: string,
    data: Buffer,
    mimeType: string,
    authEvent: NDKEvent
): Promise<UploadResult> {
    const authHeader = `Nostr ${Buffer.from(JSON.stringify(authEvent.rawEvent())).toString("base64")}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(`${serverUrl}/upload`, {
            method: "PUT",
            headers: {
                Authorization: authHeader,
                "Content-Type": mimeType,
                "Content-Length": String(data.length),
            },
            body: data,
            signal: controller.signal,
        });

        if (!response.ok) {
            let errorMessage = `Upload failed with status ${response.status}`;
            try {
                const errorData = (await response.json()) as { message?: string };
                if (errorData.message) {
                    errorMessage = `Upload failed: ${errorData.message}`;
                }
            } catch {
                // If parsing JSON fails, use the default error message
            }
            throw new Error(errorMessage);
        }

        const result = (await response.json()) as UploadResult;
        return result;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Upload timed out after ${UPLOAD_TIMEOUT_MS}ms`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Create a kind:1063 NIP-94 file metadata event
 */
async function createFileMetadataEvent(
    url: string,
    sha256: string,
    name: string,
    mimeType: string,
    size: number,
    signer: NDKSigner,
    ndk: ReturnType<typeof getNDK>
): Promise<FileMetadataEvent> {
    const event = new NDKEvent(ndk);
    event.kind = 1063;
    event.content = "";
    event.created_at = Math.floor(Date.now() / 1000);
    event.tags = [
        ["url", url],
        ["name", name],
        ["m", mimeType],
        ["x", sha256],
        ["size", String(size)],
    ];

    await event.sign(signer);
    await event.publish();

    logger.info(`Published kind:1063 file metadata event`, {
        eventId: event.id,
        name,
        url,
    });

    return {
        eventId: event.id,
        name,
        url,
        sha256,
    };
}

/**
 * Upload a file to Blossom and create the kind:1063 metadata event
 */
async function uploadFileAndCreateMetadata(
    filePath: string,
    name: string,
    signer: NDKSigner,
    ndk: ReturnType<typeof getNDK>
): Promise<FileMetadataEvent> {
    // Validate file exists
    try {
        await fs.access(filePath);
    } catch {
        throw new Error(`File not found: ${filePath}`);
    }

    // Check file size
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
            `File size ${stats.size} bytes exceeds limit of ${MAX_FILE_SIZE_BYTES} bytes`
        );
    }

    // Read file
    const data = await fs.readFile(filePath);
    const mimeType = detectMimeType(filePath);
    const sha256 = calculateSHA256(data);

    logger.info(`Uploading file to Blossom`, {
        path: filePath,
        name,
        size: data.length,
        mimeType,
    });

    // Get Blossom config and upload
    const blossomConfig = await getBlossomConfig();
    const authEvent = await createBlossomAuthEvent(sha256, `Upload ${name}`, signer);
    const uploadResult = await uploadToBlossomServer(
        blossomConfig.serverUrl,
        data,
        mimeType,
        authEvent
    );

    logger.info(`File uploaded to Blossom`, {
        name,
        url: uploadResult.url,
        sha256: uploadResult.sha256,
    });

    // Create kind:1063 event
    const metadataEvent = await createFileMetadataEvent(
        uploadResult.url,
        uploadResult.sha256,
        name,
        mimeType,
        data.length,
        signer,
        ndk
    );

    return metadataEvent;
}

/**
 * Create an NDKNip46Signer using the agent's private key as the local signer
 * and the owner's pubkey as the remote signer target.
 * Returns the signer after connecting (with timeout).
 */
async function createAgentNip46Signer(
    agentSigner: NDKPrivateKeySigner,
    ownerPubkey: string,
): Promise<NDKNip46Signer> {
    const ndk = getNDK();
    const nip46Service = Nip46SigningService.getInstance();
    const bunkerUri = nip46Service.getBunkerUri(ownerPubkey);

    if (!bunkerUri || !bunkerUri.startsWith("bunker://")) {
        throw new Error(
            `Invalid bunker URI for owner ${ownerPubkey.substring(0, 12)}: ` +
            `expected a "bunker://" URI but got "${bunkerUri || "(empty)"}"`
        );
    }

    logger.info("[agents_publish] Creating NIP-46 signer for remote signing", {
        ownerPubkey: ownerPubkey.substring(0, 12),
        bunkerUri: bunkerUri.substring(0, 60),
    });

    const signer = NDKNip46Signer.bunker(ndk, bunkerUri, agentSigner);

    signer.on("authUrl", (url: string) => {
        logger.info("[agents_publish] NIP-46 auth URL required", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            url,
        });
    });

    // Connect with timeout — cancel timer on success to avoid leaked handles
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            signer.blockUntilReady(),
            new Promise<never>((_, reject) => {
                connectTimer = setTimeout(
                    () => reject(new Error(
                        `NIP-46 connect timed out after ${NIP46_CONNECT_TIMEOUT_MS / 1000}s`
                    )),
                    NIP46_CONNECT_TIMEOUT_MS,
                );
            }),
        ]);
    } catch (error) {
        // On timeout or connection failure, close the signer to release relay subscriptions
        try { signer.stop(); } catch { /* best-effort cleanup */ }
        throw error;
    } finally {
        clearTimeout(connectTimer);
    }

    return signer;
}

/**
 * Publishes an agent definition (kind 4199) to Nostr.
 *
 * When `publish_as_user` is true, uses NIP-46 remote signing so the event
 * is signed by the project owner (the agent acts as the NIP-46 client).
 * When false, signs with the TENEX backend key.
 *
 * Optionally uploads files and references them via e-tags.
 * Returns the event ID on success.
 */
async function executeAgentsPublish(
    input: AgentsPublishInput,
    context: ToolExecutionContext,
): Promise<string> {
    const { slug, description, category, rich_description, image, publish_as_user, files } = input;

    if (!slug) {
        throw new Error("Agent slug is required");
    }

    const projectCtx = getProjectContext();
    const agent = projectCtx.getAgent(slug);

    if (!agent) {
        throw new Error(`Agent with slug "${slug}" not found in current project`);
    }

    const ndk = getNDK();

    // Backend signer is only needed when NOT publishing as user (backend signs the 4199 event).
    // File uploads are always signed by the agent's own signer when publish_as_user=true.
    const backendSigner = !publish_as_user ? await config.getBackendSigner() : undefined;

    // Choose the signer for file uploads: agent's own signer when publishing as user, backend signer otherwise
    const fileSigner: NDKSigner = publish_as_user ? context.agent.signer : backendSigner!;

    // Upload files and create kind:1063 events if provided
    const fileMetadataEvents: FileMetadataEvent[] = [];
    if (files && files.length > 0) {
        logger.info(`Uploading ${files.length} file(s) for agent "${agent.name}"`);

        for (const file of files) {
            try {
                const metadata = await uploadFileAndCreateMetadata(
                    file.path,
                    file.name,
                    fileSigner,
                    ndk
                );
                fileMetadataEvents.push(metadata);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to upload file: ${file.path}`, { error: errorMessage });
                throw new Error(`Failed to upload file "${file.name}": ${errorMessage}`);
            }
        }
    }

    // Create the agent definition event
    const agentDefinition = new NDKAgentDefinition(ndk);

    agentDefinition.title = agent.name;
    agentDefinition.role = agent.role;
    agentDefinition.description = description;
    agentDefinition.category = category;
    // Rich description goes into event content, not a tag
    agentDefinition.content = rich_description;

    if (image) {
        agentDefinition.removeTag("image");
        agentDefinition.tags.push(["image", image]);
    }

    if (agent.instructions) {
        agentDefinition.instructions = agent.instructions;
    }

    if (agent.useCriteria) {
        agentDefinition.useCriteria = agent.useCriteria;
    }

    agentDefinition.version = 1;

    agentDefinition.slug = slug;

    // Add e-tags for each file metadata event
    for (const fileMetadata of fileMetadataEvents) {
        agentDefinition.tags.push(["e", fileMetadata.eventId]);
    }

    // Determine signing strategy
    if (publish_as_user) {
        // NIP-46 remote signing: the agent sends the signing request to the owner
        const nip46Service = Nip46SigningService.getInstance();

        if (!nip46Service.isEnabled()) {
            throw new Error(
                "Cannot publish as user: NIP-46 remote signing is not enabled in the configuration. " +
                "Enable it by setting nip46.enabled=true in your TENEX config, or set publish_as_user=false " +
                "to publish with the backend signer instead."
            );
        }

        const ownerPubkey = projectCtx?.project?.pubkey;
        if (!ownerPubkey) {
            throw new Error(
                "Cannot publish as user: no project owner pubkey found. " +
                "Set publish_as_user=false to publish with the backend signer instead."
            );
        }

        // Runtime type guard: verify agent signer is NDKPrivateKeySigner (required for NIP-46 local key)
        const agentSigner: unknown = context.agent.signer;
        if (!(agentSigner instanceof NDKPrivateKeySigner)) {
            throw new Error(
                `Expected agent signer to be NDKPrivateKeySigner for NIP-46 signing, ` +
                `but got ${(agentSigner as { constructor?: { name?: string } })?.constructor?.name ?? "undefined"}. ` +
                `Agent "${slug}" may have an incompatible signer configuration.`
            );
        }

        logger.info(`Publishing agent definition as user via NIP-46`, {
            slug,
            ownerPubkey: ownerPubkey.substring(0, 12),
            agentPubkey: context.agent.pubkey.substring(0, 12),
        });

        // Create NIP-46 signer using the agent's own signer as local key
        const nip46Signer = await createAgentNip46Signer(
            context.agent.signer,
            ownerPubkey,
        );

        // Set pubkey to the owner's before signing
        agentDefinition.pubkey = ownerPubkey;

        // Sign with NIP-46 (with timeout) — cancel timer and close signer on failure
        let signingTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                agentDefinition.sign(nip46Signer, { pTags: false }),
                new Promise<never>((_, reject) => {
                    signingTimer = setTimeout(
                        () => reject(new Error(
                            `NIP-46 remote signing timed out after ${NIP46_SIGNING_TIMEOUT_MS / 1000}s`
                        )),
                        NIP46_SIGNING_TIMEOUT_MS,
                    );
                }),
            ]);
        } catch (error) {
            try { nip46Signer.stop(); } catch { /* best-effort cleanup */ }
            throw error;
        } finally {
            clearTimeout(signingTimer);
        }

        try {
            await agentDefinition.publish();
        } finally {
            // Clean up the NIP-46 signer whether publish succeeds or fails
            try { nip46Signer.stop(); } catch { /* best-effort cleanup */ }
        }

        logger.info(`Successfully published user-signed agent definition for "${agent.name}" (${slug})`, {
            eventId: agentDefinition.id,
            pubkey: ownerPubkey,
            signerType: "nip46",
            filesAttached: fileMetadataEvents.length,
        });
    } else {
        // Backend signer (original behavior)
        agentDefinition.pubkey = backendSigner!.pubkey;

        await agentDefinition.sign(backendSigner!, { pTags: false });
        await agentDefinition.publish();

        logger.info(`Successfully published backend-signed agent definition for "${agent.name}" (${slug})`, {
            eventId: agentDefinition.id,
            pubkey: backendSigner!.pubkey,
            signerType: "backend",
            filesAttached: fileMetadataEvents.length,
        });
    }

    // Sync published metadata back to local storage so the AgentDefinitionMonitor
    // can track this agent for future updates (needs definitionDTag + definitionAuthor).
    // Use the published agent's pubkey (resolved by slug), NOT context.agent.pubkey
    // which is the *calling* agent — they may differ when one agent publishes another.
    try {
        const storedAgent = await agentStorage.loadAgent(agent.pubkey);
        if (storedAgent) {
            storedAgent.eventId = agentDefinition.id;
            storedAgent.definitionDTag = agentDefinition.tagValue("d") ?? slug;
            storedAgent.definitionAuthor = agentDefinition.pubkey;
            storedAgent.definitionCreatedAt = agentDefinition.created_at;
            await agentStorage.saveAgent(storedAgent);

            logger.info("[agents_publish] Synced publish metadata to local storage", {
                slug,
                eventId: agentDefinition.id?.substring(0, 12),
                definitionDTag: storedAgent.definitionDTag,
                definitionAuthor: storedAgent.definitionAuthor?.substring(0, 12),
            });
        } else {
            logger.warn("[agents_publish] Could not find stored agent to sync publish metadata", {
                slug,
                pubkey: agent.pubkey?.substring(0, 12),
            });
        }
    } catch (error) {
        // Never block publish success due to a storage sync failure
        logger.error("[agents_publish] Failed to sync publish metadata to local storage", {
            slug,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    return agentDefinition.id;
}

/**
 * Create an AI SDK tool for publishing agent definitions
 */
export function createAgentsPublishTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Publish an agent definition (kind 4199) to Nostr. " +
            "By default, the event is signed by the project owner via NIP-46 remote signing " +
            "(the agent sends the signing request). Set publish_as_user=false to sign with the TENEX backend key instead. " +
            "Optionally include an image URL and/or an array of files to bundle with the agent. " +
            "Each file is uploaded to Blossom, a kind:1063 NIP-94 event is created, and an e-tag " +
            "is added to the agent definition referencing the file. Returns the event ID on success.",
        inputSchema: agentsPublishSchema,
        execute: async (input: AgentsPublishInput) => {
            try {
                return await executeAgentsPublish(input, context);
            } catch (error) {
                logger.error("Failed to publish agent definition", { error });
                throw new Error(
                    `Failed to publish agent definition: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
        },
    }) as AISdkTool;
}
