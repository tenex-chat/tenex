import { Command } from "commander";
import chalk from "chalk";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { deleteStoredAgent } from "@/services/agents/AgentProvisioningService";
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
    .addCommand(deleteCommand)
    .addCommand(manageCommand);
