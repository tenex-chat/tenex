import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import * as constantsModule from "@/constants";
import * as fsLibModule from "@/lib/fs";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { SkillService } from "../SkillService";

const mockFetchEvents = mock(() => Promise.resolve(new Set<NDKEvent>()));
const mockFetchEvent = mock(() => Promise.resolve(null));

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

const files = new Map<string, Buffer>();
const directories = new Set<string>();
const AGENT_PUBKEY = "a".repeat(64);
const PROJECT_DTAG = "TENEX-ff3ssq";
const LOOKUP_CONTEXT = {
    agentPubkey: AGENT_PUBKEY,
    projectDTag: PROJECT_DTAG,
};

function normalizePath(target: string): string {
    return path.resolve(target);
}

function ensureMockDirectory(target: string): void {
    let current = normalizePath(target);
    const parts = current.split(path.sep);
    let built = current.startsWith(path.sep) ? path.sep : "";

    for (const part of parts) {
        if (!part) continue;
        built = built === path.sep ? path.join(built, part) : path.join(built, part);
        directories.add(normalizePath(built));
    }
}

function seedFile(target: string, content: string): void {
    const normalized = normalizePath(target);
    ensureMockDirectory(path.dirname(normalized));
    files.set(normalized, Buffer.from(content));
}

