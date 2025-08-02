import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { writeContextFileTool } from "../writeContextFile";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import * as path from "node:path";
import type { ToolContext } from "@/tools/types";

// Mock logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(() => {}),
        error: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {})
    }
}));

// Mock Nostr-related modules
mock.module("@/nostr", () => ({
    getNDK: mock(() => ({}))
}));

mock.module("@/services", () => ({
    getProjectContext: mock(() => ({
        project: { id: "test-project" }
    }))
}));

// Mock NDKArticle
const mockNDKArticle = {
    sign: mock(async () => {}),
    publish: mock(async () => {}),
    tag: mock(() => {}),
    dTag: undefined as string | undefined,
    title: undefined as string | undefined,
    content: undefined as string | undefined,
    published_at: undefined as number | undefined
};

mock.module("@nostr-dev-kit/ndk", () => {
    const MockNDKArticle = function(this: any) {
        // Store a reference to this instance in mockNDKArticle
        this.dTag = undefined;
        this.title = undefined;
        this.content = undefined;
        this.published_at = undefined;
        this.sign = mockNDKArticle.sign;
        this.publish = mockNDKArticle.publish;
        this.tag = mockNDKArticle.tag;
        
        // Override property definitions to capture values
        Object.defineProperty(this, 'dTag', {
            get() { return mockNDKArticle.dTag; },
            set(value: string | undefined) { mockNDKArticle.dTag = value; }
        });
        Object.defineProperty(this, 'title', {
            get() { return mockNDKArticle.title; },
            set(value: string | undefined) { mockNDKArticle.title = value; }
        });
        Object.defineProperty(this, 'content', {
            get() { return mockNDKArticle.content; },
            set(value: string | undefined) { mockNDKArticle.content = value; }
        });
        Object.defineProperty(this, 'published_at', {
            get() { return mockNDKArticle.published_at; },
            set(value: number | undefined) { mockNDKArticle.published_at = value; }
        });
    };
    
    return { NDKArticle: MockNDKArticle };
});

