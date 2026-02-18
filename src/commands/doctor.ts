import { Command } from "commander";
import chalk from "chalk";
import { agentStorage } from "@/agents/AgentStorage";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { initNDK, getNDK } from "@/nostr/ndkClient";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export const doctorCommand = new Command("doctor")
    .description("Diagnose and repair TENEX state")
    .option("--agents", "Refetch and update all agent definitions from Nostr")
    .action(async (options) => {
        if (options.agents) {
            await repairAgents();
        } else {
            doctorCommand.help();
        }
    });

async function repairAgents(): Promise<void> {
    await agentStorage.initialize();
    await initNDK();
    const ndk = getNDK();

    const agents = await agentStorage.getAllAgents();
    const nostrAgents = agents.filter((a) => a.eventId);
    const skipped = agents.length - nostrAgents.length;

    console.log(chalk.blue(`Checking ${nostrAgents.length} Nostr agent(s)...`));

    let updated = 0;
    let failed = 0;

    for (const agent of nostrAgents) {
        const signer = new NDKPrivateKeySigner(agent.nsec);
        const pubkey = signer.pubkey;
        const label = `${agent.slug} (${pubkey.substring(0, 8)}...)`;

        const event = await ndk.fetchEvent(agent.eventId!, { groupable: false });
        if (!event) {
            console.log(chalk.yellow(`  ⚠ ${label}: event not found on relays, skipping`));
            failed++;
            continue;
        }

        const agentDef = NDKAgentDefinition.from(event);
        const toolTags = event.tags
            .filter((t) => t[0] === "tool" && t[1])
            .map((t) => t[1] as string);

        const newDefault = {
            ...agent.default,
            tools: toolTags.length > 0 ? toolTags : undefined,
        };
        const updatedAgent = {
            ...agent,
            name: agentDef.title || agent.name,
            role: agentDef.role || agent.role,
            description: agentDef.description ?? agent.description,
            instructions: agentDef.instructions ?? agent.instructions,
            useCriteria: agentDef.useCriteria ?? agent.useCriteria,
            default: Object.values(newDefault).some((v) => v !== undefined) ? newDefault : undefined,
        };

        await agentStorage.saveAgent(updatedAgent);
        console.log(chalk.green(`  ✓ ${label}: updated`));
        updated++;
    }

    console.log(
        chalk.blue(
            `\nDone: ${updated} updated, ${skipped} skipped (no eventId), ${failed} failed`
        )
    );
}
