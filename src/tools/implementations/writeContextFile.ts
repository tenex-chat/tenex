import { mkdir, writeFile, access } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { getProjectContext } from "@/services";

const WriteContextFileArgsSchema = z.object({
    filename: z.string().min(1, "filename must be a non-empty string"),
    content: z.string().min(1, "content must be a non-empty string"),
    title: z.string().min(1, "title must be a non-empty string"),
    changelog: z.string().optional(),
});

interface WriteContextFileInput {
    filename: string;
    content: string;
    title: string;
    changelog?: string;
}

interface WriteContextFileOutput {
    message: string;
}

export const writeContextFileTool: Tool<WriteContextFileInput, WriteContextFileOutput> = {
    name: "write_context_file",
    description:
        "Write or update a specification file in the context/ directory. You must have read this file recently before writing to it.",

    promptFragment: `
**IMPORTANT: Before using write_context_file:**
1. You MUST first use the read_path tool to read the file from the context/ directory
2. The system tracks which files you've read - if you haven't read the file recently, the write will be rejected
3. This ensures you understand the current content before making changes
4. If the file doesn't exist yet, you can create it without reading first

Example workflow:
- To update context/PROJECT.md:
  1. First: Use read_path with path "context/PROJECT.md"
  2. Then: Use write_context_file with your updated content
- Creating a new file doesn't require reading first
`,

    parameters: createZodSchema(WriteContextFileArgsSchema),

    execute: async (input, context) => {
        logger.debug("write_context_file called", { input });

        const { filename: rawFilename, content, title, changelog } = input.value;

        // Agent role check: Only project-manager should use this tool
        // This is enforced at the agent configuration level

        // Extract just the filename from any path
        // If given ../../context/TEST.md or TEST.md, just use TEST.md
        const filename = path.basename(rawFilename);

        // Only allow markdown files
        if (!filename.endsWith(".md")) {
            return {
                ok: false,
                error: {
                    kind: "validation" as const,
                    field: "filename",
                    message: "Only markdown files (.md) can be written to the context directory",
                },
            };
        }

        try {
            // Construct the full path
            const contextDir = path.join(context.projectPath, "context");
            const fullPath = path.join(contextDir, filename);

            // Check if this file was recently read from persisted conversation metadata
            const conversation = context.conversationManager.getConversation(
                context.conversationId
            );
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
                return {
                    ok: false,
                    error: {
                        kind: "validation" as const,
                        field: "filename",
                        message: `You must read the file 'context/${filename}' before writing to it. Use the read_path tool first.`,
                    },
                };
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
                await article.sign(context.agent.signer);
                await article.publish();

                logger.debug("Published NDKArticle for context file", { filename, dTag });

                // If changelog is provided, create a NIP-22 reply
                if (changelog) {
                    try {
                        // Create a reply to the spec article event
                        const reply = await article.reply();
                        reply.content = changelog;
                        reply.created_at = Math.floor(Date.now() / 1000);
                        
                        // Sign and publish the reply
                        await reply.sign(context.agent.signer);
                        await reply.publish();
                        
                        logger.debug("Published changelog reply", { changelog, dTag });
                    } catch (replyError) {
                        logger.error("Failed to publish changelog reply", {
                            error: formatAnyError(replyError),
                        });
                    }
                }
            } catch (error) {
                // Log error but don't fail the tool execution
                logger.error("Failed to publish NDKArticle", {
                    error: formatAnyError(error),
                });
            }

            return {
                ok: true,
                value: {
                    message: `Successfully wrote to context/${filename}`,
                },
            };
        } catch (error) {
            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "write_context_file",
                    message: `Failed to write file: ${formatAnyError(error)}`,
                },
            };
        }
    },
};
