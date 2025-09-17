import { describe, it, expect, beforeEach } from 'bun:test';
import { ThreadService } from '@/conversations/services/ThreadService';
import { ParticipationIndex } from '@/conversations/services/ParticipationIndex';
import type { NDKEvent } from '@nostr-dev-kit/ndk';
import type { Conversation } from '@/conversations/types';

describe('ThreadWithMemoryStrategy - Sub-thread Bug Reproduction', () => {
  let threadService: ThreadService;
  let participationIndex: ParticipationIndex;
  let events: NDKEvent[];

  beforeEach(() => {
    threadService = new ThreadService();
    participationIndex = new ParticipationIndex();

    // Create the exact event structure from the bug report
    const userPubkey = '09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7';
    const agentPubkey = '90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2';

    // Helper to create mock events
    const createEvent = (id: string, pubkey: string, content: string, parentId?: string, timestamp?: number): NDKEvent => {
      const tags = parentId ? [['e', parentId]] : [];
      return {
        id,
        pubkey,
        content,
        created_at: timestamp || Date.now() / 1000,
        kind: 1111,
        tags,
        sig: 'mock-sig',
        tagValue: (tagName: string) => {
          const tag = tags.find(t => t[0] === tagName);
          return tag ? tag[1] : undefined;
        }
      } as any as NDKEvent;
    };

    // Create events in chronological order
    events = [
      // 1. User: "I'm debugging: say '1'" (root)
      createEvent('13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb', userPubkey, "I'm debugging: say '1'", undefined, 1758026650),

      // 2. Agent: "1" (reply to root)
      createEvent('8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9', agentPubkey, '1', '13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb', 1758026651),

      // 3. User: "say '2'" (reply to root)
      createEvent('8fb7f74d9d82c723195462abde2a11c0183186fa328be14ae7f18be95208fe6a', userPubkey, 'say "2"', '13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb', 1758026654),

      // 4. Agent: "2" (reply to root)
      createEvent('d1c77d8750f6976cf81403780108be27a0372f34e29c086cdc681884ed5cc378', agentPubkey, '2', '13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb', 1758026655),

      // 5. User: "say '1.1'" (SUB-THREAD: reply to agent's "1")
      createEvent('f6047d47e8f1e9aa4bc74806f085f08a6f38646c67a390814fab8cf58a0b8ba9', userPubkey, 'say "1.1"', '8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9', 1758026680),

      // 6. Agent: "1.1" (SUB-THREAD: reply to agent's "1")
      createEvent('1884c96c1e2ad3a6e36c5432fb8af6aabf3c92b9432a5caaa6a258265137153c', agentPubkey, '1.1', '8718e134972b7f309e13b8c30d291191245688f231f4d9ee648c93748c135bf9', 1758026682),

      // 7. User: "say '3'" (reply to root - THIS IS THE TRIGGER)
      createEvent('ce25118ba06c8dc0ab0ab62a2be13578401bff383b9d363db2f12156a3bacfaf', userPubkey, 'say "3"', '13fcefc9b3a28d876f1641beb6e94eec1ce21e2183409a60300b296ee0ca7cfb', 1758026732),
    ];
  });

  describe('ThreadService behavior', () => {
    it('should get thread to event "say 3" without sub-thread', () => {
      // When we get the thread to "say '3'" (event #7)
      const thread = threadService.getThreadToEvent(events[6].id, events);

      // ThreadService should return root + all root-level replies
      expect(thread.length).toBeGreaterThan(0);

      // Check what events are in the thread
      const threadContents = thread.map(e => e.content);

      console.log('Thread to "say 3":', threadContents);

      // It should include root and root-level messages
      expect(threadContents).toContain("I'm debugging: say '1'");
      expect(threadContents).toContain('1');
      expect(threadContents).toContain('say "2"');
      expect(threadContents).toContain('2');
      expect(threadContents).toContain('say "3"');

      // But NOT the sub-thread (this is the current behavior)
      expect(threadContents).not.toContain('say "1.1"');
      expect(threadContents).not.toContain('1.1');
    });

    it('should identify the sub-thread when getting thread for "1.1"', () => {
      // Get thread to the "1.1" response
      const thread = threadService.getThreadToEvent(events[5].id, events);

      const threadContents = thread.map(e => e.content);
      console.log('Thread to "1.1":', threadContents);

      // This sub-thread should include the root, the "1" response, and the "1.1" conversation
      expect(threadContents).toContain("I'm debugging: say '1'");
      expect(threadContents).toContain('1');
      expect(threadContents).toContain('say "1.1"');
      expect(threadContents).toContain('1.1');
    });
  });

  describe('ParticipationIndex behavior', () => {
    it('should track all agent participations including sub-threads', () => {
      const agentPubkey = '90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2';

      // Build the index
      participationIndex.buildIndex('test-conv', events);

      // Get all agent participations
      const agentParticipations = participationIndex.getAgentParticipations('test-conv', agentPubkey);

      console.log('Agent participation event IDs:', agentParticipations.map(id => id.substring(0, 8)));

      // Agent participated in 3 events: "1", "2", and "1.1"
      expect(agentParticipations.length).toBe(3);

      // Check that we have all three responses
      expect(agentParticipations).toContain(events[1].id); // "1"
      expect(agentParticipations).toContain(events[3].id); // "2"
      expect(agentParticipations).toContain(events[5].id); // "1.1"
    });

    it('should identify unique thread roots where agent participated', () => {
      const agentPubkey = '90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2';

      // Build the index
      participationIndex.buildIndex('test-conv', events);

      // Get thread roots
      const threadRoots = participationIndex.getAgentThreadRoots(
        'test-conv',
        agentPubkey,
        events,
        threadService
      );

      console.log('Thread roots where agent participated:', threadRoots.map(id => id.substring(0, 8)));

      // This is where the BUG is:
      // The agent participated in the main thread AND a sub-thread rooted at "1"
      // But getAgentThreadRoots only returns the main thread root
      expect(threadRoots.length).toBe(1); // Currently returns 1, should return 2
      expect(threadRoots).toContain(events[0].id); // Main thread root

      // THIS IS THE BUG: The sub-thread rooted at agent's "1" response is not recognized
      // expect(threadRoots).toContain(events[1].id); // Sub-thread root (agent's "1" response)
    });
  });

  describe('The Core Problem', () => {
    it('should demonstrate that sub-threads rooted at agent responses are missed', () => {
      const agentPubkey = '90672970653c15e58d38060178f924604d0add0b0e15c6ea472cd4b552ead2a2';

      // Build index
      participationIndex.buildIndex('test-conv', events);

      // When getting threads for the agent, we need to recognize that:
      // 1. The agent's "1" response (8718e134...) has become a sub-thread root
      // 2. The agent participated in that sub-thread with "1.1"

      // Current behavior: Only finds main thread
      const threadRoots = new Set<string>();
      const agentEventIds = participationIndex.getAgentParticipations('test-conv', agentPubkey);

      for (const eventId of agentEventIds) {
        const thread = threadService.getThreadToEvent(eventId, events);
        if (thread.length > 0) {
          threadRoots.add(thread[0].id);
        }
      }

      console.log('Current approach finds thread roots:', Array.from(threadRoots).map(id => id.substring(0, 8)));

      // This only finds the main thread root
      expect(threadRoots.size).toBe(1);

      // What we NEED: Recognize when agent responses become sub-thread roots
      const agentResponsesWithReplies = events.filter(e =>
        e.pubkey === agentPubkey &&
        events.some(other => other.tagValue('e') === e.id)
      );

      console.log('Agent responses that have replies (sub-thread roots):',
        agentResponsesWithReplies.map(e => ({ id: e.id.substring(0, 8), content: e.content }))
      );

      // The agent's "1" response has replies, making it a sub-thread root
      expect(agentResponsesWithReplies.length).toBe(1);
      expect(agentResponsesWithReplies[0].content).toBe('1');

      // THIS IS THE FIX NEEDED: Include sub-threads rooted at agent responses
    });
  });
});