import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import chalk from "chalk";
import { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { installAgentFromNostr, installAgentFromNostrEvent } from "@/agents/agent-installer";
import { initNDK } from "@/nostr/ndkClient";

// ─── OpenClaw discovery ──────────────────────────────────────────────────────

const OPENCLAW_STATE_DIR_NAMES = [".openclaw", ".clawdbot", ".moldbot", ".moltbot"];
const OPENCLAW_CONFIG_NAMES = ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"];

function findOpenClawStateDir(): string | undefined {
    // 1. Environment variable
    const envPath = process.env.OPENCLAW_STATE_DIR;
    if (envPath && hasOpenClawConfig(envPath)) {
        return envPath;
    }

    // 2. Home directory candidates
    const home = homedir();
    for (const name of OPENCLAW_STATE_DIR_NAMES) {
        const candidate = path.join(home, name);
        if (hasOpenClawConfig(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function hasOpenClawConfig(dir: string): boolean {
    return OPENCLAW_CONFIG_NAMES.some((name) => existsSync(path.join(dir, name)));
}

/** Prettify a slug for display: "main" → "Main", "my-agent" → "My Agent" */
function prettifySlug(slug: string): string {
    return slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface OpenClawAgent {
    name: string;
    slug: string;
    role: string;
}

async function discoverOpenClawAgents(stateDir: string): Promise<OpenClawAgent[]> {
    const agentsDir = path.join(stateDir, "agents");
    try {
        const entries = await fs.readdir(agentsDir, { withFileTypes: true });
        return entries
            .filter((e) => e.isDirectory())
            .map((e) => ({
                name: prettifySlug(e.name),
                slug: e.name,
                role: "",
            }));
    } catch {
        return [];
    }
}

// ─── tenex agent import openclaw ────────────────────────────────────────────

async function importOpenClaw(options: {
    dryRun: boolean;
    json: boolean;
    slugs?: string;
}): Promise<void> {
    const stateDir = findOpenClawStateDir();

    if (!stateDir) {
        if (options.json) {
            console.log("[]");
        } else {
            console.error(chalk.yellow("OpenClaw installation not found."));
        }
        return;
    }

    const agents = await discoverOpenClawAgents(stateDir);

    // Apply slug filter if provided
    const filtered =
        options.slugs
            ? agents.filter((a) => options.slugs!.split(",").map((s) => s.trim()).includes(a.slug))
            : agents;

    if (options.json) {
        console.log(JSON.stringify(filtered, null, 2));
        return;
    }

    if (filtered.length === 0) {
        console.log(chalk.yellow("No OpenClaw agents found."));
        return;
    }

    if (options.dryRun) {
        console.log(chalk.blue(`Would import ${filtered.length} OpenClaw agent(s):`));
        for (const agent of filtered) {
            console.log(chalk.gray(`  ${agent.slug} → "${agent.name}"`));
        }
        return;
    }

    await agentStorage.initialize();

    let imported = 0;
    let skipped = 0;

    for (const agent of filtered) {
        // Check if already exists by slug
        const existing = await agentStorage.getAgentBySlug(agent.slug);
        if (existing) {
            console.log(chalk.gray(`  ${agent.slug}: already exists, skipping`));
            skipped++;
            continue;
        }

        const signer = NDKPrivateKeySigner.generate();
        const stored = createStoredAgent({
            nsec: signer.nsec,
            slug: agent.slug,
            name: agent.name,
            role: agent.role,
        });

        await agentStorage.saveAgent(stored);
        console.log(
            chalk.green(`  ✓ ${agent.slug}`) +
            chalk.gray(` → pubkey ${signer.pubkey.substring(0, 8)}...`)
        );
        imported++;
    }

    console.log(chalk.blue(`\nDone: ${imported} imported, ${skipped} skipped`));
}

// ─── tenex agent add ─────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data.trim()));
        process.stdin.on("error", reject);
    });
}

async function addAgent(eventId: string | undefined): Promise<void> {
    await agentStorage.initialize();

    if (!process.stdin.isTTY) {
        const raw = await readStdin();
        const rawEvent = JSON.parse(raw);
        const event = new NDKEvent(undefined, rawEvent);
        const stored = await installAgentFromNostrEvent(event);
        const pubkey = new NDKPrivateKeySigner(stored.nsec).pubkey;
        console.log(chalk.green(`✓ Installed agent "${stored.name}" (${stored.slug})`));
        console.log(chalk.gray(`  pubkey: ${pubkey}`));
        return;
    }

    if (!eventId) {
        console.error(chalk.red("Error: provide an event ID or pipe event JSON via stdin"));
        process.exit(1);
    }

    await initNDK();
    const stored = await installAgentFromNostr(eventId);
    const pubkey = new NDKPrivateKeySigner(stored.nsec).pubkey;
    console.log(chalk.green(`✓ Installed agent "${stored.name}" (${stored.slug})`));
    console.log(chalk.gray(`  pubkey: ${pubkey}`));
}

// ─── Command registration ────────────────────────────────────────────────────

const importOpenClawCommand = new Command("openclaw")
    .description("Import agents from a local OpenClaw installation")
    .option("--dry-run", "Print what would be imported without making changes")
    .option("--json", "Output as JSON array")
    .option("--slugs <slugs>", "Comma-separated list of slugs to import (default: all)")
    .action(async (options) => {
        await importOpenClaw({
            dryRun: !!options.dryRun,
            json: !!options.json,
            slugs: options.slugs,
        });
    });

const importCommand = new Command("import")
    .description("Import agents from external sources")
    .addCommand(importOpenClawCommand);

const addCommand = new Command("add")
    .description("Install an agent from a Nostr event ID or stdin JSON")
    .argument("[event-id]", "Nostr event ID of the agent definition")
    .action(async (eventId: string | undefined) => {
        await addAgent(eventId);
    });

export const agentCommand = new Command("agent")
    .description("Manage TENEX agents")
    .addCommand(importCommand)
    .addCommand(addCommand);
