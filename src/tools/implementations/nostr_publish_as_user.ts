/**
 * Nostr Publish As User Tool
 *
 * Enables agents to request the project owner to sign and publish
 * arbitrary Nostr events via NIP-46 remote signing.
 *
 * The agent provides an unsigned event along with a human-readable
 * explanation of WHY the signing is being requested. The explanation
 * is transported as a `tenex_explanation` tag which the frontend
 * displays to the user, then removed before the actual signing occurs.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr/ndkClient";
import { Nip46SigningService } from "@/services/nip46";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKNip46Signer, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const NIP46_CONNECT_TIMEOUT_MS = 30_000;
const NIP46_SIGNING_TIMEOUT_MS = 120_000;

const nostrPublishAsUserSchema = z.object({
    description: z
        .string()
        .describe("A short one-liner describing what this event is"),
    explanation: z
        .string()
        .describe(
            "An explanation for the human user telling them WHY we want them to sign this event. " +
            "This context is shown to the user in the frontend before they approve signing."
        ),
    event: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .describe(
            "An unsigned Nostr event as a JSON object or JSON string. " +
            "Must include 'kind' and 'content'. Tags are optional. " +
            "The event will be re-signed by the project owner via NIP-46."
        ),
});

type NostrPublishAsUserInput = z.infer<typeof nostrPublishAsUserSchema>;

/**
 * Parse the event input into a raw event object.
 * Accepts either a JSON string or an object.
 */
function parseEventInput(
    input: string | Record<string, unknown>
): { kind: number; content: string; tags?: string[][] } {
    const raw = typeof input === "string" ? JSON.parse(input) : input;

    if (typeof raw.kind !== "number") {
        throw new Error("Event must include a numeric 'kind' field");
    }

    if (typeof raw.content !== "string") {
        throw new Error("Event must include a string 'content' field");
    }

    return {
        kind: raw.kind,
        content: raw.content,
        tags: Array.isArray(raw.tags) ? raw.tags : undefined,
    };
}

/**
 * Create an NDKNip46Signer using the agent's private key as local signer
 * and the owner's pubkey as the remote signer target.
 */
async function connectNip46Signer(
    agentSigner: NDKPrivateKeySigner,
    ownerPubkey: string,
): Promise<NDKNip46Signer> {
    const ndk = getNDK();
    const nip46Service = Nip46SigningService.getInstance();
    const bunkerUri = nip46Service.getBunkerUri(ownerPubkey);

    if (!bunkerUri?.startsWith("bunker://")) {
        throw new Error(
            `Invalid bunker URI for owner ${ownerPubkey.substring(0, 12)}: ` +
            `expected "bunker://" URI but got "${bunkerUri || "(empty)"}"`
        );
    }

    logger.info("[nostr_publish_as_user] Creating NIP-46 signer", {
        ownerPubkey: ownerPubkey.substring(0, 12),
        bunkerUri: bunkerUri.substring(0, 60),
    });

    const signer = NDKNip46Signer.bunker(ndk, bunkerUri, agentSigner);

    signer.on("authUrl", (url: string) => {
        logger.info("[nostr_publish_as_user] NIP-46 auth URL required", {
            ownerPubkey: ownerPubkey.substring(0, 12),
            url,
        });
    });

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
        try { signer.stop(); } catch { /* best-effort cleanup */ }
        throw error;
    } finally {
        clearTimeout(connectTimer);
    }

    return signer;
}

/**
 * Execute the nostr_publish_as_user tool.
 *
 * Flow:
 * 1. Parse the provided event
 * 2. Add `tenex_explanation` tag (transport for frontend context)
 * 3. Send NIP-46 signing request to the project owner
 * 4. Remove `tenex_explanation` tag before the event is actually signed
 * 5. Publish the signed event to relays
 */
