import { Command } from "commander";
import chalk from "chalk";
import { agentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { initNDK, getNDK } from "@/nostr/ndkClient";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

const refetchCommand = new Command("refetch")
    .description("Refetch and update all agent definitions from Nostr")
    .action(repairAgents);

const orphansCommand = new Command("orphans")
    .description("List agents not assigned to any project")
    .option("--purge", "Delete orphaned agents")
    .action(async (options) => {
        await findOrphanedAgents(!!options.purge);
    });

const agentsCommand = new Command("agents")
    .description("Agent diagnostics and repair")
    .addCommand(refetchCommand)
    .addCommand(orphansCommand);

export const doctorCommand = new Command("doctor")
    .description("Diagnose and repair TENEX state")
    .addCommand(agentsCommand);

function agentChanged(before: StoredAgent, after: StoredAgent): boolean {
    if (before.name !== after.name) return true;
    if (before.role !== after.role) return true;
    if (before.description !== after.description) return true;
    if (before.instructions !== after.instructions) return true;
    if (before.useCriteria !== after.useCriteria) return true;
    const oldTools = before.default?.tools?.slice().sort().join("\0") ?? "";
    const newTools = after.default?.tools?.slice().sort().join("\0") ?? "";
    return oldTools !== newTools;
}

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
        const pubkey = new NDKPrivateKeySigner(agent.nsec).pubkey;
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

        const toolsDisplay = toolTags.length > 0 ? toolTags.join(", ") : "(none)";
        const suffix = chalk.gray(`  [tools: ${toolsDisplay}]`);

        if (agentChanged(agent, updatedAgent)) {
            await agentStorage.saveAgent(updatedAgent);
            console.log(chalk.green(`  ✓ ${label}: updated`) + suffix);
            updated++;
        } else {
            console.log(chalk.gray(`  ${label}: ok`) + suffix);
        }
    }

    console.log(
        chalk.blue(
            `\nDone: ${updated} updated, ${skipped} skipped (no eventId), ${failed} failed`
        )
    );
}

async function findOrphanedAgents(purge: boolean): Promise<void> {
    await agentStorage.initialize();
    const agents = await agentStorage.getAllAgents();

    const orphans: Array<{ agent: StoredAgent; pubkey: string }> = [];
    for (const agent of agents) {
        const pubkey = new NDKPrivateKeySigner(agent.nsec).pubkey;
        const projects = await agentStorage.getAgentProjects(pubkey);
        if (projects.length === 0) {
            orphans.push({ agent, pubkey });
        }
    }

    if (orphans.length === 0) {
        console.log(chalk.green("No orphaned agents found."));
        return;
    }

    console.log(chalk.yellow(`Found ${orphans.length} orphaned agent(s):`));
    for (const { agent, pubkey } of orphans) {
        const source = agent.eventId ? `nostr:${agent.eventId.substring(0, 8)}...` : "local";
        console.log(chalk.gray(`  ${agent.slug} (${pubkey.substring(0, 8)}...)  [${source}]`));
    }

    if (!purge) return;

    console.log(chalk.blue(`\nPurging ${orphans.length} orphaned agent(s)...`));
    for (const { agent, pubkey } of orphans) {
        await agentStorage.deleteAgent(pubkey);
        console.log(chalk.green(`  ✓ deleted ${agent.slug}`));
    }
    console.log(chalk.blue(`Done: ${orphans.length} deleted`));
}