function createSkillDocument({
    name,
    description,
    content,
    metadata,
}: {
    name: string;
    description: string;
    content: string;
    metadata?: Record<string, string>;
}): string {
    const lines = [
        "---",
        `name: ${JSON.stringify(name)}`,
        `description: ${JSON.stringify(description)}`,
    ];

    if (metadata && Object.keys(metadata).length > 0) {
        lines.push("metadata:");
        for (const [key, value] of Object.entries(metadata)) {
            lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
    }

    lines.push("---", "", content);
    return lines.join("\n");
}

function listImmediateChildren(dir: string): Array<{ name: string; isDirectory: boolean }> {
    const normalizedDir = normalizePath(dir);
    const children = new Map<string, boolean>();

    for (const candidate of directories) {
        if (candidate === normalizedDir) continue;
        if (path.dirname(candidate) === normalizedDir) {
            children.set(path.basename(candidate), true);
        }
    }

    for (const candidate of files.keys()) {
        if (path.dirname(candidate) === normalizedDir) {
            if (!children.has(path.basename(candidate))) {
                children.set(path.basename(candidate), false);
            }
        }
    }

    return Array.from(children.entries()).map(([name, isDirectory]) => ({
        name,
        isDirectory,
    }));
}

beforeEach(() => {
    SkillService.resetInstance();
    files.clear();
    directories.clear();
    ensureMockDirectory("/tmp/test-tenex/skills");

    mockFetch = mock(() =>
        Promise.resolve(
            new Response(Buffer.from("file content"), {
                status: 200,
                statusText: "OK",
            })
        )
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    mockFetchEvents.mockReset();
    mockFetchEvent.mockReset();

    SkillService.setNDKProviderForTesting(() => ({
        fetchEvents: mockFetchEvents,
        fetchEvent: mockFetchEvent,
    } as any));

    spyOn(constantsModule, "getTenexBasePath").mockReturnValue("/tmp/test-tenex");
    spyOn(fsLibModule, "ensureDirectory").mockImplementation(async (target: string) => {
        ensureMockDirectory(target);
    });
    spyOn(fsPromises, "writeFile").mockImplementation(async (target: fsPromises.PathLike, data: string | ArrayBufferView) => {
        const normalized = normalizePath(String(target));
        ensureMockDirectory(path.dirname(normalized));
        files.set(
            normalized,
            Buffer.isBuffer(data) ? data : Buffer.from(data as string)
        );
    });
    spyOn(fsPromises, "readFile").mockImplementation(async (target: fsPromises.PathLike, encoding?: any) => {
        const normalized = normalizePath(String(target));
        const file = files.get(normalized);
        if (!file) {
            throw new Error(`ENOENT: ${normalized}`);
        }
        return encoding === "utf-8" || encoding === "utf8" ? file.toString("utf-8") : file;
    });
    spyOn(fsPromises, "readdir").mockImplementation(async (target: fsPromises.PathLike, options?: any) => {
        const normalized = normalizePath(String(target));
        const children = listImmediateChildren(normalized);
        if (options?.withFileTypes) {
            return children.map((child) => ({
                name: child.name,
                isDirectory: () => child.isDirectory,
                isFile: () => !child.isDirectory,
            })) as any;
        }
        return children.map((child) => child.name) as any;
    });
    spyOn(fsPromises, "access").mockImplementation(async (target: fsPromises.PathLike) => {
        const normalized = normalizePath(String(target));
        if (!files.has(normalized) && !directories.has(normalized)) {
            throw new Error(`ENOENT: ${normalized}`);
        }
    });
    spyOn(fsPromises, "stat").mockImplementation(async (target: fsPromises.PathLike) => {
        const normalized = normalizePath(String(target));
        if (directories.has(normalized)) {
            return {
                isDirectory: () => true,
                isFile: () => false,
            } as any;
        }
        if (files.has(normalized)) {
            return {
                isDirectory: () => false,
                isFile: () => true,
            } as any;
        }
        throw new Error(`ENOENT: ${normalized}`);
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    SkillService.resetInstance();
});

describe("SkillService", () => {
    it("lists local skills from SKILL.md frontmatter and body", async () => {
        seedFile(
            "/tmp/test-tenex/skills/custom-id/SKILL.md",
            createSkillDocument({
                name: "custom-id",
                description: "Frontmatter-backed local skill description",
                content: "Local skill content",
            })
        );
        seedFile("/tmp/test-tenex/skills/custom-id/helper.ts", "export const helper = true;");

        const skills = await SkillService.getInstance().listAvailableSkills();

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("custom-id");
        expect(skills[0].description).toBe("Frontmatter-backed local skill description");
        expect(skills[0].content).toBe("Local skill content");
        expect(skills[0].installedFiles.map((file) => file.relativePath)).toEqual(["helper.ts"]);
    });

    it("prefers project skills over global skills when identifiers conflict", async () => {
        seedFile(
            "/Users/pablofernandez/.agents/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Legacy poster description",
                content: "Legacy poster skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Global poster description",
                content: "Global poster skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/projects/TENEX-ff3ssq/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Project poster description",
                content: "Project poster skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            projectDTag: PROJECT_DTAG,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["poster-kit"],
            { projectDTag: PROJECT_DTAG }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("poster-kit");
        expect(skills[0].content).toBe("Project poster skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Project poster skill");
    });

    it("prefers agent skills over project and global skills when identifiers conflict", async () => {
        seedFile(
            "/Users/pablofernandez/.agents/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Legacy poster description",
                content: "Legacy poster skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Global poster description",
                content: "Global poster skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/projects/TENEX-ff3ssq/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Project poster description",
                content: "Project poster skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/home/aaaaaaaa/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "poster-kit",
                description: "Agent poster description",
                content: "Agent poster skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["poster-kit"],
            LOOKUP_CONTEXT
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("poster-kit");
        expect(skills[0].content).toBe("Agent poster skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Agent poster skill");
    });

    it("loads project-repo skills when projectPath is provided", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/skills/repo-skill/SKILL.md`,
            createSkillDocument({
                name: "repo-skill",
                description: "Project repo skill description",
                content: "Project repo skill content",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            projectPath: projectRepoPath,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["repo-skill"],
            { projectPath: projectRepoPath }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("repo-skill");
        expect(skills[0].content).toBe("Project repo skill content");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Project repo skill content");
    });

    it("prefers project-repo skills over project-metadata skills when identifiers conflict", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            "/tmp/test-tenex/projects/TENEX-ff3ssq/skills/conflict-skill/SKILL.md",
            createSkillDocument({
                name: "conflict-skill",
                description: "Project metadata description",
                content: "Project metadata skill",
            })
        );
        seedFile(
            `${projectRepoPath}/skills/conflict-skill/SKILL.md`,
            createSkillDocument({
                name: "conflict-skill",
                description: "Project repo description",
                content: "Project repo skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            projectPath: projectRepoPath,
            projectDTag: PROJECT_DTAG,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["conflict-skill"],
            { projectPath: projectRepoPath, projectDTag: PROJECT_DTAG }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("conflict-skill");
        expect(skills[0].content).toBe("Project repo skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Project repo skill");
    });

    it("prefers agent skills over project-repo skills when identifiers conflict", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/skills/agent-vs-repo/SKILL.md`,
            createSkillDocument({
                name: "agent-vs-repo",
                description: "Project repo description",
                content: "Project repo skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/home/aaaaaaaa/skills/agent-vs-repo/SKILL.md",
            createSkillDocument({
                name: "agent-vs-repo",
                description: "Agent skill description",
                content: "Agent skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey: AGENT_PUBKEY,
            projectPath: projectRepoPath,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["agent-vs-repo"],
            { agentPubkey: AGENT_PUBKEY, projectPath: projectRepoPath }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("agent-vs-repo");
        expect(skills[0].content).toBe("Agent skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Agent skill");
    });

    it("loads legacy ~/.agents skills when no higher-precedence copy exists", async () => {
        seedFile(
            "/Users/pablofernandez/.agents/skills/legacy-only/SKILL.md",
            createSkillDocument({
                name: "legacy-only",
                description: "Legacy only description",
                content: "Legacy only skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["legacy-only"],
            LOOKUP_CONTEXT
        );

        expect(skills.map((skill) => skill.identifier)).toEqual(["legacy-only"]);
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Legacy only skill");
    });

    it("prefers global skills over legacy ~/.agents skills when identifiers conflict", async () => {
        seedFile(
            "/Users/pablofernandez/.agents/skills/fallback-kit/SKILL.md",
            createSkillDocument({
                name: "fallback-kit",
                description: "Legacy fallback description",
                content: "Legacy fallback skill",
            })
        );
        seedFile(
            "/tmp/test-tenex/skills/fallback-kit/SKILL.md",
            createSkillDocument({
                name: "fallback-kit",
                description: "Global fallback description",
                content: "Global fallback skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["fallback-kit"],
            LOOKUP_CONTEXT
        );

        expect(skills.find((skill) => skill.identifier === "fallback-kit")?.content).toBe(
            "Global fallback skill"
        );
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Global fallback skill");
    });

    it("treats missing project and agent skill directories as empty", async () => {
        seedFile(
            "/tmp/test-tenex/skills/global-only/SKILL.md",
            createSkillDocument({
                name: "global-only",
                description: "Global only description",
                content: "Global only skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["global-only"],
            LOOKUP_CONTEXT
        );

        expect(skills.map((skill) => skill.identifier)).toEqual(["global-only"]);
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Global only skill");
    });

    it("hydrates remote skills into slugged local directories and loads them from disk", async () => {
        const skillEvent = new NDKEvent();
        skillEvent.id = "b".repeat(64);
        skillEvent.kind = NDKKind.AgentSkill;
        skillEvent.content = "Make a poster";
        skillEvent.tags = [
            ["title", "Make Poster"],
            ["description", "Creates posters from structured inputs"],
        ];

        mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));

        const result = await SkillService.getInstance().fetchSkills(["b".repeat(64)]);

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].identifier).toBe("make-poster");
        expect(result.skills[0].name).toBe("Make Poster");
        expect(result.skills[0].description).toBe("Creates posters from structured inputs");
        expect(result.skills[0].content).toBe("Make a poster");
        const storedSkillDocument = files
            .get(normalizePath("/tmp/test-tenex/skills/make-poster/SKILL.md"))
            ?.toString("utf-8");
        expect(storedSkillDocument).toContain('name: "Make Poster"');
        expect(storedSkillDocument).toContain(
            'description: "Creates posters from structured inputs"'
        );
        expect(storedSkillDocument).toContain(`tenex-event-id: "${"b".repeat(64)}"`);
        expect(storedSkillDocument).not.toContain("tenex-title");
        expect(storedSkillDocument).not.toContain("tenex-hydrated-at");
        expect(storedSkillDocument).toContain("Make a poster");

        const listedSkills = await SkillService.getInstance().listAvailableSkills();
        expect(listedSkills.map((skill) => skill.identifier)).toEqual(["make-poster"]);
    });

    it("falls back to remote hydration when no scoped local match exists", async () => {
        const skillEvent = new NDKEvent();
        skillEvent.id = "e".repeat(64);
        skillEvent.kind = NDKKind.AgentSkill;
        skillEvent.content = "Remote scoped skill";
        skillEvent.tags = [["title", "Remote Scoped"]];

        seedFile(
            "/tmp/test-tenex/projects/TENEX-ff3ssq/skills/local-only/SKILL.md",
            createSkillDocument({
                name: "local-only",
                description: "Project only description",
                content: "Project only skill",
            })
        );

        mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));

        const result = await SkillService.getInstance().fetchSkills(
            ["e".repeat(64)],
            LOOKUP_CONTEXT
        );

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].identifier).toBe("remote-scoped");
        expect(result.skills[0].name).toBe("Remote Scoped");
        expect(result.skills[0].content).toBe("Remote scoped skill");
        const storedScopedSkillDocument = files
            .get(normalizePath("/tmp/test-tenex/skills/remote-scoped/SKILL.md"))
            ?.toString("utf-8");
        expect(storedScopedSkillDocument).toContain('name: "Remote Scoped"');
        expect(storedScopedSkillDocument).toContain('description: "Remote scoped skill"');
        expect(storedScopedSkillDocument).toContain(`tenex-event-id: "${"e".repeat(64)}"`);
        expect(storedScopedSkillDocument).not.toContain("tenex-title");
        expect(storedScopedSkillDocument).not.toContain("tenex-hydrated-at");
        expect(storedScopedSkillDocument).toContain("Remote scoped skill");
    });

    it("reuses already-hydrated local skill content instead of re-fetching the remote event", async () => {
        seedFile(
            "/tmp/test-tenex/skills/poster-kit/SKILL.md",
            createSkillDocument({
                name: "Poster Kit",
                description: "Poster skill description",
                content: "Locally edited content",
                metadata: {
                    "tenex-event-id": "c".repeat(64),
                },
            })
        );

        const result = await SkillService.getInstance().fetchSkills(["c".repeat(64)]);

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].identifier).toBe("poster-kit");
        expect(result.skills[0].name).toBe("Poster Kit");
        expect(result.skills[0].content).toBe("Locally edited content");
        expect(mockFetchEvents).not.toHaveBeenCalled();
    });

    it("falls back to the short event id when a remote skill has no title, name, or d-tag", async () => {
        const skillEvent = new NDKEvent();
        skillEvent.id = "d".repeat(64);
        skillEvent.kind = NDKKind.AgentSkill;
        skillEvent.content = "Unnamed remote skill";
        skillEvent.tags = [];

        mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent]));

        const result = await SkillService.getInstance().fetchSkills(["d".repeat(64)]);

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].identifier).toBe("dddddddddddd");
    });

    it("fetchSkill returns only kind:4202 skill events", async () => {
        const skillEvent = new NDKEvent();
        skillEvent.id = "skill123";
        skillEvent.kind = NDKKind.AgentSkill;
        skillEvent.content = "Skill content";
        skillEvent.tags = [];

        const otherEvent = new NDKEvent();
        otherEvent.id = "other123";
        otherEvent.kind = 1;
        otherEvent.content = "Not a skill";
        otherEvent.tags = [];

        mockFetchEvents.mockResolvedValueOnce(new Set([skillEvent, otherEvent]));

        const result = await SkillService.getInstance().fetchSkill("skill123");

        expect(result).toBe(skillEvent);
    });
});
