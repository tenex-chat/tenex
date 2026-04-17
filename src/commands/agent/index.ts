import { Command } from "commander";
import chalk from "chalk";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import {
    deleteStoredAgent,
    installAgentFromDefinitionEvent,
    installAgentFromDefinitionEventId,
} from "@/services/agents/AgentProvisioningService";
import { importCommand } from "./import/index";
import { AgentManager } from "./AgentManager";

// Initialize NDK and attach the backend signer so NIP-42 AUTH can complete
// before any subscription fires. Without a signer the relay's AUTH challenge
// goes unanswered and reads silently hang until EOSE timeout.
async function initNDKWithBackendAuth(): Promise<void> {
    await initNDK();
    const ndk = getNDK();
    if (!ndk.signer) {
        ndk.signer = await config.getBackendSigner();
    }
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

async function addAgent(options: {
    eventId?: string;
    slug?: string;
}): Promise<void> {
    await initNDKWithBackendAuth();

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

async function manageAgents(): Promise<void> {
    await initNDKWithBackendAuth();
    const manager = new AgentManager();
    await manager.showMainMenu();
}

async function deleteAgent(pubkey: string): Promise<void> {
    await initNDKWithBackendAuth();
    const deleted = await deleteStoredAgent(pubkey);
    if (!deleted) {
        console.error(chalk.red(`Error: agent ${pubkey} not found`));
        process.exit(1);
    }
    console.log(chalk.green(`✓ Deleted agent ${pubkey}`));
}

// ─── Command registration ────────────────────────────────────────────────────

const addCommand = new Command("add")
    .description("Install an agent from a 4199 definition event")
    .option("-e, --event-id <event-id>", "Nostr event ID of the agent definition")
    .option("--slug <slug>", "Override the installed agent slug on first install")
    .action(async (options: { eventId?: string; slug?: string }) => {
        await addAgent(options);
    });

const manageCommand = new Command("manage")
    .description("Open the interactive agent manager")
    .action(async () => {
        await manageAgents();
    });

const deleteCommand = new Command("delete")
    .description("Permanently delete a stored agent")
    .argument("<pubkey>", "Agent public key")
    .action(async (pubkey: string) => {
        await deleteAgent(pubkey);
    });

export const agentCommand = new Command("agent")
    .description("Manage TENEX agents")
    .action(async () => {
        await manageAgents();
    })
    .addCommand(importCommand)
    .addCommand(addCommand)
    .addCommand(deleteCommand)
    .addCommand(manageCommand);
