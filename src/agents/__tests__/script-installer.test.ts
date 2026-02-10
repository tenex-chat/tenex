import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import {
    extractScriptFileInfo,
    installScriptFile,
    installAgentScripts,
    type ScriptFileInfo,
} from "../script-installer";
import { getAgentHomeDirectory } from "@/lib/agent-home";

describe("script-installer", () => {
    describe("extractScriptFileInfo", () => {
        it("should extract script info from a valid kind 1063 event", () => {
            const event = new NDKEvent();
            event.kind = 1063;
            event.id = "test-event-id";
            event.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/research.py"],
                ["m", "text/x-python"],
                ["x", "sha256hash123"],
            ];

            const info = extractScriptFileInfo(event);

            expect(info).not.toBeNull();
            expect(info?.eventId).toBe("test-event-id");
            expect(info?.url).toBe("https://blossom.example.com/abc123");
            expect(info?.relativePath).toBe("scripts/research.py");
            expect(info?.mimeType).toBe("text/x-python");
            expect(info?.sha256).toBe("sha256hash123");
        });

        it("should return null for non-1063 events", () => {
            const event = new NDKEvent();
            event.kind = 1;
            event.id = "test-event-id";
            event.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/research.py"],
            ];

            const info = extractScriptFileInfo(event);

            expect(info).toBeNull();
        });

        it("should return null when url tag is missing", () => {
            const event = new NDKEvent();
            event.kind = 1063;
            event.id = "test-event-id";
            event.tags = [["name", "scripts/research.py"]];

            const info = extractScriptFileInfo(event);

            expect(info).toBeNull();
        });

        it("should return null when name tag is missing", () => {
            const event = new NDKEvent();
            event.kind = 1063;
            event.id = "test-event-id";
            event.tags = [["url", "https://blossom.example.com/abc123"]];

            const info = extractScriptFileInfo(event);

            expect(info).toBeNull();
        });

        it("should handle optional tags being missing", () => {
            const event = new NDKEvent();
            event.kind = 1063;
            event.id = "test-event-id";
            event.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/research.py"],
            ];

            const info = extractScriptFileInfo(event);

            expect(info).not.toBeNull();
            expect(info?.mimeType).toBeUndefined();
            expect(info?.sha256).toBeUndefined();
        });
    });

    describe("installScriptFile", () => {
        // Use a real test pubkey to get a real home directory
        const testPubkey = "0000000000000000000000000000000000000000000000000000000000000001";
        let testHomeDir: string;
        let originalFetch: typeof global.fetch;

        beforeEach(async () => {
            testHomeDir = getAgentHomeDirectory(testPubkey);
            // Clean up any existing test files
            try {
                await fs.rm(testHomeDir, { recursive: true, force: true });
            } catch {
                // Directory might not exist
            }
            // Save original fetch
            originalFetch = global.fetch;
        });

        afterEach(async () => {
            // Restore fetch
            global.fetch = originalFetch;
            // Clean up test files
            try {
                await fs.rm(testHomeDir, { recursive: true, force: true });
            } catch {
                // Ignore errors
            }
        });

        it("should install a script file to the correct path", async () => {
            const mockContent = "#!/bin/bash\necho 'Hello World'";
            global.fetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mockContent).buffer),
                } as Response)
            );

            const scriptInfo: ScriptFileInfo = {
                eventId: "test-event-id",
                url: "https://blossom.example.com/abc123",
                relativePath: "scripts/test.sh",
            };

            const result = await installScriptFile(scriptInfo, testPubkey);

            expect(result.success).toBe(true);
            expect(result.relativePath).toBe("scripts/test.sh");
            expect(result.absolutePath).toBe(path.join(testHomeDir, "scripts/test.sh"));

            // Verify file was created
            const content = await fs.readFile(result.absolutePath, "utf-8");
            expect(content).toBe(mockContent);

            // Verify script is executable
            const stats = await fs.stat(result.absolutePath);
            expect(stats.mode & 0o755).toBe(0o755);
        });

        it("should create parent directories as needed", async () => {
            const mockContent = "test content";
            global.fetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mockContent).buffer),
                } as Response)
            );

            const scriptInfo: ScriptFileInfo = {
                eventId: "test-event-id",
                url: "https://blossom.example.com/abc123",
                relativePath: "deep/nested/path/file.txt",
            };

            const result = await installScriptFile(scriptInfo, testPubkey);

            expect(result.success).toBe(true);

            // Verify parent directories were created
            const parentDir = path.dirname(result.absolutePath);
            const parentStats = await fs.stat(parentDir);
            expect(parentStats.isDirectory()).toBe(true);
        });

        it("should reject paths that escape the home directory", async () => {
            const scriptInfo: ScriptFileInfo = {
                eventId: "test-event-id",
                url: "https://blossom.example.com/abc123",
                relativePath: "../../../etc/passwd",
            };

            const result = await installScriptFile(scriptInfo, testPubkey);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Security violation");
        });

        it("should handle download failures gracefully", async () => {
            global.fetch = mock(() =>
                Promise.resolve({
                    ok: false,
                    status: 404,
                    statusText: "Not Found",
                } as Response)
            );

            const scriptInfo: ScriptFileInfo = {
                eventId: "test-event-id",
                url: "https://blossom.example.com/nonexistent",
                relativePath: "scripts/test.sh",
            };

            const result = await installScriptFile(scriptInfo, testPubkey);

            expect(result.success).toBe(false);
            expect(result.error).toContain("Failed to download");
        });

        it("should not make scripts executable for non-script extensions", async () => {
            const mockContent = '{ "key": "value" }';
            global.fetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mockContent).buffer),
                } as Response)
            );

            const scriptInfo: ScriptFileInfo = {
                eventId: "test-event-id",
                url: "https://blossom.example.com/abc123",
                relativePath: "config/settings.json",
            };

            const result = await installScriptFile(scriptInfo, testPubkey);

            expect(result.success).toBe(true);

            // Verify file was created
            const stats = await fs.stat(result.absolutePath);
            // The execute bit should not be set for owner
            expect(stats.mode & 0o100).toBe(0);
        });
    });

    describe("installAgentScripts", () => {
        const testPubkey = "0000000000000000000000000000000000000000000000000000000000000002";
        let testHomeDir: string;
        let originalFetch: typeof global.fetch;

        beforeEach(async () => {
            testHomeDir = getAgentHomeDirectory(testPubkey);
            // Clean up any existing test files
            try {
                await fs.rm(testHomeDir, { recursive: true, force: true });
            } catch {
                // Directory might not exist
            }
            // Save original fetch
            originalFetch = global.fetch;
        });

        afterEach(async () => {
            // Restore fetch
            global.fetch = originalFetch;
            // Clean up test files
            try {
                await fs.rm(testHomeDir, { recursive: true, force: true });
            } catch {
                // Ignore errors
            }
        });

        it("should return empty array when no script e-tags provided", async () => {
            const mockNdk = {
                fetchEvent: mock(() => Promise.resolve(null)),
            };

            const results = await installAgentScripts([], testPubkey, mockNdk as never);

            expect(results).toEqual([]);
        });

        it("should handle event fetch failures", async () => {
            const mockNdk = {
                fetchEvent: mock(() => Promise.resolve(null)),
            };

            const scriptETags = [{ eventId: "nonexistent-event-id" }];

            const results = await installAgentScripts(scriptETags, testPubkey, mockNdk as never);

            expect(results.length).toBe(1);
            expect(results[0].success).toBe(false);
            expect(results[0].error).toContain("Could not fetch event");
        });

        it("should handle invalid 1063 events", async () => {
            // Create a mock event that's kind 1063 but missing required tags
            const invalidEvent = new NDKEvent();
            invalidEvent.kind = 1063;
            invalidEvent.id = "invalid-event-id";
            invalidEvent.tags = []; // Missing url and name tags

            const mockNdk = {
                fetchEvent: mock(() => Promise.resolve(invalidEvent)),
            };

            const scriptETags = [{ eventId: "invalid-event-id" }];

            const results = await installAgentScripts(scriptETags, testPubkey, mockNdk as never);

            expect(results.length).toBe(1);
            expect(results[0].success).toBe(false);
            expect(results[0].error).toContain("not a valid kind 1063");
        });

        it("should install multiple scripts", async () => {
            const mockContent = "test content";
            global.fetch = mock(() =>
                Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(mockContent).buffer),
                } as Response)
            );

            // Create mock events
            const event1 = new NDKEvent();
            event1.kind = 1063;
            event1.id = "event-1";
            event1.tags = [
                ["url", "https://blossom.example.com/file1"],
                ["name", "scripts/script1.py"],
            ];

            const event2 = new NDKEvent();
            event2.kind = 1063;
            event2.id = "event-2";
            event2.tags = [
                ["url", "https://blossom.example.com/file2"],
                ["name", "scripts/script2.sh"],
            ];

            const mockNdk = {
                fetchEvent: mock((eventId: string) => {
                    if (eventId === "event-1") return Promise.resolve(event1);
                    if (eventId === "event-2") return Promise.resolve(event2);
                    return Promise.resolve(null);
                }),
            };

            const scriptETags = [{ eventId: "event-1" }, { eventId: "event-2" }];

            const results = await installAgentScripts(scriptETags, testPubkey, mockNdk as never);

            expect(results.length).toBe(2);
            expect(results[0].success).toBe(true);
            expect(results[0].relativePath).toBe("scripts/script1.py");
            expect(results[1].success).toBe(true);
            expect(results[1].relativePath).toBe("scripts/script2.sh");

            // Verify both files exist
            const file1Exists = await fs.access(results[0].absolutePath).then(() => true).catch(() => false);
            const file2Exists = await fs.access(results[1].absolutePath).then(() => true).catch(() => false);
            expect(file1Exists).toBe(true);
            expect(file2Exists).toBe(true);
        });
    });
});
