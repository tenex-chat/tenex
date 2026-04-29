import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import inquirer from "inquirer";

const ENV_VAR = "TENEX_NSEC";

function buildSigner(nsec: string): NDKPrivateKeySigner {
    try {
        return new NDKPrivateKeySigner(nsec.trim());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not load owner nsec: ${message}`, { cause: error });
    }
}

async function promptForNsec(): Promise<{ nsec: string; persist: boolean } | null> {
    const { nsec } = await inquirer.prompt([{
        type: "password",
        name: "nsec",
        message: "Owner nsec (hex or bech32) — leave blank to abort:",
        mask: "*",
        theme: inquirerTheme,
    }]);

    const trimmed = (nsec as string | undefined)?.trim() ?? "";
    if (!trimmed) {
        return null;
    }

    const { persist } = await inquirer.prompt([{
        type: "confirm",
        name: "persist",
        message: "Save this nsec to your TENEX config for future sessions?",
        default: false,
        theme: inquirerTheme,
    }]);

    return { nsec: trimmed, persist: Boolean(persist) };
}

/**
 * Resolve the project owner's nsec and return a signer.
 *
 * Source order:
 *   1. `TENEX_NSEC` env var
 *   2. `ownerNsec` field in the global TENEX config
 *   3. Interactive prompt (with optional persistence)
 *
 * Throws if no nsec is provided. The resulting signer's pubkey must still be
 * validated against the project owner pubkey by the publish layer.
 */
export async function resolveOwnerSigner(): Promise<NDKPrivateKeySigner> {
    const envNsec = process.env[ENV_VAR]?.trim();
    if (envNsec) {
        return buildSigner(envNsec);
    }

    const globalPath = configService.getGlobalPath();
    const tenexConfig = await configService.loadTenexConfig(globalPath);
    const configuredNsec = tenexConfig.ownerNsec?.trim();
    if (configuredNsec) {
        return buildSigner(configuredNsec);
    }

    console.log(chalk.dim(
        `\nNo owner nsec configured. Set $${ENV_VAR}, populate "ownerNsec" in TENEX config, or enter it now.`,
    ));

    const prompted = await promptForNsec();
    if (!prompted) {
        throw new Error(
            `Owner nsec required: set $${ENV_VAR} or "ownerNsec" in TENEX config.`,
        );
    }

    const signer = buildSigner(prompted.nsec);

    if (prompted.persist) {
        tenexConfig.ownerNsec = prompted.nsec;
        await configService.saveGlobalConfig(tenexConfig);
        logger.info("Saved owner nsec to TENEX config");
    }

    return signer;
}
