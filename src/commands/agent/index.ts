import { Command } from "commander";
import chalk from "chalk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { initNDK } from "@/nostr/ndkClient";
import {
    installAgentFromDefinitionEvent,
    installAgentFromDefinitionEventId,
} from "@/services/agents/AgentProvisioningService";
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

async function addAgent(options: {
    eventId?: string;
    slug?: string;
}): Promise<void> {
    await initNDK();

    if (!process.stdin.isTTY) {
        const raw = await readStdin();
        const rawEvent = JSON.parse(raw);
        const event = new NDKEvent(undefined, rawEvent);
        const result = await installAgentFromDefinitionEvent(event, {
            slugOverride: options.slug,
        });
        console.log(chalk.green(`✓ Installed agent "${result.storedAgent.name}" (${result.storedAgent.slug})`));
        console.log(chalk.gray(`  pubkey: ${result.pubkey}`));
        return;
    }

    if (!options.eventId) {
        console.error(chalk.red("Error: provide --event-id or pipe event JSON via stdin"));
        process.exit(1);
    }

    const result = await installAgentFromDefinitionEventId(options.eventId, {
        slugOverride: options.slug,
    });
    console.log(chalk.green(`✓ Installed agent "${result.storedAgent.name}" (${result.storedAgent.slug})`));
    console.log(chalk.gray(`  pubkey: ${result.pubkey}`));
}

// ─── Command registration ────────────────────────────────────────────────────

const addCommand = new Command("add")
    .description("Install an agent from a 4199 definition event")
    .option("-e, --event-id <event-id>", "Nostr event ID of the agent definition")
    .option("--slug <slug>", "Override the installed agent slug on first install")
    .action(async (options: { eventId?: string; slug?: string }) => {
        await addAgent(options);
    });

export const agentCommand = new Command("agent")
    .description("Manage TENEX agents")
    .addCommand(importCommand)
    .addCommand(addCommand);
