#!/usr/bin/env bun

// Test script to verify the message duplication fix
import { LLMService } from './dist/llm/service.js';
import { streamText } from 'ai';

async function testStreamProcessing() {
  console.log('Testing simplified stream processing...\n');
  
  // Create a mock provider config
  const service = new LLMService(
    { 
      openrouter: { apiKey: 'test-key' }
    },
    {
      'test-model': {
        provider: 'openrouter',
        model: 'test/model',
        temperature: 0.7
      }
    },
    'test-model'
  );
  
  // Test that events are emitted correctly
  let contentReceived = '';
  let iterationCompleted = false;
  
  service.on('content', (event) => {
    console.log('Content event:', event.delta);
    contentReceived += event.delta;
  });
  
  service.on('complete', (event) => {
    console.log('Iteration complete:', event);
    iterationCompleted = true;
  });
  
  // Create a mock stream to test processing
  const mockChunks = [
    { type: 'text-delta', text: 'Hello' },
    { type: 'text-delta', text: ' world' },
    { type: 'finish', text: 'Hello world', experimental_toolInvocations: [] }
  ];
  
  async function* createMockStream() {
    for (const chunk of mockChunks) {
      yield chunk;
    }
  }
  
  console.log('Processing mock stream...');
  const processedStream = service.processStream(
    createMockStream(),
    {
      model: 'test-model',
      agent: 'test-agent',
      phase: 'CHAT',
      startTime: Date.now(),
      llmLogger: null,
      requestId: 'test-123'
    }
  );
  
  // Consume the stream
  for await (const chunk of processedStream) {
    console.log('Processed chunk:', chunk.type);
  }
  
  console.log('\n✅ Results:');
  console.log('- Content received:', contentReceived);
  console.log('- Iteration completed:', iterationCompleted);
  console.log('- Expected: "Hello world"');
  console.log('- Match:', contentReceived === 'Hello world');
  
  if (contentReceived === 'Hello world' && iterationCompleted) {
    console.log('\n✅ SUCCESS: Stream processing works correctly!');
    console.log('The message duplication issue should be fixed.');
  } else {
    console.log('\n❌ FAILURE: Stream processing has issues');
  }
}

testStreamProcessing().catch(console.error);