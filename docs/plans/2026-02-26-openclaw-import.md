# OpenClaw Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `tenex agent import openclaw` command that detects a local OpenClaw installation and imports its agents into TENEX.

**Architecture:** Three files do the work: `openclaw-reader.ts` parses the OpenClaw state dir into typed structs, `openclaw-distiller.ts` sends workspace files to the agent's own LLM and extracts structured identity fields, `openclaw.ts` is the thin command that orchestrates reader → distiller → storage → symlinks → globalSystemPrompt.

**Tech Stack:** Commander.js (command wiring), Bun test (`bun:test`), Vercel AI SDK via `LLMService.generateObject()`, Zod schemas, NDK (`NDKPrivateKeySigner.generate()`), `agentStorage` singleton, `config.saveGlobalConfig()`.

---

### Task 1: OpenClaw reader (`openclaw-reader.ts`)

**Files:**
- Create: `src/commands/agent/import/__tests__/openclaw-reader.test.ts`
- Create: `src/commands/agent/import/openclaw-reader.ts`

**Step 1: Write the failing test**

Create `src/commands/agent/import/__tests__/openclaw-reader.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findOpenClawStateDir, readOpenClawAgents } from "../openclaw-reader";

describe("findOpenClawStateDir", () => {
    let tempDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
        originalEnv = process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_STATE_DIR;
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (originalEnv !== undefined) {
            process.env.OPENCLAW_STATE_DIR = originalEnv;
        } else {
            delete process.env.OPENCLAW_STATE_DIR;
        }
    });

    it("returns null when no installation found", async () => {
        const result = await findOpenClawStateDir([tempDir + "/nonexistent"]);
        expect(result).toBeNull();
    });

    it("detects via OPENCLAW_STATE_DIR env var", async () => {
        const configPath = path.join(tempDir, "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify({ agents: {} }));
        process.env.OPENCLAW_STATE_DIR = tempDir;
        const result = await findOpenClawStateDir([]);
        expect(result).toBe(tempDir);
    });

    it("detects via candidate path with openclaw.json", async () => {
        const configPath = path.join(tempDir, "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify({ agents: {} }));
        const result = await findOpenClawStateDir([tempDir]);
        expect(result).toBe(tempDir);
    });
});

describe("readOpenClawAgents", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("reads default main agent when no agents.list configured", async () => {
        const workspaceDir = path.join(tempDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# Soul\nBe helpful.");
        await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "# Identity\n- **Name:** Clippy");
        await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Agents\nBe safe.");
        await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\n- **Name:** Bob");

        const config = {
            agents: {
                defaults: {
                    model: { primary: "anthropic/claude-sonnet-4-6" },
                    workspace: workspaceDir,
                },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe("main");
        expect(agents[0].modelPrimary).toBe("anthropic/claude-sonnet-4-6");
        expect(agents[0].workspaceFiles.soul).toContain("Be helpful.");
        expect(agents[0].workspaceFiles.identity).toContain("Clippy");
        expect(agents[0].workspaceFiles.agents).toContain("Be safe.");
        expect(agents[0].workspaceFiles.user).toContain("Bob");
        expect(agents[0].workspacePath).toBe(workspaceDir);
    });

    it("reads multiple agents from agents.list", async () => {
        const ws1 = path.join(tempDir, "workspace-a");
        const ws2 = path.join(tempDir, "workspace-b");
        await fs.mkdir(ws1, { recursive: true });
        await fs.mkdir(ws2, { recursive: true });
        await fs.writeFile(path.join(ws1, "SOUL.md"), "Agent A soul");
        await fs.writeFile(path.join(ws2, "SOUL.md"), "Agent B soul");

        const config = {
            agents: {
                list: [
                    { id: "agent-a", workspace: ws1, model: { primary: "anthropic/claude-opus-4-6" } },
                    { id: "agent-b", workspace: ws2 },
                ],
                defaults: {
                    model: { primary: "anthropic/claude-sonnet-4-6" },
                    workspace: ws1,
                },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents).toHaveLength(2);
        expect(agents[0].id).toBe("agent-a");
        expect(agents[0].modelPrimary).toBe("anthropic/claude-opus-4-6");
        expect(agents[1].id).toBe("agent-b");
        expect(agents[1].modelPrimary).toBe("anthropic/claude-sonnet-4-6"); // falls back to defaults
    });

    it("handles missing workspace files gracefully", async () => {
        const workspaceDir = path.join(tempDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        // Only SOUL.md exists, IDENTITY.md and AGENTS.md are missing

        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul content");

        const config = {
            agents: {
                defaults: { model: { primary: "anthropic/claude-sonnet-4-6" }, workspace: workspaceDir },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents[0].workspaceFiles.soul).toBe("Soul content");
        expect(agents[0].workspaceFiles.identity).toBeNull();
        expect(agents[0].workspaceFiles.agents).toBeNull();
        expect(agents[0].workspaceFiles.user).toBeNull();
    });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun test src/commands/agent/import/__tests__/openclaw-reader.test.ts 2>&1 | head -20
```

