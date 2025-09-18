import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadedConversationFormatter } from '../ThreadedConversationFormatter';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import type { ThreadNode } from '../ThreadedConversationFormatter';

describe('ThreadedConversationFormatter - Branch Pruning', () => {
  let formatter: ThreadedConversationFormatter;
  
  beforeEach(() => {
    formatter = new ThreadedConversationFormatter();
  });

  const createMockEvent = (id: string, content: string, pubkey: string, parentId?: string): NDKEvent => {
    const event = {
      id,
      content,
      pubkey,
      created_at: Date.now() / 1000,
      tags: parentId ? [['e', parentId]] : [],
      tagValue: (tag: string) => {
        if (tag === 'e' && parentId) return parentId;
        return undefined;
      }
    } as NDKEvent;
    return event;
  };

  describe('formatOtherBranches', () => {
    it('should exclude the active branch completely', () => {
      // Create a conversation tree:
      // root1
      //   ├── child1 (agent)
      //   └── child2 (user) <- active branch
      //        └── child3 (agent)
      
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root1', 'Root message', userPubkey),
        createMockEvent('child1', 'Agent response 1', agentPubkey, 'root1'),
        createMockEvent('child2', 'User response', userPubkey, 'root1'),
        createMockEvent('child3', 'Agent response 2', agentPubkey, 'child2'),
      ];
      
      // Active branch includes root1, child2 and child3 (the direct path)
      // child1 is NOT in the active branch since it's a sibling branch
      const activeBranchIds = new Set(['root1', 'child2', 'child3']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should only include child1 branch (where agent participated but not in active branch)
      expect(result).toBeTruthy();
      expect(result!).toContain('Agent response 1');
      expect(result!).not.toContain('User response');
      expect(result!).not.toContain('Agent response 2');
    });

    it('should return null when agent only participated in active branch', () => {
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root1', 'Root message', userPubkey),
        createMockEvent('child1', 'User continues', userPubkey, 'root1'),
        createMockEvent('child2', 'Agent response', agentPubkey, 'child1'),
      ];
      
      // All events are in the active branch
      const activeBranchIds = new Set(['root1', 'child1', 'child2']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      expect(result).toBeNull();
    });

    it('should handle multiple separate threads correctly', () => {
      // Create two separate conversation trees:
      // root1                    root2
      //   ├── child1 (agent)       └── child4 (agent)
      //   └── child2 (user)             └── child5 (user)
      //        └── child3 (other)
      
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      const otherPubkey = 'other789';
      
      const events = [
        // First tree
        createMockEvent('root1', 'First conversation', userPubkey),
        createMockEvent('child1', 'Agent in first tree', agentPubkey, 'root1'),
        createMockEvent('child2', 'User continues', userPubkey, 'root1'),
        createMockEvent('child3', 'Other user response', otherPubkey, 'child2'),
        
        // Second tree (separate root)
        createMockEvent('root2', 'Second conversation', userPubkey),
        createMockEvent('child4', 'Agent in second tree', agentPubkey, 'root2'),
        createMockEvent('child5', 'User in second tree', userPubkey, 'child4'),
      ];
      
      // Active branch is the second tree
      const activeBranchIds = new Set(['root2', 'child4', 'child5']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include only the first tree where agent participated
      expect(result).toContain('Agent in first tree');
      expect(result).not.toContain('Agent in second tree');
      expect(result).not.toContain('User in second tree');
    });

    it('should preserve complete context of branches where agent participated', () => {
      // Tree structure:
      // root
      //   ├── branch1
      //   │    ├── agent_msg
      //   │    └── user_reply
      //   └── branch2 (active)
      
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Start', userPubkey),
        createMockEvent('branch1', 'Branch 1 start', userPubkey, 'root'),
        createMockEvent('agent_msg', 'Agent participates', agentPubkey, 'branch1'),
        createMockEvent('user_reply', 'User replies to agent', userPubkey, 'agent_msg'),
        createMockEvent('branch2', 'Branch 2 (active)', userPubkey, 'root'),
      ];
      
      const activeBranchIds = new Set(['root', 'branch2']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include the complete branch1 context
      expect(result).toBeTruthy();
      expect(result!).toContain('Branch 1 start');
      expect(result!).toContain('Agent participates');
      expect(result!).toContain('User replies to agent');
      expect(result!).not.toContain('Branch 2 (active)');
    });

    it('should handle deeply nested threads with agent participation', () => {
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Root', userPubkey),
        createMockEvent('l1', 'Level 1', userPubkey, 'root'),
        createMockEvent('l2', 'Level 2', userPubkey, 'l1'),
        createMockEvent('l3_agent', 'Agent at level 3', agentPubkey, 'l2'),
        createMockEvent('l4', 'Level 4', userPubkey, 'l3_agent'),
        createMockEvent('active_branch', 'Active branch', userPubkey, 'root'),
      ];
      
      const activeBranchIds = new Set(['root', 'active_branch']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include the deep branch where agent participated
      expect(result).toBeTruthy();
      expect(result!).toContain('Agent at level 3');
      expect(result!).toContain('Level 4'); // Include full context after agent
      expect(result!).not.toContain('Active branch');
    });

    it('should correctly handle when active branch is a sub-thread', () => {
      // Tree where active branch is not from root:
      // root
      //   ├── branch1
      //   │    ├── agent_msg
      //   │    └── sub_branch (active starts here)
      //   │         └── continuation
      //   └── branch2
      //        └── agent_other
      
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Root', userPubkey),
        createMockEvent('branch1', 'Branch 1', userPubkey, 'root'),
        createMockEvent('agent_msg', 'Agent message', agentPubkey, 'branch1'),
        createMockEvent('sub_branch', 'Sub branch start', userPubkey, 'agent_msg'),
        createMockEvent('continuation', 'Continuation', userPubkey, 'sub_branch'),
        createMockEvent('branch2', 'Branch 2', userPubkey, 'root'),
        createMockEvent('agent_other', 'Agent in other branch', agentPubkey, 'branch2'),
      ];
      
      // Active branch is the sub-thread starting from sub_branch
      const activeBranchIds = new Set(['sub_branch', 'continuation']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include agent_msg (not in active branch) and agent_other branch
      expect(result).toContain('Agent message');
      expect(result).toContain('Agent in other branch');
      expect(result).not.toContain('Sub branch start');
      expect(result).not.toContain('Continuation');
    });
  });

  describe('pruneBranch edge cases', () => {
    it('should handle empty active branch set', () => {
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Root', userPubkey),
        createMockEvent('child', 'Child', agentPubkey, 'root'),
      ];
      
      const activeBranchIds = new Set<string>(); // Empty set
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include everything since nothing is pruned
      expect(result).toContain('Root');
      expect(result).toContain('Child');
    });

    it('should handle when entire tree is active branch', () => {
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Root', userPubkey),
        createMockEvent('child1', 'Child 1', agentPubkey, 'root'),
        createMockEvent('child2', 'Child 2', userPubkey, 'child1'),
      ];
      
      // Entire tree is active
      const activeBranchIds = new Set(['root', 'child1', 'child2']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      expect(result).toBeNull();
    });

    it('should handle orphaned events gracefully', () => {
      const agentPubkey = 'agent123';
      const userPubkey = 'user456';
      
      const events = [
        createMockEvent('root', 'Root', userPubkey),
        createMockEvent('child', 'Child', agentPubkey, 'root'),
        createMockEvent('orphan', 'Orphan event', agentPubkey, 'non-existent'), // Parent doesn't exist
      ];
      
      const activeBranchIds = new Set(['root']);
      
      const result = formatter.formatOtherBranches(events, agentPubkey, activeBranchIds);
      
      // Should include child and orphan (as separate root)
      expect(result).toBeTruthy();
      expect(result!).toContain('Child');
      expect(result!).toContain('Orphan event');
    });
  });
});