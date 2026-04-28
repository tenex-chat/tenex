import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { homedir } from "node:os";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import * as constantsModule from "@/constants";
import { SkillService } from "../SkillService";

const files = new Map<string, Buffer>();
const directories = new Set<string>();
const symlinks = new Map<string, string>(); // symlink path -> target path
const fileMtimestamps = new Map<string, number>();
const AGENT_PUBKEY = "a".repeat(64);
const AGENT_SHORT_PUBKEY = AGENT_PUBKEY.slice(0, 8);
const PROJECT_PATH = "/path/to/my-project";
const AVAILABLE_SKILLS_CACHE_TTL_MS = 5_000;
const TEST_TENEX_BASE = "/tmp/test-tenex";
const BUILT_IN_SKILLS_PATH = path.join(TEST_TENEX_BASE, "skills", "built-in");
const LOOKUP_CONTEXT = {
    agentPubkey: AGENT_PUBKEY,
    projectPath: PROJECT_PATH,
};
let nextMockMtimeMs = 1;
let mockNowMs = 0;
let readFileCallCount = 0;
let readdirCallCount = 0;
let statCallCount = 0;

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
    fileMtimestamps.set(normalized, nextMockMtimeMs++);
}

function seedSymlink(linkPath: string, targetPath: string): void {
    const normalizedLink = normalizePath(linkPath);
    const normalizedTarget = normalizePath(targetPath);
    ensureMockDirectory(path.dirname(normalizedLink));
    symlinks.set(normalizedLink, normalizedTarget);
}

function createSkillDocument({
    name,
    description,
    content,
    metadata,
    tools,
}: {
    name: string;
    description: string;
    content: string;
    metadata?: Record<string, string>;
    tools?: string[];
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

    if (tools && tools.length > 0) {
        lines.push("tools:");
        for (const toolName of tools) {
            lines.push(`  - ${toolName}`);
        }
    }

    lines.push("---", "", content);
    return lines.join("\n");
}

function listImmediateChildren(dir: string): Array<{ name: string; isDirectory: boolean; isSymlink: boolean }> {
    const normalizedDir = normalizePath(dir);
    const children = new Map<string, { isDirectory: boolean; isSymlink: boolean }>();

    for (const candidate of directories) {
        if (candidate === normalizedDir) continue;
        if (path.dirname(candidate) === normalizedDir) {
            children.set(path.basename(candidate), { isDirectory: true, isSymlink: false });
        }
    }

    for (const candidate of files.keys()) {
        if (path.dirname(candidate) === normalizedDir) {
            if (!children.has(path.basename(candidate))) {
                children.set(path.basename(candidate), { isDirectory: false, isSymlink: false });
            }
        }
    }

    for (const candidate of symlinks.keys()) {
        if (path.dirname(candidate) === normalizedDir) {
            children.set(path.basename(candidate), { isDirectory: false, isSymlink: true });
        }
    }

    return Array.from(children.entries()).map(([name, entry]) => ({
        name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
    }));
}

beforeEach(() => {
    SkillService.resetInstance();
    files.clear();
    directories.clear();
    symlinks.clear();
    fileMtimestamps.clear();
    nextMockMtimeMs = 1;
    mockNowMs = 0;
    readFileCallCount = 0;
    readdirCallCount = 0;
    statCallCount = 0;
    ensureMockDirectory(`${homedir()}/.agents/skills`);

    spyOn(Date, "now").mockImplementation(() => mockNowMs);
    spyOn(constantsModule, "getTenexBasePath").mockReturnValue("/tmp/test-tenex");
    spyOn(fsPromises, "writeFile").mockImplementation(async (target: fsPromises.PathLike, data: string | ArrayBufferView) => {
        const normalized = normalizePath(String(target));
        ensureMockDirectory(path.dirname(normalized));
        files.set(
            normalized,
            Buffer.isBuffer(data) ? data : Buffer.from(data as string)
        );
    });
    spyOn(fsPromises, "readFile").mockImplementation(async (target: fsPromises.PathLike, encoding?: any) => {
        readFileCallCount += 1;
        let normalized = normalizePath(String(target));
        // Check if any parent component is a symlink (e.g., /dir/symlink/file)
        for (const [linkPath, linkTarget] of symlinks) {
            if (normalized.startsWith(linkPath + path.sep)) {
                normalized = normalized.replace(linkPath, linkTarget);
                break;
            }
        }
        const file = files.get(normalized);
        if (!file) {
            throw new Error(`ENOENT: ${normalized}`);
        }
        return encoding === "utf-8" || encoding === "utf8" ? file.toString("utf-8") : file;
    });
    spyOn(fsPromises, "readdir").mockImplementation(async (target: fsPromises.PathLike, options?: any) => {
        readdirCallCount += 1;
        let normalized = normalizePath(String(target));
        // Follow symlinks in path components
        for (const [linkPath, linkTarget] of symlinks) {
            if (normalized === linkPath || normalized.startsWith(linkPath + path.sep)) {
                normalized = normalized.replace(linkPath, linkTarget);
                break;
            }
        }
        const children = listImmediateChildren(normalized);
        if (options?.withFileTypes) {
            return children.map((child) => ({
                name: child.name,
                isDirectory: () => child.isDirectory,
                isFile: () => !child.isDirectory && !child.isSymlink,
                isSymbolicLink: () => child.isSymlink,
            })) as any;
        }
        return children.map((child) => child.name) as any;
    });
    spyOn(fsPromises, "access").mockImplementation(async (target: fsPromises.PathLike) => {
        let normalized = normalizePath(String(target));
        // Follow symlinks in path components
        for (const [linkPath, linkTarget] of symlinks) {
            if (normalized === linkPath || normalized.startsWith(linkPath + path.sep)) {
                normalized = normalized.replace(linkPath, linkTarget);
                break;
            }
        }
        if (!files.has(normalized) && !directories.has(normalized)) {
            throw new Error(`ENOENT: ${normalized}`);
        }
    });
    spyOn(fsPromises, "stat").mockImplementation(async (target: fsPromises.PathLike) => {
        statCallCount += 1;
        let normalized = normalizePath(String(target));
        // Follow symlinks (stat resolves symlinks to their target)
        if (symlinks.has(normalized)) {
            normalized = symlinks.get(normalized)!;
        }
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
                size: files.get(normalized)?.length ?? 0,
                mtimeMs: fileMtimestamps.get(normalized) ?? 0,
            } as any;
        }
        throw new Error(`ENOENT: ${normalized}`);
    });
});

