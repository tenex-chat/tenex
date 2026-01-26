import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { LocalReportStore, InvalidSlugError } from "../LocalReportStore";

describe("LocalReportStore", () => {
    // Use a unique test directory for ALL tests in this suite
    const suiteTestDir = join(tmpdir(), `local-report-store-suite-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    const TEST_PROJECT_DTAG = "test-project";
    let testDir: string;
    let projectMetadataPath: string;
    let store: LocalReportStore;

    afterAll(() => {
        // Clean up the entire suite test directory
        try {
            rmSync(suiteTestDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    beforeEach(() => {
        // Create a unique test directory for each test
        testDir = join(suiteTestDir, `test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        // Project metadata path mirrors real structure: ~/.tenex/projects/<dTag>
        projectMetadataPath = join(testDir, "projects", TEST_PROJECT_DTAG);
        mkdirSync(projectMetadataPath, { recursive: true });

        // Create a fresh instance and initialize with project context
        store = new LocalReportStore();
        store.initialize(projectMetadataPath);
    });

    afterEach(() => {
        // Reset store state
        store.reset();
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
        it("should return path within project-scoped reports directory for valid slug", () => {
            const path = store.getReportPath("my-report");
            expect(path).toBe(join(testDir, "projects", TEST_PROJECT_DTAG, "reports", "my-report.md"));
        });

        it("should throw for invalid slugs", () => {
            expect(() => store.getReportPath("../escape")).toThrow(InvalidSlugError);
            expect(() => store.getReportPath("path/traversal")).toThrow(InvalidSlugError);
        });
    });

    describe("initialize", () => {
        it("should correctly parse project ID from metadata path", () => {
            const newStore = new LocalReportStore();
            newStore.initialize("/some/path/projects/my-project-dtag");
            expect(newStore.projectId).toBe("my-project-dtag");
            expect(newStore.isInitialized()).toBe(true);
        });

        it("should throw when getting reports dir without initialization", () => {
            const newStore = new LocalReportStore();
            expect(() => newStore.getReportsDir()).toThrow("LocalReportStore.initialize()");
        });

        it("should allow reset and re-initialization", () => {
            store.reset();
            expect(store.isInitialized()).toBe(false);
            store.initialize(projectMetadataPath);
            expect(store.isInitialized()).toBe(true);
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

        it("should reject reports-backup under SAME parent directory (prefix bypass)", () => {
            // This tests the original prefix-bypass vulnerability
            // /base/projects/test/reports-backup/file.md should NOT match /base/projects/test/reports/
            const projectDir = join(testDir, "projects", TEST_PROJECT_DTAG);
            const reportsBackupPath = join(projectDir, "reports-backup", "file.md");

            // Create the reports-backup directory to ensure it exists
            mkdirSync(join(projectDir, "reports-backup"), { recursive: true });

            expect(store.isPathInReportsDir(reportsBackupPath)).toBe(false);
        });

        it("should reject path traversal with .. segments", () => {
            const reportsDir = store.getReportsDir();

            // Attempt to escape using .. segments
            // /base/projects/test/reports/../../../etc/passwd should be rejected
            const traversalPath = join(reportsDir, "..", "..", "..", "etc", "passwd");
            expect(store.isPathInReportsDir(traversalPath)).toBe(false);

            // Even more basic traversal: reports/../other/file.md
            const simpleTraversal = join(reportsDir, "..", "other", "file.md");
            expect(store.isPathInReportsDir(simpleTraversal)).toBe(false);
        });

        it("should reject symlinks pointing outside reports directory", () => {
            const reportsDir = store.getReportsDir();
            const outsideDir = join(testDir, "outside-reports");

            // Create reports dir and an outside directory
            mkdirSync(reportsDir, { recursive: true });
            mkdirSync(outsideDir, { recursive: true });

            // Create a symlink inside reports that points outside
            const symlinkPath = join(reportsDir, "escape-link");
            try {
                symlinkSync(outsideDir, symlinkPath);

                // A path through the symlink should be rejected
                const escapePath = join(symlinkPath, "secret-file.md");
                expect(store.isPathInReportsDir(escapePath)).toBe(false);

                // The symlink itself should also be rejected as it resolves outside
                expect(store.isPathInReportsDir(symlinkPath)).toBe(false);
            } finally {
                // Clean up symlink
                try {
                    rmSync(symlinkPath);
                } catch {
                    // Ignore cleanup errors
                }
            }
        });

        it("should throw when not initialized", () => {
            const newStore = new LocalReportStore();
            // When not initialized, should throw to prevent silent bypass of protection
            expect(() => newStore.isPathInReportsDir("/any/path/reports/file.md")).toThrow(
                "LocalReportStore.isPathInReportsDir() called before initialization"
            );
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

    describe("multi-project isolation", () => {
        it("should isolate reports between different projects using same slug", async () => {
            // Create two separate stores for two different projects
            const projectAPath = join(testDir, "projects", "project-a");
            const projectBPath = join(testDir, "projects", "project-b");
            mkdirSync(projectAPath, { recursive: true });
            mkdirSync(projectBPath, { recursive: true });

            const storeA = new LocalReportStore();
            storeA.initialize(projectAPath);

            const storeB = new LocalReportStore();
            storeB.initialize(projectBPath);

            // Both projects write a report with the same slug
            const sameSlug = "shared-slug";

            await storeA.writeReport(sameSlug, "# Project A Content", {
                addressableRef: "30023:pubkeyA:shared-slug",
                createdAt: Math.floor(Date.now() / 1000),
                slug: sameSlug,
            });

            await storeB.writeReport(sameSlug, "# Project B Content", {
                addressableRef: "30023:pubkeyB:shared-slug",
                createdAt: Math.floor(Date.now() / 1000),
                slug: sameSlug,
            });

            // Verify each project has its own isolated content
            const contentA = await storeA.readReport(sameSlug);
            const contentB = await storeB.readReport(sameSlug);

            expect(contentA).toBe("# Project A Content");
            expect(contentB).toBe("# Project B Content");

            // Verify they have different report paths
            expect(storeA.getReportPath(sameSlug)).not.toBe(storeB.getReportPath(sameSlug));
            expect(storeA.getReportPath(sameSlug)).toContain("project-a");
            expect(storeB.getReportPath(sameSlug)).toContain("project-b");

            // Cleanup
            storeA.reset();
            storeB.reset();
        });

        it("should not share state between project instances", () => {
            // Verify that each LocalReportStore instance has independent state
            const projectAPath = join(testDir, "projects", "project-x");
            const projectBPath = join(testDir, "projects", "project-y");
            mkdirSync(projectAPath, { recursive: true });
            mkdirSync(projectBPath, { recursive: true });

            const storeA = new LocalReportStore();
            const storeB = new LocalReportStore();

            // Initialize store A
            storeA.initialize(projectAPath);
            expect(storeA.projectId).toBe("project-x");
            expect(storeA.isInitialized()).toBe(true);

            // Store B should still be uninitialized
            expect(storeB.isInitialized()).toBe(false);

            // Initialize store B
            storeB.initialize(projectBPath);
            expect(storeB.projectId).toBe("project-y");

            // Store A should still point to project-x
            expect(storeA.projectId).toBe("project-x");

            // Both should be independently initialized
            expect(storeA.isInitialized()).toBe(true);
            expect(storeB.isInitialized()).toBe(true);

            // Reset store A should not affect store B
            storeA.reset();
            expect(storeA.isInitialized()).toBe(false);
            expect(storeB.isInitialized()).toBe(true);

            storeB.reset();
        });
    });
});
