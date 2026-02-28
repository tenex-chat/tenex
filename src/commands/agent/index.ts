import { Command } from "commander";
import chalk from "chalk";
import { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk";
import { agentStorage } from "@/agents/AgentStorage";
import { installAgentFromNostr, installAgentFromNostrEvent } from "@/agents/agent-installer";
import { initNDK } from "@/nostr/ndkClient";
import { importCommand } from "./import/index";

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

// ─── tenex agent assign ─────────────────────────────────────────────────────

async function assignAgent(slug: string, projectDTag: string): Promise<void> {
    await agentStorage.initialize();

    const agent = await agentStorage.getAgentBySlug(slug);
    if (!agent) {
        console.error(chalk.red(`Error: no agent found with slug "${slug}"`));
        process.exit(1);
    }

    const pubkey = new NDKPrivateKeySigner(agent.nsec).pubkey;
    await agentStorage.addAgentToProject(pubkey, projectDTag);

    console.log(chalk.green(`✓ Assigned agent "${slug}" to project "${projectDTag}"`));
}

// ─── Command registration ────────────────────────────────────────────────────

const addCommand = new Command("add")
    .description("Install an agent from a Nostr event ID or stdin JSON")
    .argument("[event-id]", "Nostr event ID of the agent definition")
    .action(async (eventId: string | undefined) => {
        await addAgent(eventId);
    });

const assignCommand = new Command("assign")
    .description("Assign an existing agent to a project")
    .argument("<slug>", "Agent slug")
    .argument("<project-dtag>", "Project d-tag to assign the agent to")
    .action(async (slug: string, projectDTag: string) => {
        await assignAgent(slug, projectDTag);
    });

export const agentCommand = new Command("agent")
    .description("Manage TENEX agents")
    .addCommand(importCommand)
    .addCommand(addCommand)
    .addCommand(assignCommand);