Expected: FAIL - module not found or similar import error.

**Step 3: Implement `openclaw-reader.ts`**

Create `src/commands/agent/import/openclaw-reader.ts`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export interface OpenClawWorkspaceFiles {
    soul: string | null;
    identity: string | null;
    agents: string | null;
    user: string | null;
}

export interface OpenClawAgent {
    id: string;
    modelPrimary: string;
    workspacePath: string;
    workspaceFiles: OpenClawWorkspaceFiles;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return null;
    }
}

async function configExists(dir: string): Promise<boolean> {
    for (const name of ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"]) {
        try {
            await fs.access(path.join(dir, name));
            return true;
        } catch {
            // continue
        }
    }
    return false;
}

export async function findOpenClawStateDir(candidatePaths: string[]): Promise<string | null> {
    // 1. Environment variable takes precedence
    const envDir = process.env.OPENCLAW_STATE_DIR;
    if (envDir && await configExists(envDir)) {
        return envDir;
    }

    // 2. Check candidate paths
    for (const dir of candidatePaths) {
        if (await configExists(dir)) {
            return dir;
        }
    }

    return null;
}

export async function detectOpenClawStateDir(): Promise<string | null> {
    const home = homedir();
    return findOpenClawStateDir([
        path.join(home, ".openclaw"),
        path.join(home, ".clawdbot"),
        path.join(home, ".moldbot"),
        path.join(home, ".moltbot"),
    ]);
}

async function readConfigJson(stateDir: string): Promise<Record<string, unknown>> {
    for (const name of ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"]) {
        try {
            const content = await fs.readFile(path.join(stateDir, name), "utf-8");
            return JSON.parse(content);
        } catch {
            // continue
        }
    }
    throw new Error(`No config file found in ${stateDir}`);
}

async function readWorkspaceFiles(workspacePath: string): Promise<OpenClawWorkspaceFiles> {
    const [soul, identity, agents, user] = await Promise.all([
        readFileOrNull(path.join(workspacePath, "SOUL.md")),
        readFileOrNull(path.join(workspacePath, "IDENTITY.md")),
        readFileOrNull(path.join(workspacePath, "AGENTS.md")),
        readFileOrNull(path.join(workspacePath, "USER.md")),
    ]);
    return { soul, identity, agents, user };
}

