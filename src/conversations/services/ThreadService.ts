import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Service for navigating thread structures in conversations
 * Single Responsibility: Thread path construction and navigation
 */
export class ThreadService {
    /**
     * Get the complete thread from root to the given event
     * INCLUDING all sibling responses at each level
     */
    getThreadToEvent(eventId: string, history: NDKEvent[]): NDKEvent[] {
        const eventMap = new Map(history.map((e) => [e.id, e]));
        const event = eventMap.get(eventId);

        if (!event) {
            logger.warn("[ThreadService] Event not found in history", {
                eventId: eventId.substring(0, 8),
                historySize: history.length,
                availableIds: history.slice(0, 5).map((e) => e.id.substring(0, 8)),
            });
            return [];
        }

        // First, build the parent chain to understand the thread structure
        const parentChain: NDKEvent[] = [];
        const visited = new Set<string>();
        let current: NDKEvent | null = event;

        logger.debug("[ThreadService] Starting thread build", {
            targetEventId: eventId.substring(0, 8),
            targetContent: event.content?.substring(0, 50),
            targetParentTag: event.tagValue("e")?.substring(0, 8),
        });

        // Walk backwards to build parent chain
        while (current) {
            if (visited.has(current.id)) {
                logger.warn("[ThreadService] Circular reference detected", {
                    eventId: current.id.substring(0, 8),
                });
                break;
            }

            visited.add(current.id);
            parentChain.unshift(current);

            const parentId = current.tagValue("e");
            if (!parentId) {
                logger.debug("[ThreadService] Reached root event", {
                    rootId: current.id.substring(0, 8),
                    rootContent: current.content?.substring(0, 50),
                });
                break;
            }

            current = eventMap.get(parentId) || null;

            if (!current && parentId) {
                logger.warn("[ThreadService] Parent event not found", {
                    parentId: parentId.substring(0, 8),
                    childId: parentChain[0].id.substring(0, 8),
                });
            }
        }

        // Now build complete thread including siblings at each level
        const completeThread: NDKEvent[] = [];

        // For simple case where we're replying directly to root
        if (parentChain.length === 2 && parentChain[1].id === event.id) {
            const rootId = parentChain[0].id;

            logger.debug(
                "[ThreadService] Direct reply to root - including all root-level messages",
                {
                    rootId: rootId.substring(0, 8),
                    targetId: event.id.substring(0, 8),
                }
            );

            // Add root
            completeThread.push(parentChain[0]);

            // Find and add ALL direct replies to root (siblings of our target)
            const rootReplies = history
                .filter((e) => {
                    if (e.id === rootId) return false; // Skip root itself
                    return e.tagValue("e") === rootId;
                })
                .sort((a, b) => a.created_at - b.created_at);

            logger.debug("[ThreadService] Found root-level replies", {
                count: rootReplies.length,
                replies: rootReplies.map((r) => ({
                    id: r.id.substring(0, 8),
                    content: r.content?.substring(0, 30),
                    pubkey: r.pubkey?.substring(0, 8),
                })),
            });

            completeThread.push(...rootReplies);
            return completeThread;
        }

        // For deeper nested threads, include the full path with siblings at each level
        for (let i = 0; i < parentChain.length; i++) {
            const currentLevel = parentChain[i];
            completeThread.push(currentLevel);

            // If not the last in chain, find siblings
            if (i < parentChain.length - 1) {
                const nextInChain = parentChain[i + 1];
                const siblings = history
                    .filter((e) => {
                        if (e.id === currentLevel.id || e.id === nextInChain.id) return false;
                        return e.tagValue("e") === currentLevel.id;
                    })
                    .sort((a, b) => a.created_at - b.created_at);

                // Add siblings before the next in chain
                for (const sibling of siblings) {
                    if (sibling.created_at < nextInChain.created_at) {
                        completeThread.push(sibling);
                    }
                }
            }
        }

        logger.debug("[ThreadService] Complete thread built", {
            eventId: eventId.substring(0, 8),
            parentChainLength: parentChain.length,
            completeThreadLength: completeThread.length,
            threadEvents: completeThread.map((e) => ({
                id: e.id.substring(0, 8),
                content: e.content?.substring(0, 30),
                parent: e.tagValue("e")?.substring(0, 8),
            })),
        });

        return completeThread;
    }

    /**
     * Get descendants that are in the path to target
     */
    private getDescendantsInPath(
        parentId: string,
        parentChain: NDKEvent[],
        history: NDKEvent[]
    ): NDKEvent[] {
        const descendants: NDKEvent[] = [];

        // Find direct children of this parent
        const children = history
            .filter((e) => {
                return e.tagValue("e") === parentId;
            })
            .sort((a, b) => a.created_at - b.created_at);

        for (const child of children) {
            descendants.push(child);

            // If this child is in the parent chain, recurse
            if (parentChain.some((p) => p.id === child.id)) {
                const grandchildren = this.getDescendantsInPath(child.id, parentChain, history);
                descendants.push(...grandchildren);
            }
        }

        return descendants;
    }

    /**
     * Get all direct child events of a given event
     */
    getChildEvents(eventId: string, history: NDKEvent[]): NDKEvent[] {
        return history.filter((event) => event.tagValue("e") === eventId);
    }

    /**
     * Get the root event of a thread
     */
    getThreadRoot(thread: NDKEvent[]): string {
        // First event in thread path is the root
        return thread[0]?.id || "unknown";
    }

    /**
     * Check if an event is part of a specific thread
     */
    isInThread(eventId: string, threadRootId: string, history: NDKEvent[]): boolean {
        const thread = this.getThreadToEvent(eventId, history);
        return thread.length > 0 && thread[0].id === threadRootId;
    }

    /**
     * Get all thread roots in a conversation
     */
    getAllThreadRoots(history: NDKEvent[]): string[] {
        const roots = new Set<string>();

        for (const event of history) {
            // An event is a root if it has no parent tag or if it has an E tag pointing to itself
            const parentTag = event.tags.find((t) => t[0] === "e");
            const rootTag = event.tags.find((t) => t[0] === "E");

            if (!parentTag || (rootTag && rootTag[1] === event.id)) {
                roots.add(event.id);
            }
        }

        return Array.from(roots);
    }
}
