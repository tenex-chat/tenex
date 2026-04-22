import { collectEvents } from "@/nostr/collectEvents";
import { NDKKind } from "@/nostr/kinds";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { enqueueSignedEventForRustPublish } from "@/nostr/RustPublishOutbox";
import { Nip46SigningLog, Nip46SigningService } from "@/services/nip46";
import { shortenOptionalEventId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { NDKProject, type NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";

export type ProjectMetadataKey = "image" | "repo" | "title" | "description";

export interface FetchLatestProjectEventParams {
    projectDTag: string;
    ownerPubkey?: string;
    includeDeleted?: boolean;
}

export interface PublishProjectMutationParams {
    ownerPubkey: string;
    projectDTag: string;
    trigger: string;
    addAgentPubkeys?: string[];
    removeAgentPubkeys?: string[];
    retainAgentPubkeys?: string[];
    set?: Partial<Record<ProjectMetadataKey, string>>;
}

export type ProjectEventPublishOutcome =
    | "published"
    | "project_not_found"
    | "signing_failed"
    | "publish_failed"
    | "signing_disabled"
    | "no_changes";

export interface ProjectEventPublishResult {
    projectDTag: string;
    outcome: ProjectEventPublishOutcome;
    eventId?: string;
    reason?: string;
    addedPubkeys: string[];
    removedPubkeys: string[];
    updatedFields: ProjectMetadataKey[];
    skipped: string[];
}

interface AppliedProjectMutation {
    tags: string[][];
    content: string;
    addedPubkeys: string[];
    removedPubkeys: string[];
    updatedFields: ProjectMetadataKey[];
    skipped: string[];
    hasChanges: boolean;
}

function uniqueOrdered(values: string[] | undefined): string[] {
    return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function cloneTags(tags: string[][]): string[][] {
    return tags.map((tag) => [...tag]);
}

function getFirstTagValue(tags: string[][], tagName: string): string | undefined {
    return tags.find((tag) => tag[0] === tagName)?.[1];
}

export function isDeletedProjectEvent(event: Pick<NDKEvent, "tags">): boolean {
    return event.tags.some((tag) => tag[0] === "deleted");
}

function selectLatestProjectEvent(events: NDKEvent[]): NDKEvent | null {
    if (events.length === 0) {
        return null;
    }

    return [...events].sort((a, b) => {
        const createdDelta = (b.created_at || 0) - (a.created_at || 0);
        if (createdDelta !== 0) {
            return createdDelta;
        }
        return (b.id || "").localeCompare(a.id || "");
    })[0] ?? null;
}

export class ProjectEventPublishService {
    async fetchLatestProjectEvent(
        params: FetchLatestProjectEventParams,
    ): Promise<NDKEvent | null> {
        await initNDK();

        const ndk = getNDK();
        const filter = this.buildProjectFilter(params.projectDTag, params.ownerPubkey);
        const events = await collectEvents(ndk, filter, {
            timeoutMs: 10_000,
            subOpts: { groupable: false },
        });

        const latestEvent = selectLatestProjectEvent(events);
        if (!latestEvent) {
            return null;
        }

        if (!params.includeDeleted && isDeletedProjectEvent(latestEvent)) {
            return null;
        }

        return latestEvent;
    }

    async publishMutation(
        params: PublishProjectMutationParams,
    ): Promise<ProjectEventPublishResult> {
        const baseEvent = await this.fetchLatestProjectEvent({
            projectDTag: params.projectDTag,
            ownerPubkey: params.ownerPubkey,
            includeDeleted: true,
        });

        if (!baseEvent || isDeletedProjectEvent(baseEvent)) {
            logger.warn("[ProjectEventPublishService] Could not find active project event for publish", {
                ownerPubkey: shortenPubkey(params.ownerPubkey),
                projectDTag: params.projectDTag,
            });
            return {
                projectDTag: params.projectDTag,
                outcome: "project_not_found",
                addedPubkeys: [],
                removedPubkeys: [],
                updatedFields: [],
                skipped: [],
            };
        }

        const applied = this.applyMutation(baseEvent, params);
        if (!applied.hasChanges) {
            return {
                projectDTag: params.projectDTag,
                outcome: "no_changes",
                addedPubkeys: applied.addedPubkeys,
                removedPubkeys: applied.removedPubkeys,
                updatedFields: applied.updatedFields,
                skipped: applied.skipped,
            };
        }

        const ndk = getNDK();
        const updatedEvent = new NDKProject(ndk);
        updatedEvent.kind = NDKKind.Project;
        updatedEvent.content = applied.content;
        updatedEvent.tags = applied.tags;
        (updatedEvent as { created_at?: number }).created_at = undefined;
        (updatedEvent as { id?: string }).id = undefined;
        (updatedEvent as { sig?: string }).sig = undefined;

        const nip46Service = Nip46SigningService.getInstance();

        if (!nip46Service.isEnabled()) {
            logger.warn("[ProjectEventPublishService] NIP-46 not enabled — 31933 update skipped", {
                ownerPubkey: shortenPubkey(params.ownerPubkey),
                projectDTag: params.projectDTag,
            });
            return {
                projectDTag: params.projectDTag,
                outcome: "signing_disabled",
                addedPubkeys: applied.addedPubkeys,
                removedPubkeys: applied.removedPubkeys,
                updatedFields: applied.updatedFields,
                skipped: applied.skipped,
            };
        }

        const signResult = await nip46Service.signEvent(
            params.ownerPubkey,
            updatedEvent,
            params.trigger,
        );

        if (signResult.outcome !== "signed") {
            logger.warn("[ProjectEventPublishService] Skipping 31933 publish — signing failed", {
                ownerPubkey: shortenPubkey(params.ownerPubkey),
                projectDTag: params.projectDTag,
                outcome: signResult.outcome,
                reason: "reason" in signResult ? signResult.reason : undefined,
            });
            return {
                projectDTag: params.projectDTag,
                outcome: "signing_failed",
                reason: "reason" in signResult ? signResult.reason : undefined,
                addedPubkeys: applied.addedPubkeys,
                removedPubkeys: applied.removedPubkeys,
                updatedFields: applied.updatedFields,
                skipped: applied.skipped,
            };
        }

        try {
            await enqueueSignedEventForRustPublish(updatedEvent, {
                correlationId: params.trigger,
                projectId: params.projectDTag,
                conversationId: params.projectDTag,
                requestId: `${params.trigger}:${params.projectDTag}:${updatedEvent.id}`,
            });
            Nip46SigningLog.getInstance().log({
                op: "event_published",
                ownerPubkey: Nip46SigningLog.truncatePubkey(params.ownerPubkey),
                eventKind: NDKKind.Project as number,
                signerType: "nip46",
                eventId: updatedEvent.id,
            });
            logger.info("[ProjectEventPublishService] Enqueued owner-signed 31933 update for Rust publish", {
                ownerPubkey: shortenPubkey(params.ownerPubkey),
                projectDTag: params.projectDTag,
                eventId: shortenOptionalEventId(updatedEvent.id),
                addedPubkeys: applied.addedPubkeys.length,
                removedPubkeys: applied.removedPubkeys.length,
                updatedFields: applied.updatedFields,
            });
            return {
                projectDTag: params.projectDTag,
                outcome: "published",
                eventId: updatedEvent.id,
                addedPubkeys: applied.addedPubkeys,
                removedPubkeys: applied.removedPubkeys,
                updatedFields: applied.updatedFields,
                skipped: applied.skipped,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logger.warn("[ProjectEventPublishService] Failed to enqueue 31933 update", {
                ownerPubkey: shortenPubkey(params.ownerPubkey),
                projectDTag: params.projectDTag,
                error: reason,
            });
            return {
                projectDTag: params.projectDTag,
                outcome: "publish_failed",
                reason,
                addedPubkeys: applied.addedPubkeys,
                removedPubkeys: applied.removedPubkeys,
                updatedFields: applied.updatedFields,
                skipped: applied.skipped,
            };
        }
    }

    private buildProjectFilter(projectDTag: string, ownerPubkey?: string): NDKFilter {
        return ownerPubkey
            ? { kinds: [NDKKind.Project as number], authors: [ownerPubkey], "#d": [projectDTag] }
            : { kinds: [NDKKind.Project as number], "#d": [projectDTag] };
    }

    private applyMutation(
        baseEvent: NDKEvent,
        params: PublishProjectMutationParams,
    ): AppliedProjectMutation {
        let tags = cloneTags(baseEvent.tags);
        let content = baseEvent.content || "";

        const addedPubkeys: string[] = [];
        const removedPubkeys: string[] = [];
        const updatedFields: ProjectMetadataKey[] = [];
        const skipped: string[] = [];

        const removedPubkeySet = new Set<string>();
        const addAgentPubkeys = uniqueOrdered(params.addAgentPubkeys);
        const removeAgentPubkeys = uniqueOrdered(params.removeAgentPubkeys);
        const retainAgentPubkeys = uniqueOrdered(params.retainAgentPubkeys);

        const hasAgentTag = (pubkey: string): boolean =>
            tags.some((tag) => tag[0] === "p" && tag[1] === pubkey);

        if (retainAgentPubkeys.length > 0) {
            const retainSet = new Set(retainAgentPubkeys);
            const filteredTags: string[][] = [];

            for (const tag of tags) {
                if (tag[0] !== "p" || !tag[1] || retainSet.has(tag[1])) {
                    filteredTags.push(tag);
                    continue;
                }

                if (!removedPubkeySet.has(tag[1])) {
                    removedPubkeySet.add(tag[1]);
                    removedPubkeys.push(tag[1]);
                }
            }

            tags = filteredTags;
        }

        for (const pubkey of removeAgentPubkeys) {
            if (removedPubkeySet.has(pubkey)) {
                continue;
            }

            if (!hasAgentTag(pubkey)) {
                skipped.push(`agent ${pubkey} already absent`);
                continue;
            }

            tags = tags.filter((tag) => tag[0] !== "p" || tag[1] !== pubkey);
            removedPubkeySet.add(pubkey);
            removedPubkeys.push(pubkey);
        }

        for (const pubkey of addAgentPubkeys) {
            if (hasAgentTag(pubkey)) {
                skipped.push(`agent ${pubkey} already present`);
                continue;
            }

            tags.push(["p", pubkey]);
            addedPubkeys.push(pubkey);
        }

        const applyTagField = (
            metadataKey: Exclude<ProjectMetadataKey, "description">,
            tagName: "title" | "repo" | "picture",
        ) => {
            const nextValue = params.set?.[metadataKey];
            if (nextValue === undefined) {
                return;
            }

            const currentValue = getFirstTagValue(tags, tagName);
            if ((currentValue ?? "") === nextValue) {
                skipped.push(`${metadataKey} unchanged`);
                return;
            }

            if (nextValue === "" && currentValue === undefined) {
                skipped.push(`${metadataKey} already cleared`);
                return;
            }

            tags = tags.filter((tag) => tag[0] !== tagName);
            if (nextValue !== "") {
                tags.push([tagName, nextValue]);
            }
            updatedFields.push(metadataKey);
        };

        applyTagField("title", "title");
        applyTagField("repo", "repo");
        applyTagField("image", "picture");

        if (params.set?.description !== undefined) {
            if (content === params.set.description) {
                skipped.push("description unchanged");
            } else {
                content = params.set.description;
                updatedFields.push("description");
            }
        }

        return {
            tags,
            content,
            addedPubkeys,
            removedPubkeys,
            updatedFields,
            skipped,
            hasChanges: (
                addedPubkeys.length > 0
                || removedPubkeys.length > 0
                || updatedFields.length > 0
            ),
        };
    }
}

export const projectEventPublishService = new ProjectEventPublishService();