export async function readOpenClawAgents(stateDir: string): Promise<OpenClawAgent[]> {
    const config = await readConfigJson(stateDir);
    const agentsConfig = (config.agents ?? {}) as Record<string, unknown>;
    const defaults = (agentsConfig.defaults ?? {}) as Record<string, unknown>;
    const defaultModel = ((defaults.model ?? {}) as Record<string, unknown>).primary as string | undefined;
    const defaultWorkspace = (defaults.workspace as string | undefined) ?? path.join(stateDir, "workspace");

    const list = agentsConfig.list as Array<Record<string, unknown>> | undefined;

    if (!list || list.length === 0) {
        // Single default "main" agent
        const workspaceFiles = await readWorkspaceFiles(defaultWorkspace);
        return [{
            id: "main",
            modelPrimary: defaultModel ?? "anthropic/claude-sonnet-4-6",
            workspacePath: defaultWorkspace,
            workspaceFiles,
        }];
    }

    return Promise.all(list.map(async (entry) => {
        const id = (entry.id as string | undefined) ?? "main";
        const agentModel = ((entry.model ?? {}) as Record<string, unknown>).primary as string | undefined;
        const workspacePath = (entry.workspace as string | undefined) ?? defaultWorkspace;
        const workspaceFiles = await readWorkspaceFiles(workspacePath);
        return {
            id,
            modelPrimary: agentModel ?? defaultModel ?? "anthropic/claude-sonnet-4-6",
            workspacePath,
            workspaceFiles,
        };
    }));
}

/**
 * Convert OpenClaw model format to TENEX format.
 * OpenClaw uses "provider/model", TENEX uses "provider:model".
 */
