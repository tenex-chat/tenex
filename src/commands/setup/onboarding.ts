import * as os from "node:os";
import * as path from "node:path";
import { ensureDirectory } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { Command } from "commander";
import inquirer from "inquirer";

export const onboardingCommand = new Command("init")
    .description("Initial setup wizard for TENEX")
    .action(async () => {
        try {
            console.log("\nWelcome to TENEX! Let's get you set up.\n");

            // Load existing configuration
            const globalPath = config.getGlobalPath();
            await ensureDirectory(globalPath);
            const existingConfig = await config.loadTenexConfig(globalPath);

            // Step 1: Manage whitelisted pubkeys
            let whitelistedPubkeys = [...(existingConfig.whitelistedPubkeys || [])];

            // Create temporary NDK instance for fetching users
            const tempNdk = new NDK({
                explicitRelayUrls: [
                    "wss://relay.damus.io",
                    "wss://nos.lol",
                    "wss://relay.nostr.band",
                ],
            });
            await tempNdk.connect();

            let managingPubkeys = true;
            while (managingPubkeys) {
                // If no pubkeys, go directly to adding one
                if (whitelistedPubkeys.length === 0) {
                    const { userIdentifier } = await inquirer.prompt([
                        {
                            type: "input",
                            name: "userIdentifier",
                            message: "Enter npub, nprofile, or NIP-05 identifier to whitelist:",
                            validate: (input: string) => {
                                if (!input || input.trim().length === 0) {
                                    return "Please enter a valid identifier";
                                }
                                return true;
                            },
                        },
                    ]);

                    try {
                        const user = await tempNdk.getUser({ npub: userIdentifier.trim() });
                        if (!user?.pubkey) {
                            console.log("❌ Failed to fetch user. Please try again.\n");
                        } else {
                            whitelistedPubkeys.push(user.pubkey);
                            console.log(`✓ Added pubkey: ${user.pubkey}\n`);
                        }
                    } catch {
                        console.log(
                            "❌ Failed to fetch user. Please verify the identifier is correct.\n"
                        );
                    }
                } else {
                    // Show existing pubkeys with option to add new or continue
                    const choices = [
                        ...whitelistedPubkeys.map((pk, idx) => ({
                            name: `${idx + 1}. ${pk}`,
                            value: `remove:${pk}`,
                        })),
                        { name: "➕ Add new pubkey", value: "add" },
                        { name: "✓ Continue", value: "done" },
                    ];

                    const { action } = await inquirer.prompt([
                        {
                            type: "select",
                            name: "action",
                            message: "Whitelisted pubkeys (select to remove, or add new):",
                            choices,
                        },
                    ]);

                    if (action === "done") {
                        managingPubkeys = false;
                    } else if (action === "add") {
                        const { userIdentifier } = await inquirer.prompt([
                            {
                                type: "input",
                                name: "userIdentifier",
                                message: "Enter npub, nprofile, or NIP-05 identifier:",
                                validate: (input: string) => {
                                    if (!input || input.trim().length === 0) {
                                        return "Please enter a valid identifier";
                                    }
                                    return true;
                                },
                            },
                        ]);

                        try {
                            const user = await tempNdk.getUser({ npub: userIdentifier.trim() });
                            if (!user?.pubkey) {
                                console.log("❌ Failed to fetch user. Please try again.\n");
                            } else if (whitelistedPubkeys.includes(user.pubkey)) {
                                console.log("⚠️  Pubkey already in whitelist\n");
                            } else {
                                whitelistedPubkeys.push(user.pubkey);
                                console.log(`✓ Added pubkey: ${user.pubkey}\n`);
                            }
                        } catch {
                            console.log(
                                "❌ Failed to fetch user. Please verify the identifier is correct.\n"
                            );
                        }
                    } else if (action.startsWith("remove:")) {
                        const pubkeyToRemove = action.replace("remove:", "");
                        whitelistedPubkeys = whitelistedPubkeys.filter(
                            (pk) => pk !== pubkeyToRemove
                        );
                        console.log("✓ Removed pubkey\n");
                    }
                }
            }

            // Disconnect temporary NDK
            if (tempNdk.pool?.relays) {
                for (const relay of tempNdk.pool.relays.values()) {
                    relay.disconnect();
                }
            }

            if (whitelistedPubkeys.length === 0) {
                logger.error("At least one whitelisted pubkey is required.");
                process.exit(1);
            }

            // Step 2: Generate or use existing private key for TENEX
            let tenexPrivateKey = existingConfig.tenexPrivateKey;
            if (!tenexPrivateKey) {
                const signer = NDKPrivateKeySigner.generate();
                tenexPrivateKey = signer.privateKey;
                if (!tenexPrivateKey) {
                    logger.error("Failed to generate private key");
                    process.exit(1);
                }
            }

            // Step 3: Ask for projects base directory
            const defaultProjectsBase =
                existingConfig.projectsBase || path.join(os.homedir(), "tenex");
            const { projectsBase } = await inquirer.prompt([
                {
                    type: "input",
                    name: "projectsBase",
                    message: "Where should TENEX store your projects?",
                    default: defaultProjectsBase,
                },
            ]);

            // Step 4: Manage relays
            let relays =
                existingConfig.relays && existingConfig.relays.length > 0
                    ? [...existingConfig.relays]
                    : ["wss://tenex.chat"];

            let managingRelays = true;
            while (managingRelays) {
                // If no relays, go directly to adding one
                if (relays.length === 0) {
                    const { relayUrl } = await inquirer.prompt([
                        {
                            type: "input",
                            name: "relayUrl",
                            message: "Enter relay URL (ws:// or wss://):",
                            validate: (input: string) => {
                                if (!input || input.trim().length === 0) {
                                    return "Please enter a valid relay URL";
                                }
                                try {
                                    const url = new URL(input.trim());
                                    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
                                        return "URL must use ws:// or wss:// protocol";
                                    }
                                    return true;
                                } catch {
                                    return "Invalid URL format";
                                }
                            },
                        },
                    ]);

                    relays.push(relayUrl.trim());
                    console.log(`✓ Added relay: ${relayUrl.trim()}\n`);
                } else {
                    // Show existing relays with option to add new or continue
                    const choices = [
                        ...relays.map((relay, idx) => ({
                            name: `${idx + 1}. ${relay}`,
                            value: `remove:${relay}`,
                        })),
                        { name: "➕ Add new relay", value: "add" },
                        { name: "✓ Continue", value: "done" },
                    ];

                    const { action } = await inquirer.prompt([
                        {
                            type: "select",
                            name: "action",
                            message: "Relay URLs (select to remove, or add new):",
                            choices,
                        },
                    ]);

                    if (action === "done") {
                        managingRelays = false;
                    } else if (action === "add") {
                        const { relayUrl } = await inquirer.prompt([
                            {
                                type: "input",
                                name: "relayUrl",
                                message: "Enter relay URL (ws:// or wss://):",
                                validate: (input: string) => {
                                    if (!input || input.trim().length === 0) {
                                        return "Please enter a valid relay URL";
                                    }
                                    try {
                                        const url = new URL(input.trim());
                                        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
                                            return "URL must use ws:// or wss:// protocol";
                                        }
                                        return true;
                                    } catch {
                                        return "Invalid URL format";
                                    }
                                },
                            },
                        ]);

                        const trimmedUrl = relayUrl.trim();
                        if (relays.includes(trimmedUrl)) {
                            console.log("⚠️  Relay already in list\n");
                        } else {
                            relays.push(trimmedUrl);
                            console.log(`✓ Added relay: ${trimmedUrl}\n`);
                        }
                    } else if (action.startsWith("remove:")) {
                        const relayToRemove = action.replace("remove:", "");
                        relays = relays.filter((r) => r !== relayToRemove);
                        console.log("✓ Removed relay\n");
                    }
                }
            }

            if (relays.length === 0) {
                logger.warn("No relays configured, adding default relay: wss://tenex.chat");
                relays = ["wss://tenex.chat"];
            }

            // Save configuration
            const newConfig = {
                ...existingConfig,
                whitelistedPubkeys,
                tenexPrivateKey,
                projectsBase: path.resolve(projectsBase),
                relays,
            };

            await config.saveGlobalConfig(newConfig);

            // Create projects directory
            await ensureDirectory(path.resolve(projectsBase));

            console.log("\n✓ TENEX setup complete!\n");
            console.log("Configuration saved:");
            console.log(
                `  • Whitelisted pubkeys (${whitelistedPubkeys.length}): ${whitelistedPubkeys.join(", ")}`
            );
            console.log(`  • Projects directory: ${path.resolve(projectsBase)}`);
            console.log(`  • Relays: ${relays.join(", ")}`);
            console.log("\nYou can now start using TENEX!\n");

            process.exit(0);
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                process.exit(0);
            }
            logger.error(`Setup failed: ${error}`);
            process.exit(1);
        }
    });
