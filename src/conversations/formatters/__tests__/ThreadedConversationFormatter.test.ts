import { describe, it, expect } from 'vitest';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { ThreadedConversationFormatter, FormatterOptions } from '../ThreadedConversationFormatter';

describe('ThreadedConversationFormatter', () => {
    const formatter = new ThreadedConversationFormatter();
    
    function createMockEvent(
        id: string,
        content: string,
        pubkey: string,
        replyTo?: string,
        timestamp: number = Date.now() / 1000
    ): NDKEvent {
        const event = new NDKEvent();
        event.id = id;
        event.content = content;
        event.pubkey = pubkey;
        event.created_at = timestamp;
        event.tags = [];
        
        if (replyTo) {
            event.tags.push(['e', replyTo, '', 'reply']);
        }
        
        return event;
    }
    
    describe('buildThreadTree', () => {
        it('should build a simple linear thread', async () => {
            const events = [
                createMockEvent('1', 'Hello', 'user1'),
                createMockEvent('2', 'Hi there', 'agent1', '1'),
                createMockEvent('3', 'How are you?', 'user1', '2')
            ];

            const tree = await formatter.buildThreadTree(events);

            expect(tree).toHaveLength(1);
            expect(tree[0].event.id).toBe('1');
            expect(tree[0].children).toHaveLength(1);
            expect(tree[0].children[0].event.id).toBe('2');
            expect(tree[0].children[0].children).toHaveLength(1);
            expect(tree[0].children[0].children[0].event.id).toBe('3');
        });
        
        it('should build a branching thread', async () => {
            const events = [
                createMockEvent('1', 'Root message', 'user1'),
                createMockEvent('2', 'Reply 1', 'agent1', '1'),
                createMockEvent('3', 'Reply 2', 'agent2', '1'),
                createMockEvent('4', 'Reply to Reply 1', 'user1', '2')
            ];

            const tree = await formatter.buildThreadTree(events);

            expect(tree).toHaveLength(1);
            expect(tree[0].event.id).toBe('1');
            expect(tree[0].children).toHaveLength(2);
            expect(tree[0].children.map(c => c.event.id)).toContain('2');
            expect(tree[0].children.map(c => c.event.id)).toContain('3');

            const reply1Node = tree[0].children.find(c => c.event.id === '2')!;
            expect(reply1Node.children).toHaveLength(1);
            expect(reply1Node.children[0].event.id).toBe('4');
        });
        
        it('should handle multiple root nodes', async () => {
            const events = [
                createMockEvent('1', 'Thread 1', 'user1'),
                createMockEvent('2', 'Thread 2', 'user2'),
                createMockEvent('3', 'Reply to 1', 'agent1', '1'),
                createMockEvent('4', 'Reply to 2', 'agent1', '2')
            ];

            const tree = await formatter.buildThreadTree(events);

            expect(tree).toHaveLength(2);
            expect(tree[0].event.id).toBe('1');
            expect(tree[1].event.id).toBe('2');
            expect(tree[0].children).toHaveLength(1);
            expect(tree[1].children).toHaveLength(1);
        });
    });
    
    describe('extractAgentBranches', () => {
        it('should extract branches where agent participated', async () => {
            const events = [
                createMockEvent('1', 'User message', 'user1'),
                createMockEvent('2', 'Agent reply', 'agent1', '1'),
                createMockEvent('3', 'User follow-up', 'user1', '2'),
                createMockEvent('4', 'Other user', 'user2', '1'),
                createMockEvent('5', 'Other follow-up', 'user2', '4')
            ];

            const tree = await formatter.buildThreadTree(events);
            const agentBranches = formatter.extractAgentBranches(tree, 'agent1');
            
            expect(agentBranches).toHaveLength(1);
            expect(agentBranches[0].event.id).toBe('1');
            // When agent participates, we include ALL branches for context
            expect(agentBranches[0].children).toHaveLength(2);
            
            // Find the branch with agent
            const agentBranch = agentBranches[0].children.find(c => c.event.id === '2');
            expect(agentBranch).toBeDefined();
            expect(agentBranch!.event.id).toBe('2');
            expect(agentBranch!.children).toHaveLength(1);
            expect(agentBranch!.children[0].event.id).toBe('3');
            
            // The other branch should also be included for context
            const otherBranch = agentBranches[0].children.find(c => c.event.id === '4');
            expect(otherBranch).toBeDefined();
        });
        
        it('should include full context when agent is deep in thread', async () => {
            const events = [
                createMockEvent('1', 'Root', 'user1'),
                createMockEvent('2', 'Reply', 'user2', '1'),
                createMockEvent('3', 'Agent joins', 'agent1', '2'),
                createMockEvent('4', 'Follow-up', 'user1', '3')
            ];

            const tree = await formatter.buildThreadTree(events);
            const agentBranches = formatter.extractAgentBranches(tree, 'agent1');
            
            expect(agentBranches).toHaveLength(1);
            expect(agentBranches[0].event.id).toBe('1'); // Include root for context
            expect(agentBranches[0].children[0].event.id).toBe('2');
            expect(agentBranches[0].children[0].children[0].event.id).toBe('3');
            expect(agentBranches[0].children[0].children[0].children[0].event.id).toBe('4');
        });
    });
    
    describe('formatThread', () => {
        it('should format thread with ASCII tree style', async () => {
            const events = [
                createMockEvent('1', 'Hello', 'user1', undefined, 1000),
                createMockEvent('2', 'Hi there', 'agent1', '1', 1001),
                createMockEvent('3', 'How are you?', 'user1', '2', 1002)
            ];

            const tree = await formatter.buildThreadTree(events);
            const options: FormatterOptions = {
                includeTimestamps: true,
                timestampFormat: 'time-only',
                includeToolCalls: false,
                treeStyle: 'ascii',
                compactMode: true
            };
            
            const formatted = formatter.formatThread(tree[0], options);
            
            expect(formatted).toContain('Hello');
            expect(formatted).toContain('└──');
            expect(formatted).toContain('Hi there');
            expect(formatted).toContain('How are you?');
        });
        
        it('should include tool calls when enabled', async () => {
            const event1 = createMockEvent('1', 'Let me help', 'agent1');
            event1.tags.push(['tool', 'read_file', 'config.json']);

            const event2 = createMockEvent('2', 'Found it', 'agent1', '1');

            const events = [event1, event2];
            const tree = await formatter.buildThreadTree(events);
            
            const options: FormatterOptions = {
                includeTimestamps: false,
                timestampFormat: 'time-only',
                includeToolCalls: true,
                treeStyle: 'ascii',
                compactMode: true
            };
            
            const formatted = formatter.formatThread(tree[0], options);
            
            expect(formatted).toContain('[calls tool: read_file(config.json)]');
        });
        
        it('should respect maxDepth option', async () => {
            const events = [
                createMockEvent('1', 'Level 1', 'user1'),
                createMockEvent('2', 'Level 2', 'agent1', '1'),
                createMockEvent('3', 'Level 3', 'user1', '2'),
                createMockEvent('4', 'Level 4', 'agent1', '3')
            ];

            const tree = await formatter.buildThreadTree(events);
            const options: FormatterOptions = {
                includeTimestamps: false,
                timestampFormat: 'time-only',
                includeToolCalls: false,
                treeStyle: 'ascii',
                compactMode: true,
                maxDepth: 2
            };
            
            const formatted = formatter.formatThread(tree[0], options);
            
            expect(formatted).toContain('Level 1');
            expect(formatted).toContain('Level 2');
            expect(formatted).toContain('Level 3');
            expect(formatted).not.toContain('Level 4'); // Should be cut off by maxDepth
        });
    });
    
    describe('formatOtherBranches', () => {
        it('should format branches excluding active ones', async () => {
            const events = [
                createMockEvent('root', 'Root', 'user1'),
                createMockEvent('branch1', 'Branch 1', 'user2', 'root'),
                createMockEvent('reply1', 'Agent reply', 'agent1', 'branch1'),
                createMockEvent('branch2', 'Branch 2', 'user1', 'root'),
                createMockEvent('reply2', 'Another reply', 'user1', 'branch2')
            ];
            
            // Active branch is root -> branch2 -> reply2
            const activeBranchIds = new Set(['root', 'branch2', 'reply2']);
            
            const formatted = await formatter.formatOtherBranches(events, 'agent1', activeBranchIds);
            
            // Should include branch1 where agent participated
            expect(formatted).toBeTruthy();
            expect(formatted).toContain('Branch 1');
            expect(formatted).toContain('Agent reply');
            // Should NOT include branch2 (active branch)
            expect(formatted).not.toContain('Branch 2');
            expect(formatted).not.toContain('Another reply');
        });
    });
});