export function convertModelFormat(openClawModel: string): string {
    return openClawModel.replace("/", ":");
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun test src/commands/agent/import/__tests__/openclaw-reader.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && git add src/commands/agent/import/openclaw-reader.ts src/commands/agent/import/__tests__/openclaw-reader.test.ts && git commit -m "feat(import): add OpenClaw state dir reader"
```

---

### Task 2: OpenClaw distiller (`openclaw-distiller.ts`)

**Files:**
- Create: `src/commands/agent/import/__tests__/openclaw-distiller.test.ts`
- Create: `src/commands/agent/import/openclaw-distiller.ts`

**Step 1: Write the failing test**

Create `src/commands/agent/import/__tests__/openclaw-distiller.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { buildDistillationPrompt, parseModelString } from "../openclaw-distiller";

describe("parseModelString", () => {
    it("parses provider:model format", () => {
        expect(parseModelString("anthropic:claude-sonnet-4-6")).toEqual({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
        });
    });

    it("handles model with colons in name", () => {
        expect(parseModelString("openai:gpt-4:turbo")).toEqual({
            provider: "openai",
            model: "gpt-4:turbo",
        });
    });
});

describe("buildDistillationPrompt", () => {
    it("includes all provided files in prompt", () => {
        const prompt = buildDistillationPrompt({
            soul: "# Soul\nBe helpful.",
            identity: "# Identity\n- **Name:** Clippy",
            agents: "# Agents\nBe safe.",
            user: null,
        });
        expect(prompt).toContain("Be helpful.");
        expect(prompt).toContain("Clippy");
        expect(prompt).toContain("Be safe.");
    });

    it("omits sections for null files", () => {
        const prompt = buildDistillationPrompt({
            soul: "Soul content",
            identity: null,
            agents: null,
            user: null,
        });
        expect(prompt).toContain("Soul content");
        expect(prompt).not.toContain("IDENTITY.md");
        expect(prompt).not.toContain("AGENTS.md");
    });
});
```

**Step 2: Run to verify it fails**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun test src/commands/agent/import/__tests__/openclaw-distiller.test.ts 2>&1 | head -20
```

Expected: FAIL - module not found.

**Step 3: Implement `openclaw-distiller.ts`**

Create `src/commands/agent/import/openclaw-distiller.ts`:

```typescript
import type { OpenClawWorkspaceFiles } from "./openclaw-reader";
import { config as configService } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import type { LLMConfiguration } from "@/services/config/types";
import { z } from "zod";

export interface DistilledAgentIdentity {
    name: string;
    description: string;
    role: string;
    useCriteria: string;
    instructions: string;
}

const DistilledIdentitySchema = z.object({
    name: z.string(),
    description: z.string(),
    role: z.string(),
    useCriteria: z.string(),
    instructions: z.string(),
});

export function parseModelString(tenexModel: string): { provider: string; model: string } {
    const colonIdx = tenexModel.indexOf(":");
    if (colonIdx === -1) {
        throw new Error(`Invalid model format (expected "provider:model"): ${tenexModel}`);
    }
    return {
        provider: tenexModel.slice(0, colonIdx),
        model: tenexModel.slice(colonIdx + 1),
    };
}

export function buildDistillationPrompt(files: OpenClawWorkspaceFiles): string {
    const sections: string[] = [];

    if (files.soul) {
        sections.push(`<SOUL.md>\n${files.soul}\n</SOUL.md>`);
    }
    if (files.identity) {
        sections.push(`<IDENTITY.md>\n${files.identity}\n</IDENTITY.md>`);
    }
    if (files.agents) {
        sections.push(`<AGENTS.md>\n${files.agents}\n</AGENTS.md>`);
    }

    return `You are extracting a portable agent identity from an OpenClaw installation.
Given these workspace files, return a JSON object with exactly these fields:

- name: the agent's display name (string)
- description: one-sentence description of who this agent is (string)
- role: short phrase describing expertise/personality, e.g. "personal AI assistant" (string)
- useCriteria: when this agent should be selected over others (string)
- instructions: a clean, platform-agnostic system prompt capturing the agent's
  personality, behavioral guidelines, and identity. Discard anything specific
  to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading
  rituals, emoji reaction guidance, silence tokens, tool-specific commands,
  and memory file management instructions. (string)

${sections.join("\n\n")}`;
}

export async function distillAgentIdentity(
    files: OpenClawWorkspaceFiles,
    tenexModelString: string
): Promise<DistilledAgentIdentity> {
    const { provider, model } = parseModelString(tenexModelString);
    const llmConfig: LLMConfiguration = { provider, model };

    const service = llmServiceFactory.createService(llmConfig);
    const prompt = buildDistillationPrompt(files);

    const { object } = await service.generateObject(
        [{ role: "user", content: prompt }],
        DistilledIdentitySchema
    );

    return object;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun test src/commands/agent/import/__tests__/openclaw-distiller.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && git add src/commands/agent/import/openclaw-distiller.ts src/commands/agent/import/__tests__/openclaw-distiller.test.ts && git commit -m "feat(import): add OpenClaw identity distiller"
```

---

### Task 3: Leaf command + orchestration (`openclaw.ts`)

**Files:**
- Create: `src/commands/agent/import/openclaw.ts`

The command is thin orchestration — no unit test needed (integration tested manually).

**Step 1: Implement `src/commands/agent/import/openclaw.ts`**

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { config as configService } from "@/services/ConfigService";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { detectOpenClawStateDir, readOpenClawAgents, convertModelFormat } from "./openclaw-reader";
import { distillAgentIdentity } from "./openclaw-distiller";
import type { OpenClawAgent } from "./openclaw-reader";

function toSlug(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

async function createHomeDir(pubkey: string, workspacePath: string): Promise<string> {
    const homeDir = configService.getConfigPath(`agents/${pubkey}`);
    await fs.mkdir(homeDir, { recursive: true });

    // Symlink MEMORY.md (dangling is ok — file may not exist yet)
    const memoryMdTarget = path.join(workspacePath, "MEMORY.md");
    const memoryMdLink = path.join(homeDir, "MEMORY.md");
    try {
        await fs.unlink(memoryMdLink);
    } catch { /* doesn't exist yet */ }
    await fs.symlink(memoryMdTarget, memoryMdLink);

    // Symlink memory/ directory (dangling is ok)
    const memoryDirTarget = path.join(workspacePath, "memory");
    const memoryDirLink = path.join(homeDir, "memory");
    try {
        await fs.unlink(memoryDirLink);
    } catch { /* doesn't exist yet */ }
    await fs.symlink(memoryDirTarget, memoryDirLink);

    // Write +INDEX.md
    const indexContent = `# Memory Files

This agent's memory is synced live from an OpenClaw installation.

- \`MEMORY.md\` — long-term curated memory (updated by OpenClaw)
- \`memory/YYYY-MM-DD.md\` — daily session logs (updated by OpenClaw)

Source: ${workspacePath}
`;
    await fs.writeFile(path.join(homeDir, "+INDEX.md"), indexContent, "utf-8");

    return homeDir;
}

async function appendUserMdToGlobalPrompt(userMdContent: string): Promise<void> {
    const globalPath = configService.getGlobalPath();
    const existingConfig = await configService.loadTenexConfig(globalPath);

    const userSection = `\n## About the User (imported from OpenClaw)\n\n${userMdContent.trim()}`;
    const existingContent = existingConfig.globalSystemPrompt?.content ?? "";
    const newContent = existingContent ? `${existingContent}${userSection}` : userSection.trim();

    const newConfig = {
        ...existingConfig,
        globalSystemPrompt: {
            enabled: true,
            content: newContent,
        },
    };
    await configService.saveGlobalConfig(newConfig);
}

async function importOneAgent(agent: OpenClawAgent): Promise<void> {
    const tenexModel = convertModelFormat(agent.modelPrimary);

    console.log(chalk.blue(`\nDistilling identity for agent '${agent.id}'...`));
    const identity = await distillAgentIdentity(agent.workspaceFiles, tenexModel);

    const slug = toSlug(identity.name) || agent.id;

    // Idempotency check
    const existing = await agentStorage.getAgentBySlug(slug);
    if (existing) {
        throw new Error(
            `Agent '${slug}' already imported. Delete it first if you want to re-import.`
        );
    }

    // Generate keypair
    const signer = NDKPrivateKeySigner.generate();
    const pubkey = signer.pubkey;

    const storedAgent = createStoredAgent({
        nsec: signer.privateKey!,
        slug,
        name: identity.name,
        role: identity.role,
        description: identity.description,
        instructions: identity.instructions,
        useCriteria: identity.useCriteria,
        defaultConfig: { model: tenexModel },
    });

    await agentStorage.saveAgent(storedAgent);
    const homeDir = await createHomeDir(pubkey, agent.workspacePath);

    console.log(chalk.green(`  ✓ Imported: ${identity.name} (${slug})`));
    console.log(chalk.gray(`    Keypair:   ${pubkey}`));
    console.log(chalk.gray(`    Model:     ${tenexModel}`));
    console.log(chalk.gray(`    Home dir:  ${homeDir}`));
    console.log(chalk.gray(`    Symlinks:  MEMORY.md, memory/`));
}

export const openclawImportCommand = new Command("openclaw")
    .description("Import agents from a local OpenClaw installation")
    .action(async () => {
        try {
            const stateDir = await detectOpenClawStateDir();
            if (!stateDir) {
                console.error(chalk.red("No OpenClaw installation detected."));
                console.error(
                    chalk.gray(
                        "Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot"
                    )
                );
                process.exitCode = 1;
                return;
            }

            console.log(chalk.blue(`Found OpenClaw installation at: ${stateDir}`));

            const agents = await readOpenClawAgents(stateDir);
            console.log(chalk.blue(`Found ${agents.length} agent(s) to import.`));

            // Load TENEX config + init providers (needed for LLM distillation)
            await configService.loadConfig();
            const globalPath = configService.getGlobalPath();
            const providers = await configService.loadTenexProviders(globalPath);
            await llmServiceFactory.initializeProviders(providers.providers);

            await agentStorage.initialize();

            let userMdProcessed = false;

            for (const agent of agents) {
                await importOneAgent(agent);

                // Write USER.md to global system prompt once (same file for all agents)
                if (!userMdProcessed && agent.workspaceFiles.user) {
                    await appendUserMdToGlobalPrompt(agent.workspaceFiles.user);
                    console.log(chalk.green("  ✓ USER.md appended to global system prompt"));
                    userMdProcessed = true;
                }
            }

            console.log(chalk.green("\nImport complete."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            console.error(chalk.red(`Import failed: ${errorMessage}`));
            process.exitCode = 1;
        }
    });
```

**Step 2: Commit**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && git add src/commands/agent/import/openclaw.ts && git commit -m "feat(import): add openclaw import command action"
```

---

### Task 4: Command hierarchy wiring

**Files:**
- Create: `src/commands/agent/import/index.ts`
- Create: `src/commands/agent/index.ts`
- Modify: `src/index.ts`

**Step 1: Create `src/commands/agent/import/index.ts`**

```typescript
import { Command } from "commander";
import { openclawImportCommand } from "./openclaw";

export const importCommand = new Command("import")
    .description("Import agents from external sources")
    .addCommand(openclawImportCommand);
```

**Step 2: Create `src/commands/agent/index.ts`**

```typescript
import { Command } from "commander";
import { importCommand } from "./import/index";

export const agentCommand = new Command("agent")
    .description("Agent management commands")
    .addCommand(importCommand);
```

**Step 3: Register in `src/index.ts`**

In `src/index.ts`, add `agentCommand` to the dynamic imports block and `program.addCommand()` call.

Find the imports block:
```typescript
    const [
        { Command },
        { getHeuristicEngine, getDefaultHeuristics },
        { daemonCommand },
        { setupCommand },
        { doctorCommand },
        { handleCliError },
    ] = await Promise.all([
        import("commander"),
        import("@/services/heuristics"),
        import("@/commands/daemon"),
        import("@/commands/setup/index"),
        import("@/commands/doctor"),
        import("@/utils/cli-error"),
    ]);
```

Replace with:
```typescript
    const [
        { Command },
        { getHeuristicEngine, getDefaultHeuristics },
        { daemonCommand },
        { setupCommand },
        { doctorCommand },
        { agentCommand },
        { handleCliError },
    ] = await Promise.all([
        import("commander"),
        import("@/services/heuristics"),
        import("@/commands/daemon"),
        import("@/commands/setup/index"),
        import("@/commands/doctor"),
        import("@/commands/agent/index"),
        import("@/utils/cli-error"),
    ]);
```

Find:
```typescript
    program.addCommand(daemonCommand);
    program.addCommand(setupCommand);
    program.addCommand(doctorCommand);
```

Replace with:
```typescript
    program.addCommand(daemonCommand);
    program.addCommand(setupCommand);
    program.addCommand(doctorCommand);
    program.addCommand(agentCommand);
```

**Step 4: Typecheck**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun run typecheck 2>&1 | head -30
```

Expected: No errors.

**Step 5: Smoke test**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun run src/index.ts agent import openclaw --help
```

Expected: Shows help text for the command.

**Step 6: Run full test suite**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && bun test src/commands/agent/import/__tests__/ 2>&1
```

Expected: All tests pass.

**Step 7: Commit**

```bash
cd /Users/pablofernandez/Work/TENEX-ff3ssq && git add src/commands/agent/import/index.ts src/commands/agent/index.ts src/index.ts && git commit -m "feat(import): wire tenex agent import openclaw command"
```

---

## Verification

After all tasks complete:

```bash
# Run all new tests
bun test src/commands/agent/import/__tests__/

# Typecheck
bun run typecheck

# Live integration test (requires real OpenClaw install)
bun run src/index.ts agent import openclaw
```

Expected final output:
```
Found OpenClaw installation at: /Users/pablofernandez/.openclaw
Found 1 agent(s) to import.

Distilling identity for agent 'main'...
  ✓ Imported: Odyssey (odyssey)
    Keypair:   <64-char hex pubkey>
    Model:     anthropic:claude-sonnet-4-6
    Home dir:  ~/.tenex/agents/<pubkey>/
    Symlinks:  MEMORY.md, memory/
  ✓ USER.md appended to global system prompt

Import complete.
```
