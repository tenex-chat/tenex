import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { confirm } from "@inquirer/prompts";
import { Command } from "commander";

export const agentRemoveCommand = new Command("remove")
    .description("Remove an agent from a project or globally")
    .argument("<slug>", "Agent slug to remove")
    .option(
        "--project <dTag>",
        "Project d-tag to remove agent from (if not specified, removes globally)"
    )
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (slug: string, options: { project?: string; force?: boolean }) => {
        try {
            // Initialize agent storage
            await agentStorage.initialize();

            // Find the agent by slug
            const agent = await agentStorage.getAgentBySlug(slug);
            if (!agent) {
                logger.error(`Agent "${slug}" not found`);
                process.exit(1);
            }

            // Get pubkey from nsec for removal
            const { NDKPrivateKeySigner } = await import("@nostr-dev-kit/ndk");
            const signer = new NDKPrivateKeySigner(agent.nsec);
            const pubkey = signer.pubkey;

            // If project is specified, remove from that project only
            if (options.project) {
                // Check if agent is in this project
                if (!agent.projects.includes(options.project)) {
                    logger.error(
                        `Agent "${slug}" is not associated with project ${options.project}`
                    );
                    process.exit(1);
                }

                // Confirm deletion unless --force is used
                if (!options.force) {
                    const otherProjects = agent.projects.filter((p) => p !== options.project);
                    let message = `Are you sure you want to remove agent "${agent.name}" (${slug}) from project ${options.project}?`;

                    if (otherProjects.length > 0) {
                        message += `\n  The agent will remain in ${otherProjects.length} other project(s).`;
                    } else {
                        message +=
                            "\n  ⚠️  This is the agent's last project - it will be deleted completely.";
                    }

                    const confirmed = await confirm({
                        message,
                        default: false,
                    });

                    if (!confirmed) {
                        logger.info("Removal cancelled");
                        process.exit(0);
                    }
                }

                // Remove agent from project
                await agentStorage.removeAgentFromProject(pubkey, options.project);

                const otherProjects = agent.projects.filter((p) => p !== options.project);
                if (otherProjects.length > 0) {
                    logger.info(`✅ Agent "${agent.name}" removed from project ${options.project}`);
                    logger.info(`   Agent remains in ${otherProjects.length} other project(s)`);
                } else {
                    logger.info(
                        `✅ Agent "${agent.name}" completely removed (was only in that project)`
                    );
                }
            } else {
                // Remove globally
                if (!options.force) {
                    let message = `Are you sure you want to completely remove agent "${agent.name}" (${slug})?`;
                    if (agent.projects.length > 0) {
                        message += `\n  ⚠️  This will remove the agent from ${agent.projects.length} project(s): ${agent.projects.join(", ")}`;
                    }

                    const confirmed = await confirm({
                        message,
                        default: false,
                    });

                    if (!confirmed) {
                        logger.info("Removal cancelled");
                        process.exit(0);
                    }
                }

                // Remove agent completely
                await agentStorage.deleteAgent(pubkey);
                logger.info(`✅ Agent "${agent.name}" completely removed`);
            }

            process.exit(0);
        } catch (error) {
            logger.error("Failed to remove agent:", error);
            process.exit(1);
        }
    });