async function executeNostrPublishAsUser(
    input: NostrPublishAsUserInput,
    context: ToolExecutionContext,
): Promise<string> {
    const { description, explanation, event: eventInput } = input;

    // Resolve owner pubkey
    const projectCtx = getProjectContext();
    const ownerPubkey = projectCtx?.project?.pubkey;

    if (!ownerPubkey) {
        throw new Error(
            "Cannot publish as user: no project owner pubkey found. " +
            "Ensure the project has an owner configured."
        );
    }

    // Verify NIP-46 is enabled
    const nip46Service = Nip46SigningService.getInstance();
    if (!nip46Service.isEnabled()) {
        throw new Error(
            "Cannot publish as user: NIP-46 remote signing is not enabled. " +
            "Enable it by setting nip46.enabled=true in your TENEX config."
        );
    }

    // Verify agent signer type
    const agentSigner: unknown = context.agent.signer;
    if (!(agentSigner instanceof NDKPrivateKeySigner)) {
        throw new Error(
            `Expected agent signer to be NDKPrivateKeySigner for NIP-46 signing, ` +
            `got ${(agentSigner as { constructor?: { name?: string } })?.constructor?.name ?? "undefined"}.`
        );
    }

    // Parse the event input
    const rawEvent = parseEventInput(eventInput);

    // Build the NDKEvent
    const ndk = getNDK();
    const ndkEvent = new NDKEvent(ndk);
    ndkEvent.kind = rawEvent.kind;
    ndkEvent.content = rawEvent.content;
    ndkEvent.tags = rawEvent.tags ? [...rawEvent.tags] : [];

    // Add tenex_explanation tag for frontend context
    ndkEvent.tags.push(["tenex_explanation", explanation]);

    // Set pubkey to the owner's
    ndkEvent.pubkey = ownerPubkey;

    logger.info("[nostr_publish_as_user] Requesting user signature", {
        description,
        kind: ndkEvent.kind,
        ownerPubkey: ownerPubkey.substring(0, 12),
        agentPubkey: context.agent.pubkey.substring(0, 12),
        tagCount: ndkEvent.tags.length,
    });

    // Connect NIP-46 signer
    const nip46Signer = await connectNip46Signer(
        context.agent.signer,
        ownerPubkey,
    );

    // Sign with NIP-46 (the signer sends the event to the user's bunker for approval).
    //
    // The `tenex_explanation` tag is intentionally left on the event during the
    // sign() call so it reaches the TUI/bunker as transport context. The
    // TUI is responsible for displaying the explanation to the user, stripping
    // the tag, and then producing the signature over the clean event.
    let signingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            ndkEvent.sign(nip46Signer),
            new Promise<never>((_, reject) => {
                signingTimer = setTimeout(
                    () => reject(new Error(
                        `NIP-46 signing timed out after ${NIP46_SIGNING_TIMEOUT_MS / 1000}s`
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

    // After signing, ensure the tenex_explanation tag is not in the published event.
    // The TUI/bunker should have already stripped it before signing, but we
    // defensively remove it here to guarantee it never leaks to relays.
    ndkEvent.tags = ndkEvent.tags.filter((t) => t[0] !== "tenex_explanation");

    // Publish the signed event
    try {
        await ndkEvent.publish();
    } finally {
        try { nip46Signer.stop(); } catch { /* best-effort cleanup */ }
    }

    logger.info("[nostr_publish_as_user] Event published successfully", {
        eventId: ndkEvent.id,
        kind: ndkEvent.kind,
        ownerPubkey: ownerPubkey.substring(0, 12),
        description,
    });

    return JSON.stringify({
        success: true,
        eventId: ndkEvent.id,
        kind: ndkEvent.kind,
        description,
    });
}

/**
 * Create the nostr_publish_as_user AI SDK tool
 */
export function createNostrPublishAsUserTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Request the project owner/user to sign and publish a Nostr event via NIP-46 remote signing. " +
            "Provide the unsigned event, a short description, and an explanation of WHY the user should sign it. " +
            "The explanation is shown to the user in the frontend before they approve. " +
            "Once approved, the event is signed by the user and published to relays.",

        inputSchema: nostrPublishAsUserSchema,

        execute: async (input: NostrPublishAsUserInput) => {
            try {
                return await executeNostrPublishAsUser(input, context);
            } catch (error) {
                logger.error("[nostr_publish_as_user] Failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw new Error(
                    `Failed to publish as user: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ description, event }: NostrPublishAsUserInput) => {
            try {
                const parsed = typeof event === "string" ? JSON.parse(event) : event;
                return `Requesting user to sign kind:${parsed.kind} event — ${description}`;
            } catch {
                return `Requesting user to sign event — ${description}`;
            }
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
