import { createConnection } from "node:net";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";

/**
 * Unix-socket client for the standalone `tenex-whitelist` daemon.
 *
 * Wire protocol (see `whitelist/src/protocol.rs`):
 *   `CHECK <hex_pubkey> <project_dtag>\n` -> `YES\n` | `NO\n`
 *
 * Project dtag is required by the protocol but not consulted server-side
 * (trust set is global on this machine), so callers without a project context
 * may pass any non-empty token.
 */
const SOCKET_BASENAME = "whitelist.sock";
const QUERY_TIMEOUT_MS = 1000;

function socketPath(): string {
    return join(getTenexBasePath(), "whitelist", SOCKET_BASENAME);
}

export class WhitelistDaemonError extends Error {}

/**
 * Ask the whitelist daemon whether `pubkey` is allowed. Resolves to true/false.
 * Throws `WhitelistDaemonError` on transport errors (no daemon, timeout,
 * malformed response) — callers should fail-closed.
 */
export function checkPubkey(pubkey: string, dtag: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const sock = createConnection({ path: socketPath() });
        let buf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            sock.destroy();
            reject(new WhitelistDaemonError(`whitelist daemon timed out after ${QUERY_TIMEOUT_MS}ms`));
        }, QUERY_TIMEOUT_MS);

        const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            action();
        };

        sock.on("connect", () => {
            sock.write(`CHECK ${pubkey} ${dtag}\n`);
        });

        sock.on("data", (chunk) => {
            buf += chunk.toString("utf-8");
            const newlineIdx = buf.indexOf("\n");
            if (newlineIdx < 0) return;
            const line = buf.slice(0, newlineIdx).trim();
            if (line === "YES") {
                finish(() => resolve(true));
            } else if (line === "NO") {
                finish(() => resolve(false));
            } else {
                finish(() =>
                    reject(new WhitelistDaemonError(`unexpected whitelist response: ${line}`))
                );
            }
        });

        sock.on("error", (err) => {
            finish(() =>
                reject(
                    new WhitelistDaemonError(
                        `whitelist daemon connect failed: ${err.message}`
                    )
                )
            );
        });

        sock.on("end", () => {
            if (settled) return;
            finish(() =>
                reject(new WhitelistDaemonError("whitelist daemon closed connection without response"))
            );
        });
    });
}
