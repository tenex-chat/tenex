import * as crypto from "node:crypto";
import { Nip46PublishError, Nip46WorkerBridge } from "@/agents/execution/worker/nip46-bridge";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const NIP46_PUBLISH_TIMEOUT_MS = 120_000;

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
        .union([
            z.string(),
            z
                .object({
                    kind: z.number(),
                    content: z.string(),
                    tags: z.array(z.array(z.string())).optional(),
                })
                .passthrough(),
        ])
        .describe(
            "An unsigned Nostr event as a JSON object or JSON string. " +
                "Must include 'kind' (number) and 'content' (string). " +
                "Tags must be an array of string arrays. " +
                "The event will be signed by the project owner via NIP-46."
        ),
});

type NostrPublishAsUserInput = z.infer<typeof nostrPublishAsUserSchema>;

const parsedEventSchema = z.object({
    kind: z.number({ error: "Event must include a numeric 'kind' field" }),
    content: z.string({ error: "Event must include a string 'content' field" }),
    tags: z.array(z.array(z.string())).optional(),
});

function parseEventInput(
    input: string | { kind: number; content: string; tags?: string[][] }
): { kind: number; content: string; tags: string[][] } {
    let raw: unknown;

    if (typeof input === "string") {
        try {
            raw = JSON.parse(input);
        } catch (error) {
            throw new Error(
                `Invalid JSON in event field: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }
    } else {
        raw = input;
    }

    const result = parsedEventSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((i) => i.message).join("; ");
        throw new Error(`Invalid event: ${issues}`);
    }

    return {
        kind: result.data.kind,
        content: result.data.content,
        tags: result.data.tags ?? [],
    };
}

async function executeNostrPublishAsUser(
    input: NostrPublishAsUserInput,
    context: ToolExecutionContext
): Promise<string> {
    const { description, explanation, event: eventInput } = input;

    const ownerPubkey = context.projectContext.project.pubkey;
    if (!ownerPubkey || !/^[0-9a-f]{64}$/.test(ownerPubkey)) {
        throw new Error(
            "Cannot publish as user: project owner pubkey is missing or not a valid hex pubkey."
        );
    }

    const parsedEvent = parseEventInput(eventInput);
    const requestId = `nostr-publish-as-user:${context.conversationId}:${crypto.randomUUID()}`;

    logger.info("[nostr_publish_as_user] Requesting user signature via Rust NIP-46 bridge", {
        description,
        kind: parsedEvent.kind,
        ownerPubkey: shortenPubkey(ownerPubkey),
        agentPubkey: shortenPubkey(context.agent.pubkey),
        tagCount: parsedEvent.tags.length,
        requestId,
    });

    try {
        const eventId = await Nip46WorkerBridge.current().requestPublish({
            correlationId: `nostr_publish_as_user:${context.conversationId}`,
            projectId: context.projectContext.project.dTag ?? "nostr-publish-as-user",
            agentPubkey: context.agent.pubkey,
            conversationId: context.conversationId,
            ralNumber: context.ralNumber,
            requestId,
            ownerPubkey,
            waitForRelayOk: true,
            timeoutMs: NIP46_PUBLISH_TIMEOUT_MS,
            unsignedEvent: {
                kind: parsedEvent.kind,
                content: parsedEvent.content,
                tags: parsedEvent.tags,
            },
            tenexExplanation: explanation,
        });

        logger.info("[nostr_publish_as_user] User signed and event accepted for publish", {
            eventId,
            kind: parsedEvent.kind,
            ownerPubkey: shortenPubkey(ownerPubkey),
            description,
        });

        return JSON.stringify({
            success: true,
            eventId,
            kind: parsedEvent.kind,
            description,
        });
    } catch (error) {
        if (error instanceof Nip46PublishError) {
            logger.warn("[nostr_publish_as_user] Daemon reported NIP-46 publish failure", {
                status: error.status,
                reason: error.reason,
                ownerPubkey: shortenPubkey(ownerPubkey),
                kind: parsedEvent.kind,
            });
            throw new Error(
                `Failed to publish as user (${error.status}): ${error.reason}`,
                { cause: error }
            );
        }
        throw error;
    }
}

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

    return aiTool as AISdkTool;
}
