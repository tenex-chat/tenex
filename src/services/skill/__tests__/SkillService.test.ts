import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import * as crypto from "node:crypto";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { SkillService } from "../SkillService";

// Mock NDK
const mockFetchEvents = mock(() => Promise.resolve(new Set<NDKEvent>()));
const mockFetchEvent = mock(() => Promise.resolve(null));

mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvents: mockFetchEvents,
        fetchEvent: mockFetchEvent,
    }),
}));

// Mock constants
mock.module("@/constants", () => ({
    getTenexBasePath: () => "/tmp/test-tenex",
}));

// Mock fs operations
const mockWriteFile = mock(() => Promise.resolve());
const mockMkdir = mock(() => Promise.resolve());
const mockAccess = mock(() => Promise.resolve());

mock.module("node:fs/promises", () => ({
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    access: mockAccess,
}));

// Mock fs lib
mock.module("@/lib/fs", () => ({
    ensureDirectory: () => Promise.resolve(),
}));

// Mock global fetch
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    mockFetch = mock(() =>
        Promise.resolve(
            new Response(Buffer.from("file content"), {
                status: 200,
                statusText: "OK",
            })
        )
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Reset mocks
    mockFetchEvents.mockClear();
    mockFetchEvent.mockClear();
    mockWriteFile.mockClear();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("SkillService", () => {
    describe("getInstance", () => {
        it("should return the same instance", () => {
            const instance1 = SkillService.getInstance();
            const instance2 = SkillService.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("fetchSkills", () => {
        it("should return empty result when no event IDs provided", async () => {
            const service = SkillService.getInstance();
            const result = await service.fetchSkills([]);

            expect(result).toEqual({
                skills: [],
                content: "",
            });
            expect(mockFetchEvents).not.toHaveBeenCalled();
        });

        it("should fetch and process skill events", async () => {
            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789abcdef";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "This is skill content";
            skillEvent.tags = [
                ["title", "Test Skill"],
                ["name", "test-skill"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789abcdef"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].content).toBe("This is skill content");
            expect(result.skills[0].title).toBe("Test Skill");
            expect(result.skills[0].name).toBe("test-skill");
            expect(result.skills[0].shortId).toBe("skill1234567");
            expect(result.content).toBe("This is skill content");
        });

        it("should filter out non-skill events", async () => {
            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Valid skill";
            skillEvent.tags = [];

            const otherEvent = new NDKEvent();
            otherEvent.id = "other123456789";
            otherEvent.kind = 1; // Regular text note
            otherEvent.content = "Not a skill";
            otherEvent.tags = [];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent, otherEvent]));

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789", "other123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].content).toBe("Valid skill");
        });

        it("should concatenate multiple skill contents", async () => {
            const skill1 = new NDKEvent();
            skill1.id = "skill111111111";
            skill1.kind = NDKKind.AgentSkill;
            skill1.content = "First skill";
            skill1.tags = [];

            const skill2 = new NDKEvent();
            skill2.id = "skill222222222";
            skill2.kind = NDKKind.AgentSkill;
            skill2.content = "Second skill";
            skill2.tags = [];

            mockFetchEvents.mockResolvedValueOnce(new Set([skill1, skill2]));

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill111111111", "skill222222222"]);

            expect(result.skills).toHaveLength(2);
            expect(result.content).toContain("First skill");
            expect(result.content).toContain("Second skill");
            expect(result.content).toBe("First skill\n\nSecond skill");
        });

        it("should return empty result on fetch error", async () => {
            mockFetchEvents.mockRejectedValueOnce(new Error("Network error"));

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123"]);

            expect(result).toEqual({
                skills: [],
                content: "",
            });
        });
    });

    describe("fetchSkill", () => {
        it("should return null when event not found", async () => {
            mockFetchEvents.mockResolvedValueOnce(new Set());

            const service = SkillService.getInstance();
            const result = await service.fetchSkill("nonexistent");

            expect(result).toBeNull();
        });

        it("should return the skill event when found", async () => {
            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill content";
            skillEvent.tags = [];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));

            const service = SkillService.getInstance();
            const result = await service.fetchSkill("skill123");

            expect(result).toBe(skillEvent);
        });

        it("should return null for non-skill events", async () => {
            const otherEvent = new NDKEvent();
            otherEvent.id = "other123";
            otherEvent.kind = 1; // Regular text note
            otherEvent.content = "Not a skill";
            otherEvent.tags = [];

            mockFetchEvents.mockResolvedValueOnce(new Set([otherEvent]));

            const service = SkillService.getInstance();
            const result = await service.fetchSkill("other123");

            expect(result).toBeNull();
        });
    });

    describe("file handling", () => {
        it("should download and install files referenced in skill events", async () => {
            // Create file metadata event (kind:1063)
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/helper.py"],
                ["m", "text/x-python"],
            ];

            // Create skill event with reference to file
            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with files";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
            expect(result.skills[0].installedFiles[0].relativePath).toBe("scripts/helper.py");
            expect(mockFetch).toHaveBeenCalledWith(
                "https://blossom.example.com/abc123",
                expect.any(Object)
            );
        });

        it("should handle file download failures gracefully", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/helper.py"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with files";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);
            mockFetch.mockResolvedValueOnce(
                new Response(null, { status: 404, statusText: "Not Found" })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Failed to download");
        });

        it("should handle missing file metadata event", async () => {
            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with files";
            skillEvent.tags = [
                ["e", "nonexistent-file"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(null);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Could not fetch event");
        });

        it("should handle non-1063 events referenced by e-tags", async () => {
            const nonFileEvent = new NDKEvent();
            nonFileEvent.id = "event123456789";
            nonFileEvent.kind = 1; // Not a file metadata event
            nonFileEvent.content = "Some text";
            nonFileEvent.tags = [];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill content";
            skillEvent.tags = [
                ["e", "event123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(nonFileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("not kind:1063");
        });

        it("should handle file metadata event missing required tags", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                // Missing url and name tags
                ["m", "text/plain"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill content";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Missing required tags");
        });
    });

    describe("security: path traversal protection", () => {
        it("should reject paths with ../ that escape skill directory", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "../../../etc/passwd"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Malicious skill";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Security violation");
            expect(result.skills[0].installedFiles[0].error).toContain("escape skill directory");
        });

        it("should reject paths with encoded traversal like ../abc that still escape", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                // This could trick startsWith check: /skills/abc/../../../outside
                ["name", "../../../outside/file.txt"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Malicious skill";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Security violation");
        });

        it("should reject absolute paths", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "/etc/passwd"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Malicious skill";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("Security violation");
        });

        it("should allow valid nested paths", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "scripts/lib/helper.py"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Valid skill";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
            expect(result.skills[0].installedFiles[0].relativePath).toBe("scripts/lib/helper.py");
        });
    });

    describe("security: SHA-256 hash verification", () => {
        it("should pass when SHA-256 hash matches", async () => {
            const fileContent = "test file content";
            const correctHash = crypto.createHash("sha256").update(fileContent).digest("hex");

            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "script.py"],
                ["x", correctHash],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with verified file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);
            mockFetch.mockResolvedValueOnce(
                new Response(Buffer.from(fileContent), {
                    status: 200,
                    statusText: "OK",
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
        });

        it("should fail when SHA-256 hash does not match", async () => {
            const fileContent = "actual content";
            const wrongHash = crypto.createHash("sha256").update("different content").digest("hex");

            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "script.py"],
                ["x", wrongHash],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with tampered file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);
            mockFetch.mockResolvedValueOnce(
                new Response(Buffer.from(fileContent), {
                    status: 200,
                    statusText: "OK",
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("SHA-256 hash mismatch");
        });

        it("should handle case-insensitive hash comparison", async () => {
            const fileContent = "test content";
            const hash = crypto.createHash("sha256").update(fileContent).digest("hex");
            // Use uppercase version
            const upperHash = hash.toUpperCase();

            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "script.py"],
                ["x", upperHash],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);
            mockFetch.mockResolvedValueOnce(
                new Response(Buffer.from(fileContent), {
                    status: 200,
                    statusText: "OK",
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
        });

        it("should succeed without hash when x tag is not present", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/abc123"],
                ["name", "script.py"],
                // No x tag
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill without hash";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
        });
    });

    describe("security: download size limit", () => {
        it("should reject downloads exceeding 10MB via Content-Length header", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/large-file"],
                ["name", "huge.bin"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with large file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            // Return response with Content-Length > 10MB
            const headers = new Headers();
            headers.set("Content-Length", String(11 * 1024 * 1024)); // 11MB
            mockFetch.mockResolvedValueOnce(
                new Response(null, {
                    status: 200,
                    statusText: "OK",
                    headers,
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("File too large");
            expect(result.skills[0].installedFiles[0].error).toContain("byte limit");
        });

        it("should reject downloads exceeding 10MB during streaming", async () => {
            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/large-file"],
                ["name", "huge.bin"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with large file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);

            // Create a ReadableStream that yields chunks exceeding 10MB total
            // No Content-Length header to bypass that check
            let chunkCount = 0;
            const chunkSize = 1024 * 1024; // 1MB chunks
            const maxChunks = 12; // 12MB total, exceeds limit
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (chunkCount >= maxChunks) {
                        controller.close();
                        return;
                    }
                    chunkCount++;
                    controller.enqueue(new Uint8Array(chunkSize).fill(0));
                },
            });

            mockFetch.mockResolvedValueOnce(
                new Response(stream, {
                    status: 200,
                    statusText: "OK",
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(false);
            expect(result.skills[0].installedFiles[0].error).toContain("File too large");
            expect(result.skills[0].installedFiles[0].error).toContain("exceeded");
        });

        it("should allow downloads under 10MB", async () => {
            const smallContent = Buffer.alloc(1024, "x"); // 1KB

            const fileEvent = new NDKEvent();
            fileEvent.id = "file123456789";
            fileEvent.kind = 1063;
            fileEvent.content = "";
            fileEvent.tags = [
                ["url", "https://blossom.example.com/small-file"],
                ["name", "small.txt"],
            ];

            const skillEvent = new NDKEvent();
            skillEvent.id = "skill123456789";
            skillEvent.kind = NDKKind.AgentSkill;
            skillEvent.content = "Skill with small file";
            skillEvent.tags = [
                ["e", "file123456789"],
            ];

            mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));
            mockFetchEvent.mockResolvedValueOnce(fileEvent);
            mockFetch.mockResolvedValueOnce(
                new Response(smallContent, {
                    status: 200,
                    statusText: "OK",
                })
            );

            const service = SkillService.getInstance();
            const result = await service.fetchSkills(["skill123456789"]);

            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].installedFiles).toHaveLength(1);
            expect(result.skills[0].installedFiles[0].success).toBe(true);
        });
    });
});
