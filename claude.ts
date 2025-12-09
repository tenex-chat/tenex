/**
 * Example: Tool Use Monitoring
 *
 * This example demonstrates how to monitor tool calls using onChunk callback.
 * Shows all tool uses and their payloads in the console.
 */

import { stepCountIs, streamText } from 'ai';
import { createClaudeCode } from 'ai-sdk-provider-claude-code';

async function monitorToolUse() {
  console.log('🔧 Monitoring Claude Tool Usage\n');

  const claude = createClaudeCode({});

  const result = streamText({
    stopWhen: stepCountIs(20),
    model: claude('haiku'),
    prompt: `You have access to many tools. Please demonstrate each one by doing the following tasks:

1. Use Bash to run "ls -la" and "pwd"
2. Use Glob to find all .ts files in the current directory
3. Use Grep to search for "import" in any .ts file
4. Use Read to read the package.json file
5. Use Write to create a file called TOOL_TEST.md with "# Tool Test" as content
6. Use Edit to add a line "## Section 1" to TOOL_TEST.md

Execute each tool one at a time and report what you find.`,
    onChunk: (() => {
      let inTextStream = false;

      return ({ chunk }: { chunk: any }) => {
        // Handle text-delta chunks as a stream
        if (chunk.type === 'text-delta') {
          if (!inTextStream) {
            console.log('\n' + '='.repeat(60));
            console.log('📝 TEXT STREAM:');
            console.log('='.repeat(60));
            inTextStream = true;
          }
          process.stdout.write(chunk.text);
          return;
        }

        // End text stream if we were in one
        if (inTextStream) {
          console.log('\n' + '='.repeat(60));
          inTextStream = false;
        }

        console.log('\n' + '='.repeat(60));
        console.log('📦 CHUNK:', chunk.type);
        console.log('='.repeat(60));

        switch (chunk.type) {
          case 'tool-call':
            console.log('Tool:', chunk.toolName);
            console.log('Tool Call ID:', chunk.toolCallId);
            console.log('Args:', chunk.args ? JSON.stringify(chunk.args, null, 2) : '(streamed above)');
            break;
          case 'tool-input-start':
            console.log('Tool:', chunk.toolName);
            console.log('Tool Call ID:', chunk.id);
            break;
          case 'tool-input-delta':
            console.log('Tool Call ID:', chunk.id);
            console.log('Args Delta:', chunk.delta);
            break;
          case 'tool-result':
            console.log('Tool:', chunk.toolName);
            console.log('Tool Call ID:', chunk.toolCallId);
            if (chunk.result != null) {
              const resultStr = typeof chunk.result === 'string'
                ? chunk.result
                : JSON.stringify(chunk.result, null, 2);
              console.log('Result:', resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr);
            } else {
              console.log('Result: (empty)');
            }
            break;
          case 'reasoning':
            console.log('Reasoning:', chunk.text);
            break;
          case 'source':
            console.log('Source:', JSON.stringify(chunk, null, 2));
            break;
          default:
            console.log('Raw:', JSON.stringify(chunk, null, 2));
        }

        console.log('='.repeat(60));
      };
    })(),
    onFinish({ text, finishReason, usage, steps }) {
      console.log('\n' + '═'.repeat(60));
      console.log('✅ FINISHED');
      console.log('═'.repeat(60));
      console.log('Finish reason:', finishReason);
      console.log('Total steps:', steps?.length || 0);
      console.log('Usage:', usage);
      console.log('Final text:', text || '(no text)');
      console.log('═'.repeat(60) + '\n');
    },
  });

  // Collect and display the text stream
  let response = '';
  for await (const chunk of result.textStream) {
    response += chunk;
    process.stdout.write(chunk);
  }

  console.log('\n\n📝 Full Response:', response.trim() || '(no response text)');
}

// Run the example
monitorToolUse()
  .then(() => {
    console.log('\n✅ Example completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Example failed:', error);
    process.exit(1);
  });
