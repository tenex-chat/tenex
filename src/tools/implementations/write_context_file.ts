import { tool } from 'ai';
import { access, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const WriteContextFileArgsSchema = z.object({
  filename: z.string().min(1, "filename must be a non-empty string"),
  content: z.string().min(1, "content must be a non-empty string"),
  title: z.string().min(1, "title must be a non-empty string"),
  changelog: z.string().nullable(),
});

type WriteContextFileInput = z.infer<typeof WriteContextFileArgsSchema>;

interface WriteContextFileOutput {
  message: string;
}

/**
 * Core implementation of write_context_file functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeWriteContextFile(
  input: WriteContextFileInput,
  context: ExecutionContext
): Promise<WriteContextFileOutput> {
  logger.debug("write_context_file called", { input });

  const { filename: rawFilename, content, title, changelog } = input;

  // Extract just the filename from any path
  const filename = path.basename(rawFilename);

  // Only allow markdown files
  if (!filename.endsWith(".md")) {
    throw new Error("Only markdown files (.md) can be written to the context directory");
  }

  // Construct the full path
  const contextDir = path.join(context.projectPath, "context");
  const fullPath = path.join(contextDir, filename);

  // Check if this file was recently read from persisted conversation metadata
  const conversation = context.conversationCoordinator.getConversation(context.conversationId);
  const readFiles = conversation?.metadata?.readFiles || [];
  const contextPath = `context/${filename}`;
  const wasRecentlyRead = readFiles.includes(contextPath);

  // Check if file exists
  let fileExists = false;
  try {
    await access(fullPath);
    fileExists = true;
  } catch {
    // File doesn't exist, allow creation
    fileExists = false;
  }

  // If file exists and wasn't recently read, deny access
  if (fileExists && !wasRecentlyRead) {
    throw new Error(`You must read the file 'context/${filename}' before writing to it. Use the read_path tool first.`);
  }

  // Ensure context directory exists
  await mkdir(contextDir, { recursive: true });

  // Write the file
  await writeFile(fullPath, content, "utf-8");

  // Publish NDKArticle for this context file update
  try {
    const article = new NDKArticle(getNDK());

    // Use the filename without .md extension as the dTag
    const dTag = filename.replace(/\.md$/, "");
    article.dTag = dTag;

    // Set article properties
    article.title = title;
    article.content = content;
    article.published_at = Math.floor(Date.now() / 1000);

    // Tag the article with the project
    const projectCtx = getProjectContext();
    article.tag(projectCtx.project);

    // Sign with the agent's signer
    await context.agent.sign(article);
    await article.publish();

    logger.debug("Published NDKArticle for context file", { filename, dTag });

    // Publish status message with the Nostr reference to the article
    try {
      const conversation = context.conversationCoordinator.getConversation(context.conversationId);
      
      if (conversation?.history?.[0]) {
        const nostrReference = `nostr:${article.encode()}`;
        await context.agentPublisher.conversation(
          { content: `📝 Writing context file: ${nostrReference}` },
          {
            triggeringEvent: context.triggeringEvent,
            rootEvent: conversation.history[0],
            conversationId: context.conversationId,
          }
        );
      }
    } catch (statusError) {
      console.warn("Failed to publish write_context_file status:", statusError);
    }

    // If changelog is provided, create a NIP-22 reply
    if (changelog) {
      try {
        const reply = await article.reply();
        reply.content = changelog;
        reply.created_at = Math.floor(Date.now() / 1000);

        await context.agent.sign(reply);
        await reply.publish();

        logger.debug("Published changelog reply", { changelog, dTag });
      } catch (replyError) {
        logger.error("Failed to publish changelog reply", {
          error: formatAnyError(replyError),
        });
      }
    }
  } catch (error) {
    logger.error("Failed to publish NDKArticle", {
      error: formatAnyError(error),
    });
  }

  return {
    message: `Successfully wrote to context/${filename}`,
  };
}

/**
 * Create an AI SDK tool for writing context files
 */
export function createWriteContextFileTool(context: ExecutionContext): ReturnType<typeof tool> {
  return tool({
    description:
      "Write or update a specification file in the context/ directory. You must have read this file recently before writing to it.",
    
    inputSchema: WriteContextFileArgsSchema,
    
    execute: async (input: WriteContextFileInput) => {
      return await executeWriteContextFile(input, context);
    },
  });
}
