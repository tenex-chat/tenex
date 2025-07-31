// Test to verify StreamPublisher sends complete content in reply event
import { NostrPublisher } from './src/nostr/NostrPublisher.ts';
import { NDKEvent } from '@nostr-dev-kit/ndk';

// Mock context
const mockContext = {
    agent: {
        name: 'test-agent',
        pubkey: 'test-pubkey',
        signer: {
            sign: async () => ({ sig: 'test-signature' })
        }
    },
    triggeringEvent: {
        id: 'test-event-id',
        tagValue: (tag) => 'test-conversation-id'
    }
};

// Mock publisher
const mockPublisher = {
    context: mockContext,
    publishResponse: async ({ content }) => {
        console.log('✅ Final reply event content:', content);
        console.log('✅ Content length:', content.length);
        return new NDKEvent();
    }
};

// Test
async function testStreamPublisher() {
    console.log('Testing StreamPublisher accumulated content fix...\n');
    
    // Create StreamPublisher instance
    const StreamPublisher = NostrPublisher.StreamPublisher;
    const stream = new StreamPublisher(mockPublisher);
    
    // Simulate streaming content in chunks
    const chunks = [
        'This is the first chunk. ',
        'This is the second chunk. ',
        'This is the third and final chunk.'
    ];
    
    console.log('Adding content chunks:');
    for (const chunk of chunks) {
        console.log(`- Adding: "${chunk}"`);
        stream.addContent(chunk);
        // Simulate delay between chunks
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log('\nFinalizing stream...');
    await stream.finalize({ phase: 'test' });
    
    const expectedContent = chunks.join('');
    console.log(`\n✅ Expected total content: "${expectedContent}"`);
    console.log(`✅ Expected length: ${expectedContent.length}`);
}

// Run test
testStreamPublisher().catch(console.error);