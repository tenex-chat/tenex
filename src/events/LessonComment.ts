import type { Hexpubkey } from "@nostr-dev-kit/ndk";

/**
 * A comment on a lesson (kind 1111 event per NIP-22).
 */
export interface LessonComment {
    /** The comment event ID */
    id: string;
    /** Author pubkey */
    pubkey: Hexpubkey;
    /** Comment content */
    content: string;
    /** The lesson event ID this comment references */
    lessonEventId: string;
    /** Unix timestamp */
    createdAt: number;
}