afterEach(() => {
    mock.restore();
    SkillService.resetInstance();
});

describe("SkillService", () => {
    it("lists local skills from SKILL.md frontmatter and body", async () => {
        seedFile(
            `${homedir()}/.agents/skills/custom-id/SKILL.md`,
            createSkillDocument({
                name: "custom-id",
                description: "Frontmatter-backed local skill description",
                content: "Local skill content",
            })
        );
        seedFile(`${homedir()}/.agents/skills/custom-id/helper.ts`, "export const helper = true;");

        const skills = await SkillService.getInstance().listAvailableSkills();

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("custom-id");
        expect(skills[0].description).toBe("Frontmatter-backed local skill description");
        expect(skills[0].content).toBe("Local skill content");
        expect(skills[0].installedFiles.map((file) => file.relativePath)).toEqual(["helper.ts"]);
    });

    it("loads the renamed built-in agent-management skill and not the legacy agents-write id", async () => {
        seedFile(
            `${BUILT_IN_SKILLS_PATH}/agent-management/SKILL.md`,
            createSkillDocument({
                name: "agent-management",
                description: "Create and update agent configurations",
                content: "Built-in skill content",
                tools: ["agents_write"],
            }),
        );

        const skills = await SkillService.getInstance().listAvailableSkills();
        const fetched = await SkillService.getInstance().fetchSkills(["agent-management"]);

        expect(skills.map((skill) => skill.identifier)).toEqual(["agent-management"]);
        expect(skills[0]?.toolNames).toEqual(["agents_write"]);
        expect(skills.some((skill) => skill.identifier === "agents-write")).toBe(false);
        expect(fetched.skills).toHaveLength(1);
        expect(fetched.skills[0]?.identifier).toBe("agent-management");
    });

    it("reuses cached available skills when the visible skill tree has not changed", async () => {
        seedFile(
            `${homedir()}/.agents/skills/cache-test/SKILL.md`,
            createSkillDocument({
                name: "cache-test",
                description: "Cache test description",
                content: "Cache test content",
            })
        );

        const firstSkills = await SkillService.getInstance().listAvailableSkills();
        const readsAfterFirstCall = readFileCallCount;
        const readdirAfterFirstCall = readdirCallCount;
        const statAfterFirstCall = statCallCount;
        const secondSkills = await SkillService.getInstance().listAvailableSkills();

        expect(firstSkills.map((skill) => skill.identifier)).toEqual(["cache-test"]);
        expect(secondSkills.map((skill) => skill.identifier)).toEqual(["cache-test"]);
        expect(readsAfterFirstCall).toBeGreaterThan(0);
        expect(readFileCallCount).toBe(readsAfterFirstCall);
        expect(readdirCallCount).toBe(readdirAfterFirstCall);
        expect(statCallCount).toBe(statAfterFirstCall);
    });

    it("does not rescan the skill tree within the TTL even when disk contents change", async () => {
        seedFile(
            `${homedir()}/.agents/skills/existing-skill/SKILL.md`,
            createSkillDocument({
                name: "existing-skill",
                description: "Existing description",
                content: "Existing content",
            })
        );

        const initialSkills = await SkillService.getInstance().listAvailableSkills();
        const readsAfterInitialLoad = readFileCallCount;
        const readdirAfterInitialLoad = readdirCallCount;
        const statAfterInitialLoad = statCallCount;

        seedFile(
            `${homedir()}/.agents/skills/new-skill/SKILL.md`,
            createSkillDocument({
                name: "new-skill",
                description: "New description",
                content: "New content",
            })
        );

        const cachedSkills = await SkillService.getInstance().listAvailableSkills();

        expect(initialSkills.map((skill) => skill.identifier)).toEqual(["existing-skill"]);
        expect(cachedSkills.map((skill) => skill.identifier)).toEqual(["existing-skill"]);
        expect(readFileCallCount).toBe(readsAfterInitialLoad);
        expect(readdirCallCount).toBe(readdirAfterInitialLoad);
        expect(statCallCount).toBe(statAfterInitialLoad);
    });

    it("refreshes cached available skills when a new skill appears on disk after the TTL elapses", async () => {
        seedFile(
            `${homedir()}/.agents/skills/existing-skill/SKILL.md`,
            createSkillDocument({
                name: "existing-skill",
                description: "Existing description",
                content: "Existing content",
            })
        );

        const initialSkills = await SkillService.getInstance().listAvailableSkills();
        const readsAfterInitialLoad = readFileCallCount;

        seedFile(
            `${homedir()}/.agents/skills/new-skill/SKILL.md`,
            createSkillDocument({
                name: "new-skill",
                description: "New description",
                content: "New content",
            })
        );

        mockNowMs += AVAILABLE_SKILLS_CACHE_TTL_MS + 1;
        const refreshedSkills = await SkillService.getInstance().listAvailableSkills();

        expect(initialSkills.map((skill) => skill.identifier)).toEqual(["existing-skill"]);
        expect(refreshedSkills.map((skill) => skill.identifier)).toEqual([
            "existing-skill",
            "new-skill",
        ]);
        expect(readFileCallCount).toBeGreaterThan(readsAfterInitialLoad);
    });

    it("refreshes cached available skills when an existing SKILL.md changes on disk after the TTL elapses", async () => {
        const initialDocument = createSkillDocument({
            name: "mutable-skill",
            description: "alpha-beta",
            content: "abcdefghij",
        });
        const updatedDocument = createSkillDocument({
            name: "mutable-skill",
            description: "omega-beta",
            content: "klmnopqrst",
        });

        expect(initialDocument.length).toBe(updatedDocument.length);

        seedFile(`${homedir()}/.agents/skills/mutable-skill/SKILL.md`, initialDocument);

        const initialSkills = await SkillService.getInstance().listAvailableSkills();
        const readsAfterInitialLoad = readFileCallCount;

        seedFile(`${homedir()}/.agents/skills/mutable-skill/SKILL.md`, updatedDocument);

        mockNowMs += AVAILABLE_SKILLS_CACHE_TTL_MS + 1;
        const refreshedSkills = await SkillService.getInstance().listAvailableSkills();

        expect(initialSkills[0]?.description).toBe("alpha-beta");
        expect(initialSkills[0]?.content).toBe("abcdefghij");
        expect(refreshedSkills[0]?.description).toBe("omega-beta");
        expect(refreshedSkills[0]?.content).toBe("klmnopqrst");
        expect(readFileCallCount).toBeGreaterThan(readsAfterInitialLoad);
    });

    it("prefers project skills over shared skills when identifiers conflict", async () => {
        seedFile(
            `${homedir()}/.agents/skills/poster-kit/SKILL.md`,
            createSkillDocument({
                name: "poster-kit",
                description: "Shared poster description",
                content: "Shared poster skill",
            })
        );
        seedFile(
            `${PROJECT_PATH}/.agents/skills/poster-kit/SKILL.md`,
            createSkillDocument({
                name: "poster-kit",
                description: "Project poster description",
                content: "Project poster skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            projectPath: PROJECT_PATH,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["poster-kit"],
            { projectPath: PROJECT_PATH }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("poster-kit");
        expect(skills[0].content).toBe("Project poster skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Project poster skill");
    });

    it("prefers agent skills over project and shared skills when identifiers conflict", async () => {
        seedFile(
            `${homedir()}/.agents/skills/poster-kit/SKILL.md`,
            createSkillDocument({
                name: "poster-kit",
                description: "Shared poster description",
                content: "Shared poster skill",
            })
        );
        seedFile(
            `${PROJECT_PATH}/.agents/skills/poster-kit/SKILL.md`,
            createSkillDocument({
                name: "poster-kit",
                description: "Project poster description",
                content: "Project poster skill",
            })
        );
        seedFile(
            `/tmp/test-tenex/home/${AGENT_SHORT_PUBKEY}/skills/poster-kit/SKILL.md`,
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

    it("loads project skills when projectPath is provided", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/.agents/skills/repo-skill/SKILL.md`,
            createSkillDocument({
                name: "repo-skill",
                description: "Project skill description",
                content: "Project skill content",
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
        expect(skills[0].content).toBe("Project skill content");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Project skill content");
    });

    it("loads agent-project skills when both agentPubkey and projectPath are provided", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/.agents/${AGENT_SHORT_PUBKEY}/skills/agent-proj-skill/SKILL.md`,
            createSkillDocument({
                name: "agent-proj-skill",
                description: "Agent-project skill description",
                content: "Agent-project skill content",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey: AGENT_PUBKEY,
            projectPath: projectRepoPath,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["agent-proj-skill"],
            { agentPubkey: AGENT_PUBKEY, projectPath: projectRepoPath }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("agent-proj-skill");
        expect(skills[0].content).toBe("Agent-project skill content");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Agent-project skill content");
    });

    it("prefers agent-project skills over project-shared skills when identifiers conflict", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/.agents/skills/conflict-skill/SKILL.md`,
            createSkillDocument({
                name: "conflict-skill",
                description: "Project shared description",
                content: "Project shared skill",
            })
        );
        seedFile(
            `${projectRepoPath}/.agents/${AGENT_SHORT_PUBKEY}/skills/conflict-skill/SKILL.md`,
            createSkillDocument({
                name: "conflict-skill",
                description: "Agent-project description",
                content: "Agent-project skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills({
            agentPubkey: AGENT_PUBKEY,
            projectPath: projectRepoPath,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["conflict-skill"],
            { agentPubkey: AGENT_PUBKEY, projectPath: projectRepoPath }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("conflict-skill");
        expect(skills[0].content).toBe("Agent-project skill");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Agent-project skill");
    });

    it("prefers agent skills over project skills when identifiers conflict", async () => {
        const projectRepoPath = "/path/to/my-project";
        seedFile(
            `${projectRepoPath}/.agents/skills/agent-vs-repo/SKILL.md`,
            createSkillDocument({
                name: "agent-vs-repo",
                description: "Project description",
                content: "Project skill",
            })
        );
        seedFile(
            `/tmp/test-tenex/home/${AGENT_SHORT_PUBKEY}/skills/agent-vs-repo/SKILL.md`,
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

    it("resolves symlinked skill directories in project scope", async () => {
        const projectRepoPath = "/path/to/my-project";
        const symlinkTarget = "/elsewhere/shared-skills/notion-api";

        // Seed the real skill content at the symlink target
        seedFile(
            `${symlinkTarget}/SKILL.md`,
            createSkillDocument({
                name: "notion-api",
                description: "Notion API skill",
                content: "Notion skill content",
            })
        );

        // Create a symlink in the project skills directory pointing to the target
        seedSymlink(`${projectRepoPath}/.agents/skills/notion-api`, symlinkTarget);

        const skills = await SkillService.getInstance().listAvailableSkills({
            projectPath: projectRepoPath,
        });
        const result = await SkillService.getInstance().fetchSkills(
            ["notion-api"],
            { projectPath: projectRepoPath }
        );

        expect(skills).toHaveLength(1);
        expect(skills[0].identifier).toBe("notion-api");
        expect(skills[0].content).toBe("Notion skill content");
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Notion skill content");
    });

    it("loads shared ~/.agents skills when no higher-precedence copy exists", async () => {
        seedFile(
            `${homedir()}/.agents/skills/shared-only/SKILL.md`,
            createSkillDocument({
                name: "shared-only",
                description: "Shared only description",
                content: "Shared only skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["shared-only"],
            LOOKUP_CONTEXT
        );

        expect(skills.map((skill) => skill.identifier)).toEqual(["shared-only"]);
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Shared only skill");
    });

    it("treats missing project and agent skill directories as empty", async () => {
        seedFile(
            `${homedir()}/.agents/skills/shared-only/SKILL.md`,
            createSkillDocument({
                name: "shared-only",
                description: "Shared only description",
                content: "Shared only skill",
            })
        );

        const skills = await SkillService.getInstance().listAvailableSkills(LOOKUP_CONTEXT);
        const result = await SkillService.getInstance().fetchSkills(
            ["shared-only"],
            LOOKUP_CONTEXT
        );

        expect(skills.map((skill) => skill.identifier)).toEqual(["shared-only"]);
        expect(result.skills).toHaveLength(1);
        expect(result.skills[0].content).toBe("Shared only skill");
    });
});
