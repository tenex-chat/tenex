import { createConnection } from "node:net";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";

/**
 * Unix-socket client for the `tenex-identity` daemon.
 *
 * Wire protocol (see `crates/tenex-identity/src/protocol.rs`):
 *   `RESOLVE <hex_pubkey>\n` -> `<json>\n`  (IdentityView object, null fields if not found)
 *   `STATUS\n`               -> `OK cache=N\n`
 */
const SOCKET_BASENAME = "identity.sock";
const QUERY_TIMEOUT_MS = 2000;

function socketPath(): string {
    return join(getTenexBasePath(), SOCKET_BASENAME);
}

export class IdentityDaemonError extends Error {}

export interface ResolvedIdentity {
    pubkey: string;
    event_id?: string | null;
    display_name?: string | null;
    name?: string | null;
    nip05?: string | null;
    picture?: string | null;
    banner?: string | null;
    about?: string | null;
    lud16?: string | null;
    fetched_at: number;
}

/**
 * Ask the identity daemon to resolve a pubkey. Resolves to a `ResolvedIdentity`
 * if found, or `null` if the daemon could not locate a kind:0 event for this pubkey.
 *
 * Throws `IdentityDaemonError` on transport errors (daemon not running, timeout,
 * malformed response). Callers should catch and fall back to other resolution methods.
 */
export function resolveIdentity(pubkey: string): Promise<ResolvedIdentity | null> {
    return new Promise((resolve, reject) => {
        const sock = createConnection({ path: socketPath() });
        let buf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            sock.destroy();
            reject(
                new IdentityDaemonError(
                    `identity daemon timed out after ${QUERY_TIMEOUT_MS}ms`
                )
            );
        }, QUERY_TIMEOUT_MS);

        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            action();
        };

        sock.on("connect", () => {
            sock.write(`RESOLVE ${pubkey}\n`);
        });

        sock.on("data", (chunk) => {
            buf += chunk.toString("utf-8");
            const newlineIdx = buf.indexOf("\n");
            if (newlineIdx < 0) return;
            const line = buf.slice(0, newlineIdx).trim();
            if (line === "ERR") {
                finish(() =>
                    reject(new IdentityDaemonError(`identity daemon returned ERR for pubkey: ${pubkey}`))
                );
                return;
            }
            try {
                const parsed = JSON.parse(line) as ResolvedIdentity;
                // event_id is set iff the daemon found a kind:0 event for this pubkey.
                // A synthetic "not found" response has event_id == null.
                finish(() => resolve(parsed.event_id == null ? null : parsed));
            } catch {
                finish(() =>
                    reject(
                        new IdentityDaemonError(
                            `identity daemon returned unparseable response: ${line}`
                        )
                    )
                );
            }
        });

        sock.on("error", (err) => {
            finish(() =>
                reject(
                    new IdentityDaemonError(
                        `identity daemon connect failed: ${err.message}`
                    )
                )
            );
        });

        sock.on("end", () => {
            if (settled) return;
            finish(() =>
                reject(
                    new IdentityDaemonError(
                        "identity daemon closed connection without response"
                    )
                )
            );
        });
    });
}
