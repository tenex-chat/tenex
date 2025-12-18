import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { VCRCassette, VCRInteraction } from "./types";

const CASSETTE_VERSION = "1.0";

/**
 * Loads a cassette from disk.
 * If the file doesn't exist, returns an empty cassette.
 *
 * @param path - Path to the cassette file
 * @param cassetteName - Name for the cassette (used if creating new)
 * @returns The loaded cassette
 */
export async function loadCassette(
    path: string,
    cassetteName: string
): Promise<VCRCassette> {
    try {
        const content = await readFile(path, "utf-8");
        const cassette = JSON.parse(content) as VCRCassette;
        return cassette;
    } catch (error) {
        // If file doesn't exist or is invalid, return empty cassette
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return {
                name: cassetteName,
                version: CASSETTE_VERSION,
                interactions: [],
                metadata: {
                    createdAt: new Date().toISOString(),
                },
            };
        }
        throw error;
    }
}

/**
 * Saves a cassette to disk.
 * Creates the directory if it doesn't exist.
 *
 * @param path - Path to save the cassette file
 * @param cassette - The cassette to save
 */
export async function saveCassette(
    path: string,
    cassette: VCRCassette
): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(path), { recursive: true });

    // Write cassette with pretty formatting
    const content = JSON.stringify(cassette, null, 2);
    await writeFile(path, content, "utf-8");
}

/**
 * Finds an interaction in a cassette by hash.
 * Returns the first matching interaction.
 *
 * @param cassette - The cassette to search
 * @param hash - The hash to find
 * @returns The matching interaction, or undefined if not found
 */
export function findInteraction(
    cassette: VCRCassette,
    hash: string
): VCRInteraction | undefined {
    return cassette.interactions.find(
        (interaction) => interaction.hash === hash
    );
}

/**
 * Adds an interaction to a cassette.
 * If an interaction with the same hash already exists, it is replaced.
 *
 * @param cassette - The cassette to modify
 * @param interaction - The interaction to add
 */
export function addInteraction(
    cassette: VCRCassette,
    interaction: VCRInteraction
): void {
    // Remove any existing interaction with the same hash
    cassette.interactions = cassette.interactions.filter(
        (i) => i.hash !== interaction.hash
    );

    // Add the new interaction
    cassette.interactions.push(interaction);
}
