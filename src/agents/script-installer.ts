import * as fs from "node:fs/promises";
import * as path from "node:path";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { ensureDirectory } from "@/lib/fs";
import { logger } from "@/utils/logger";

/**
 * Information about a script file from a NIP-94 (kind 1063) event
 */
export interface ScriptFileInfo {
    eventId: string;
    url: string;
    relativePath: string;
    mimeType?: string;
    sha256?: string;
}

/**
 * Result of downloading and installing a script
 */
export interface ScriptInstallResult {
    eventId: string;
    relativePath: string;
    absolutePath: string;
    success: boolean;
    error?: string;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Extract script file information from a kind 1063 (NIP-94 file metadata) event.
 *
 * Expected tags:
 * - ["url", "https://blossom.server/sha256"] - Required: Blossom download URL
 * - ["name", "scripts/research.py"] - Required: Relative filepath from agent's home
 * - ["m", "text/x-python"] - Optional: MIME type
 * - ["x", "sha256hash"] - Optional: SHA-256 hash for verification
 *
 * @param event - The kind 1063 event to extract info from
 * @returns Script file info or null if required tags are missing
 */
export function extractScriptFileInfo(event: NDKEvent): ScriptFileInfo | null {
    if (event.kind !== 1063) {
        logger.warn(`Expected kind 1063 event, got kind ${event.kind}`);
        return null;
    }

    const url = event.tagValue("url");
    const relativePath = event.tagValue("name");

    if (!url || !relativePath) {
        logger.warn(`Kind 1063 event ${event.id} missing required tags`, {
            hasUrl: !!url,
            hasName: !!relativePath,
        });
        return null;
    }

    return {
        eventId: event.id,
        url,
        relativePath,
        mimeType: event.tagValue("m") || undefined,
        sha256: event.tagValue("x") || undefined,
    };
}

/**
 * Download a file from a Blossom URL
 *
 * @param url - The Blossom URL to download from
 * @returns The downloaded file content as a Buffer
 */
async function downloadFile(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "TENEX/1.0 (Script Installer)",
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Install a single script file to the agent's home directory.
 *
 * @param scriptInfo - Information about the script to install
 * @param agentPubkey - The agent's public key (determines home directory)
 * @returns Result of the installation
 */
export async function installScriptFile(
    scriptInfo: ScriptFileInfo,
    agentPubkey: string
): Promise<ScriptInstallResult> {
    const homeDir = getAgentHomeDirectory(agentPubkey);
    const absolutePath = path.join(homeDir, scriptInfo.relativePath);

    try {
        // Security check: ensure the path doesn't escape the home directory
        const normalizedPath = path.normalize(absolutePath);
        const normalizedHome = path.normalize(homeDir);
        if (!normalizedPath.startsWith(normalizedHome)) {
            throw new Error(
                `Security violation: path "${scriptInfo.relativePath}" would escape agent home directory`
            );
        }

        // Create parent directories
        const parentDir = path.dirname(absolutePath);
        await ensureDirectory(parentDir);

        // Download the file
        logger.debug(`Downloading script from ${scriptInfo.url}`);
        const content = await downloadFile(scriptInfo.url);

        // TODO: Verify SHA-256 hash if provided
        // if (scriptInfo.sha256) {
        //     const hash = crypto.createHash('sha256').update(content).digest('hex');
        //     if (hash !== scriptInfo.sha256) {
        //         throw new Error(`SHA-256 mismatch: expected ${scriptInfo.sha256}, got ${hash}`);
        //     }
        // }

        // Write the file
        await fs.writeFile(absolutePath, content);

        // Make script executable if it's a script file
        const ext = path.extname(scriptInfo.relativePath).toLowerCase();
        const scriptExtensions = [".sh", ".py", ".rb", ".pl", ".js", ".ts"];
        if (scriptExtensions.includes(ext)) {
            await fs.chmod(absolutePath, 0o755);
        }

        logger.info(`Installed script: ${scriptInfo.relativePath}`, {
            eventId: scriptInfo.eventId,
            absolutePath,
            size: content.length,
        });

        return {
            eventId: scriptInfo.eventId,
            relativePath: scriptInfo.relativePath,
            absolutePath,
            success: true,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to install script: ${scriptInfo.relativePath}`, {
            eventId: scriptInfo.eventId,
            error: errorMessage,
        });

        return {
            eventId: scriptInfo.eventId,
            relativePath: scriptInfo.relativePath,
            absolutePath,
            success: false,
            error: errorMessage,
        };
    }
}

/**
 * Fetch and install all scripts referenced by e-tags in an agent definition.
 *
 * @param scriptETags - Array of script e-tag references from the agent definition
 * @param agentPubkey - The agent's public key
 * @param ndk - NDK instance for fetching events
 * @returns Array of installation results
 */
export async function installAgentScripts(
    scriptETags: Array<{ eventId: string; relayUrl?: string }>,
    agentPubkey: string,
    ndk: NDK
): Promise<ScriptInstallResult[]> {
    if (scriptETags.length === 0) {
        return [];
    }

    logger.info(`Installing ${scriptETags.length} script(s) for agent`, {
        agentPubkey: agentPubkey.substring(0, 8),
    });

    const results: ScriptInstallResult[] = [];

    for (const scriptRef of scriptETags) {
        try {
            // Fetch the 1063 event
            logger.debug(`Fetching script event ${scriptRef.eventId}`);
            const event = await ndk.fetchEvent(scriptRef.eventId, { groupable: false });

            if (!event) {
                results.push({
                    eventId: scriptRef.eventId,
                    relativePath: "unknown",
                    absolutePath: "unknown",
                    success: false,
                    error: `Could not fetch event ${scriptRef.eventId}`,
                });
                continue;
            }

            // Extract script info
            const scriptInfo = extractScriptFileInfo(event);
            if (!scriptInfo) {
                results.push({
                    eventId: scriptRef.eventId,
                    relativePath: "unknown",
                    absolutePath: "unknown",
                    success: false,
                    error: "Event is not a valid kind 1063 file metadata event",
                });
                continue;
            }

            // Install the script
            const result = await installScriptFile(scriptInfo, agentPubkey);
            results.push(result);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            results.push({
                eventId: scriptRef.eventId,
                relativePath: "unknown",
                absolutePath: "unknown",
                success: false,
                error: errorMessage,
            });
        }
    }

    // Log summary
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    if (failCount > 0) {
        logger.warn(`Script installation completed with errors`, {
            success: successCount,
            failed: failCount,
        });
    } else {
        logger.info(`All scripts installed successfully`, { count: successCount });
    }

    return results;
}
