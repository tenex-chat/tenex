/**
 * Test script for codex-app-server mid-execution injection
 *
 * Run with: npx tsx scripts/test-codex-injection.ts
 */

import { createCodexAppServer, type Session } from "ai-sdk-provider-codex-app-server";
import { streamText } from "ai";

let session: Session | null = null;

const provider = createCodexAppServer({
    defaultSettings: {
        cwd: process.cwd(),
        approvalMode: "never",
        sandboxMode: "workspace-write",
        onSessionCreated: (s) => {
            session = s;
            console.log(`\n[Session] threadId: ${s.threadId}\n`);
        },
    },
});

const model = provider("gpt-5.1-codex-max");

console.log("Starting stream with codex-app-server provider...\n");
console.log("---OUTPUT START---\n");

const result = await streamText({
    model,
    prompt: "Write a Python function to calculate factorial. Explain each step.",
});

// Inject after 3 seconds
setTimeout(async () => {
    if (session?.isActive()) {
        console.log("\n\n[INJECTING: Also add memoization]\n\n");
        await session.injectMessage("Also add memoization to improve performance.");
    } else {
        console.log("\n[Session not active, skipping injection]\n");
    }
}, 3000);

for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
}

console.log("\n\n---OUTPUT END---\n");
console.log("Finish reason:", await result.finishReason);

process.exit(0);
