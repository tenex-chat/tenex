import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LocalReportStore, InvalidSlugError } from "../LocalReportStore";

describe("LocalReportStore", () => {
    // Use a unique test directory for ALL tests in this suite
    const suiteTestDir = join(tmpdir(), `local-report-store-suite-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    let testDir: string;
    let originalEnv: string | undefined;
    let store: LocalReportStore;

    beforeAll(() => {
        // Save env at suite start
        originalEnv = process.env.TENEX_BASE_DIR;
    });

    afterAll(() => {
        // Restore env at suite end
        if (originalEnv !== undefined) {
            process.env.TENEX_BASE_DIR = originalEnv;
        } else {
            delete process.env.TENEX_BASE_DIR;
        }
    });

    beforeEach(() => {
        // Create a unique test directory for each test
        testDir = join(suiteTestDir, `test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        mkdirSync(testDir, { recursive: true });

        // Set env BEFORE creating the store
        process.env.TENEX_BASE_DIR = testDir;

        // Create a fresh instance (not the singleton) AFTER setting env
        store = new LocalReportStore();
    });

    afterEach(() => {
        // Clean up test directory
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe("validateSlug", () => {
        it("should accept valid slugs", () => {
            expect(() => store.validateSlug("my-report")).not.toThrow();
            expect(() => store.validateSlug("my_report")).not.toThrow();
            expect(() => store.validateSlug("MyReport123")).not.toThrow();
            expect(() => store.validateSlug("a")).not.toThrow();
        });

        it("should reject empty slugs", () => {
            expect(() => store.validateSlug("")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("   ")).toThrow(InvalidSlugError);
        });

        it("should reject slugs with path separators", () => {
            expect(() => store.validateSlug("../escape")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("path/to/file")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("path\\to\\file")).toThrow(InvalidSlugError);
        });

        it("should reject slugs with parent directory references", () => {
            expect(() => store.validateSlug("..")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("foo..bar")).toThrow(InvalidSlugError);
        });

        it("should reject slugs starting or ending with dots", () => {
            expect(() => store.validateSlug(".hidden")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("file.")).toThrow(InvalidSlugError);
        });

        it("should reject slugs with special characters", () => {
            expect(() => store.validateSlug("my report")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("my@report")).toThrow(InvalidSlugError);
            expect(() => store.validateSlug("my#report")).toThrow(InvalidSlugError);
        });
    });

    describe("getReportPath", () => {
        it("should return path within reports directory for valid slug", () => {
            const path = store.getReportPath("my-report");
            expect(path).toBe(join(testDir, "reports", "my-report.md"));
        });

        it("should throw for invalid slugs", () => {
            expect(() => store.getReportPath("../escape")).toThrow(InvalidSlugError);
            expect(() => store.getReportPath("path/traversal")).toThrow(InvalidSlugError);
        });
    });

    describe("isPathInReportsDir", () => {
        it("should detect paths within reports directory", () => {
            const reportsDir = store.getReportsDir();

            expect(store.isPathInReportsDir(join(reportsDir, "file.md"))).toBe(true);
            expect(store.isPathInReportsDir(join(reportsDir, "subdir", "file.md"))).toBe(true);
            expect(store.isPathInReportsDir(reportsDir)).toBe(true);
        });

        it("should not flag paths outside reports directory", () => {
            expect(store.isPathInReportsDir(join(testDir, "other", "file.md"))).toBe(false);
            expect(store.isPathInReportsDir("/tmp/something/reports/file.md")).toBe(false);
        });

        it("should handle edge cases with similar directory names", () => {
            // Ensure "reports-backup" doesn't match "reports"
            expect(store.isPathInReportsDir(join(testDir, "reports-backup", "file.md"))).toBe(false);
        });
    });

    describe("writeReport and readReport", () => {
        it("should write and read reports correctly", async () => {
            const metadata = {
                addressableRef: "30023:pubkey:test-slug",
                createdAt: Math.floor(Date.now() / 1000),
                slug: "test-slug",
            };

            await store.writeReport("test-slug", "# Test Content", metadata);

            const content = await store.readReport("test-slug");
            expect(content).toBe("# Test Content");
        });

        it("should reject invalid slugs on write", async () => {
            const metadata = {
                addressableRef: "30023:pubkey:bad",
                createdAt: Math.floor(Date.now() / 1000),
                slug: "../escape",
            };

            await expect(
                store.writeReport("../escape", "content", metadata)
            ).rejects.toThrow(InvalidSlugError);
        });

        it("should reject invalid slugs on read", async () => {
            await expect(store.readReport("../escape")).rejects.toThrow(InvalidSlugError);
        });

        it("should return null for non-existent reports", async () => {
            const content = await store.readReport("non-existent");
            expect(content).toBeNull();
        });
    });

    describe("hydrateFromNostr", () => {
        it("should hydrate new reports", async () => {
            const result = await store.hydrateFromNostr(
                "new-report",
                "# From Nostr",
                "30023:pubkey:new-report",
                Math.floor(Date.now() / 1000)
            );

            expect(result).toBe(true);
            const content = await store.readReport("new-report");
            expect(content).toBe("# From Nostr");
        });

        it("should hydrate if event is newer", async () => {
            const oldTimestamp = Math.floor(Date.now() / 1000) - 1000;
            const newTimestamp = Math.floor(Date.now() / 1000);

            // Write old version
            await store.writeReport("test-report", "# Old Content", {
                addressableRef: "30023:pubkey:test-report",
                createdAt: oldTimestamp,
                slug: "test-report",
            });

            // Hydrate with newer version
            const result = await store.hydrateFromNostr(
                "test-report",
                "# New Content",
                "30023:pubkey:test-report",
                newTimestamp
            );

            expect(result).toBe(true);
            const content = await store.readReport("test-report");
            expect(content).toBe("# New Content");
        });

        it("should not hydrate if event is older", async () => {
            const oldTimestamp = Math.floor(Date.now() / 1000) - 1000;
            const newTimestamp = Math.floor(Date.now() / 1000);

            // Write new version first
            await store.writeReport("test-report", "# New Content", {
                addressableRef: "30023:pubkey:test-report",
                createdAt: newTimestamp,
                slug: "test-report",
            });

            // Try to hydrate with older version
            const result = await store.hydrateFromNostr(
                "test-report",
                "# Old Content",
                "30023:pubkey:test-report",
                oldTimestamp
            );

            expect(result).toBe(false);
            const content = await store.readReport("test-report");
            expect(content).toBe("# New Content");
        });
    });
});
