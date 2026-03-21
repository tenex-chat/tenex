import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { Hexpubkey } from "@nostr-dev-kit/ndk";

/**
 * Assess whether to trust a pubkey publishing a lesson event.
 *
 * All lessons are currently trusted unconditionally. When trust boundaries are
 * needed (e.g. whitelist/reputation checks), implement the filtering logic here.
 */
export function shouldTrustLesson(lesson: NDKAgentLesson, publisherPubkey: Hexpubkey): boolean {
    void lesson;
    void publisherPubkey;
    return true;
}