describe("writeContextFile tool", () => {
    let testDir: string;
    let context: ToolContext;
    let contextPath: string;
    let mockConversationManager: any;

    beforeEach(async () => {
        testDir = await createTempDir();
        contextPath = path.join(testDir, "context");
        
        // Reset mocks
        mockNDKArticle.sign.mockClear();
        mockNDKArticle.publish.mockClear();
        mockNDKArticle.tag.mockClear();
        mockNDKArticle.dTag = undefined;
        mockNDKArticle.title = undefined;
        mockNDKArticle.content = undefined;
        mockNDKArticle.published_at = undefined;
        
        // Reset publish and sign implementations
        mockNDKArticle.publish = mock(async () => {});
        mockNDKArticle.sign = mock(async () => {});
        
        // Create mock conversation manager
        mockConversationManager = {
            getConversation: mock(() => ({
                metadata: {
                    readFiles: []
                }
            }))
        };
        
        // Create test context
        context = {
            projectPath: testDir,
            conversationId: "test-conv-123",
            phase: "EXECUTE",
            agent: { 
                name: "TestAgent", 
                slug: "test-agent", 
                pubkey: "pubkey123",
                signer: mock(() => {})
            },
            conversationManager: mockConversationManager,
        } as any;
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    describe("validation", () => {
        it("should reject non-markdown files", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.txt",
                    content: "test content",
                    title: "Test Title"
                }
            }, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("validation");
                expect(result.error.message).toContain("Only markdown files (.md)");
            }
        });

        it("should handle path traversal attempts by extracting basename", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "../../context/TEST.md",
                    content: "test content",
                    title: "Test Title"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify file was written to correct location
            const filePath = path.join(contextPath, "TEST.md");
            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("test content");
        });
    });

    describe("file access control", () => {
        it("should allow writing to a file that was recently read", async () => {
            // Create context directory and existing file
            mkdirSync(contextPath, { recursive: true });
            const filename = "existing-file.md";
            const filePath = path.join(contextPath, filename);
            writeFileSync(filePath, "original content");

            // Update mock to include file in readFiles
            mockConversationManager.getConversation = mock(() => ({
                metadata: {
                    readFiles: [`context/${filename}`]
                }
            }));

            const result = await writeContextFileTool.execute({
                value: {
                    filename,
                    content: "updated content",
                    title: "Updated Title"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify file was updated
            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("updated content");
        });

        it("should deny writing to an existing file that wasn't recently read", async () => {
            // Create context directory and existing file
            mkdirSync(contextPath, { recursive: true });
            const filename = "unread-file.md";
            const filePath = path.join(contextPath, filename);
            writeFileSync(filePath, "original content");

            // Mock has empty readFiles by default

            const result = await writeContextFileTool.execute({
                value: {
                    filename,
                    content: "new content",
                    title: "New Title"
                }
            }, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("validation");
                expect(result.error.message).toContain("You must read the file");
                expect(result.error.message).toContain(`context/${filename}`);
            }

            // Verify file was not modified
            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("original content");
        });

        it("should allow creating new files without reading them first", async () => {
            const filename = "new-file.md";
            const filePath = path.join(contextPath, filename);

            const result = await writeContextFileTool.execute({
                value: {
                    filename,
                    content: "new content",
                    title: "New File"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify file was created
            const content = readFileSync(filePath, "utf-8");
            expect(content).toBe("new content");
        });

        it("should handle missing metadata gracefully", async () => {
            // Create existing file
            mkdirSync(contextPath, { recursive: true });
            const filename = "test.md";
            const filePath = path.join(contextPath, filename);
            writeFileSync(filePath, "original content");

            // Mock conversation with no metadata
            mockConversationManager.getConversation = mock(() => ({
                metadata: undefined
            }));

            const result = await writeContextFileTool.execute({
                value: {
                    filename,
                    content: "content",
                    title: "Title"
                }
            }, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.message).toContain("You must read the file");
            }
        });
    });

    describe("file operations", () => {
        it("should create context directory if it doesn't exist", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.md",
                    content: "content",
                    title: "Title"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify directory was created
            expect(existsSync(contextPath)).toBe(true);
        });

        it("should handle file write errors gracefully", async () => {
            // Create a file with the same name as the directory we want to create
            writeFileSync(path.join(testDir, "context"), "this is a file, not a directory");

            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.md",
                    content: "content",
                    title: "Title"
                }
            }, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe("execution");
                expect(result.error.message).toContain("Failed to write file");
            }
        });

        it("should handle permission errors", async () => {
            // Create context directory
            mkdirSync(contextPath, { recursive: true });
            
            // Make directory read-only (no write permission)
            try {
                chmodSync(contextPath, 0o444);

                const result = await writeContextFileTool.execute({
                    value: {
                        filename: "test.md",
                        content: "content",
                        title: "Title"
                    }
                }, context);

                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.kind).toBe("execution");
                    expect(result.error.message).toContain("Failed to write file");
                }
            } finally {
                // Restore permissions
                chmodSync(contextPath, 0o755);
            }
        });
    });

    describe("NDKArticle publishing", () => {
        it("should publish NDKArticle on successful file write", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test-doc.md",
                    content: "# Test Documentation\n\nContent here",
                    title: "Test Documentation"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify NDKArticle properties were set
            expect(mockNDKArticle.dTag).toBe("test-doc");
            expect(mockNDKArticle.title).toBe("Test Documentation");
            expect(mockNDKArticle.content).toBe("# Test Documentation\n\nContent here");
            expect(mockNDKArticle.published_at).toBeGreaterThan(0);
            
            // Verify article methods were called
            expect(mockNDKArticle.tag).toHaveBeenCalledWith({ id: "test-project" });
            expect(mockNDKArticle.sign).toHaveBeenCalledWith(context.agent.signer);
            expect(mockNDKArticle.publish).toHaveBeenCalled();
        });

        it("should continue execution even if NDKArticle publishing fails", async () => {
            // Make publish throw an error
            mockNDKArticle.publish = mock(async () => {
                throw new Error("Network error");
            });

            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.md",
                    content: "content",
                    title: "Title"
                }
            }, context);

            // Tool should still succeed
            expect(result.ok).toBe(true);
            
            // File should have been written
            const filePath = path.join(contextPath, "test.md");
            expect(existsSync(filePath)).toBe(true);
        });

        it("should handle signing errors gracefully", async () => {
            // Make sign throw an error
            mockNDKArticle.sign = mock(async () => {
                throw new Error("Signing failed");
            });

            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.md",
                    content: "content",
                    title: "Title"
                }
            }, context);

            // Tool should still succeed (error is logged but not thrown)
            expect(result.ok).toBe(true);
            
            // File should have been written
            const filePath = path.join(contextPath, "test.md");
            expect(existsSync(filePath)).toBe(true);
        });

        it("should extract dTag from filename without .md extension", async () => {
            await writeContextFileTool.execute({
                value: {
                    filename: "project-spec.md",
                    content: "content",
                    title: "Project Specification"
                }
            }, context);

            expect(mockNDKArticle.dTag).toBe("project-spec");
        });
    });

    describe("success scenarios", () => {
        it("should return success message with correct path", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "README.md",
                    content: "# Project README",
                    title: "Project README"
                }
            }, context);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.message).toBe("Successfully wrote to context/README.md");
            }
        });
    });

    describe("edge cases", () => {
        it("should handle empty readFiles array", async () => {
            // Create existing file
            mkdirSync(contextPath, { recursive: true });
            const filename = "test.md";
            const filePath = path.join(contextPath, filename);
            writeFileSync(filePath, "original content");

            // Mock with empty readFiles (default)

            const result = await writeContextFileTool.execute({
                value: {
                    filename,
                    content: "content",
                    title: "Title"
                }
            }, context);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.message).toContain("You must read the file");
            }
        });

        it("should handle null conversation", async () => {
            mockConversationManager.getConversation = mock(() => null);

            const result = await writeContextFileTool.execute({
                value: {
                    filename: "test.md",
                    content: "content",
                    title: "Title"
                }
            }, context);

            // Should still work for new files
            expect(result.ok).toBe(true);
        });

        it("should handle filename with multiple dots", async () => {
            const result = await writeContextFileTool.execute({
                value: {
                    filename: "version.1.2.3.md",
                    content: "content",
                    title: "Version 1.2.3"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify file was created
            const filePath = path.join(contextPath, "version.1.2.3.md");
            expect(existsSync(filePath)).toBe(true);
        });

        it("should handle very long filenames", async () => {
            const longFilename = "a".repeat(200) + ".md";
            
            const result = await writeContextFileTool.execute({
                value: {
                    filename: longFilename,
                    content: "content",
                    title: "Long filename test"
                }
            }, context);

            expect(result.ok).toBe(true);
            
            // Verify file was created with the long name
            const filePath = path.join(contextPath, longFilename);
            expect(existsSync(filePath)).toBe(true);
        });
    });
});