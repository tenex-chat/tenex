import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { StreamTransport } from "@/llm";
import type { LocalStreamChunk } from "@/llm";
import { logger } from "@/utils/logger";

const LOG_PREFIX = "[UnixSocketTransport]";

/** Extract a brief caller context from stack trace for debugging (only computed when debug logging enabled) */
function getCallerContext(): string | undefined {
    // Only compute stack trace if debug logging is actually enabled
    // This avoids the expensive stack capture in production
    if (!logger.isLevelEnabled?.("debug")) {
        return undefined;
    }
    const stack = new Error().stack;
    if (!stack) return undefined;
    // Skip first 3 lines: Error, getCallerContext, cleanup/caller
    const lines = stack.split("\n").slice(3, 6);
    return lines.map((l) => l.trim()).join(" <- ");
}

/** Result of checking socket file info */
type SocketFileInfoResult =
    | { status: "ok"; exists: true; isSocket: boolean; isFile: boolean; mode: string; mtime: string; age: string }
    | { status: "ok"; exists: false }
    | { status: "error"; error: string };

/**
 * Unix domain socket transport for local streaming
 * Single client connection model
 */
export class UnixSocketTransport implements StreamTransport {
    private server: net.Server | null = null;
    private client: net.Socket | null = null;
    private socketPath: string;

    constructor(socketPath?: string) {
        this.socketPath = socketPath ?? this.defaultSocketPath();
    }

    private defaultSocketPath(): string {
        const runtimeDir = process.env.XDG_RUNTIME_DIR;
        if (runtimeDir) {
            return path.join(runtimeDir, "tenex-stream.sock");
        }
        return "/tmp/tenex-stream.sock";
    }

    async start(): Promise<void> {
        logger.info(`${LOG_PREFIX} start() called`, {
            socketPath: this.socketPath,
        });

        // Check for existing socket and log details
        const existingSocketInfo = this.getSocketFileInfo();
        if (existingSocketInfo.status === "ok" && existingSocketInfo.exists) {
            logger.warn(`${LOG_PREFIX} Stale socket found before start`, {
                socketPath: this.socketPath,
                isSocket: existingSocketInfo.isSocket,
                age: existingSocketInfo.age,
            });
        } else if (existingSocketInfo.status === "error") {
            logger.error(`${LOG_PREFIX} Failed to check socket file before start`, {
                socketPath: this.socketPath,
                error: existingSocketInfo.error,
            });
        }

        // Clean up stale socket, passing the file info we already have
        this.cleanup("start() - cleaning stale socket before creating new one", existingSocketInfo);

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                logger.info(`${LOG_PREFIX} Client connected to streaming socket`, {
                    socketPath: this.socketPath,
                });

                // Only one client at a time
                if (this.client) {
                    logger.warn(`${LOG_PREFIX} Replacing existing client connection`, {
                        socketPath: this.socketPath,
                    });
                    this.client.destroy();
                }

                this.client = socket;

                socket.on("close", () => {
                    logger.info(`${LOG_PREFIX} Client disconnected from streaming socket`, {
                        socketPath: this.socketPath,
                    });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });

                socket.on("error", (err) => {
                    logger.error(`${LOG_PREFIX} Socket client error`, {
                        error: err.message,
                        socketPath: this.socketPath,
                    });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });
            });

            this.server.on("error", (err) => {
                logger.error(`${LOG_PREFIX} Socket server error`, {
                    error: err.message,
                    socketPath: this.socketPath,
                });
                reject(err);
            });

            this.server.listen(this.socketPath, () => {
                logger.info(`${LOG_PREFIX} Streaming socket started and listening`, {
                    socketPath: this.socketPath,
                });
                resolve();
            });
        });
    }

    write(chunk: LocalStreamChunk): void {
        if (!this.client) return;

        try {
            const line = JSON.stringify(chunk) + "\n";
            this.client.write(line);
        } catch (err) {
            logger.error(`${LOG_PREFIX} Failed to write chunk`, {
                error: err instanceof Error ? err.message : String(err),
                socketPath: this.socketPath,
            });
        }
    }

    isConnected(): boolean {
        return this.client !== null && !this.client.destroyed;
    }

    async stop(): Promise<void> {
        const callerContext = getCallerContext();
        logger.info(`${LOG_PREFIX} stop() called`, {
            socketPath: this.socketPath,
            hasClient: !!this.client,
            hasServer: !!this.server,
            ...(callerContext && { callerContext }),
        });

        if (this.client) {
            logger.info(`${LOG_PREFIX} Destroying client connection in stop()`, {
                socketPath: this.socketPath,
            });
            this.client.destroy();
            this.client = null;
        }

        return new Promise((resolve) => {
            if (this.server) {
                logger.info(`${LOG_PREFIX} Closing server in stop()`, {
                    socketPath: this.socketPath,
                });
                this.server.close(() => {
                    logger.info(`${LOG_PREFIX} Server closed, now calling cleanup()`, {
                        socketPath: this.socketPath,
                    });
                    this.cleanup("stop() - server closed callback");
                    logger.info(`${LOG_PREFIX} stop() completed`, {
                        socketPath: this.socketPath,
                    });
                    resolve();
                });
            } else {
                logger.info(`${LOG_PREFIX} stop() called but no server to close`, {
                    socketPath: this.socketPath,
                });
                resolve();
            }
        });
    }

    /**
     * Get file info for the socket path (for debugging)
     * Returns discriminated result: ok (exists/not), or error
     */
    private getSocketFileInfo(): SocketFileInfoResult {
        try {
            const stats = fs.lstatSync(this.socketPath);
            const ageMs = Date.now() - stats.mtime.getTime();
            return {
                status: "ok",
                exists: true,
                isSocket: stats.isSocket(),
                isFile: stats.isFile(),
                mode: stats.mode.toString(8),
                mtime: stats.mtime.toISOString(),
                age: `${Math.floor(ageMs / 1000)}s`,
            };
        } catch (err) {
            // ENOENT means file doesn't exist - that's a valid "missing" result
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
                return { status: "ok", exists: false };
            }
            // Any other error (permission, IO, etc.) is an actual error
            return {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Check if socket exists and is healthy
     */
    checkSocketHealth(): {
        exists: boolean;
        isSocket: boolean;
        serverRunning: boolean;
        clientConnected: boolean;
    } {
        const info = this.getSocketFileInfo();
        const exists = info.status === "ok" && info.exists;
        const isSocket = info.status === "ok" && info.exists && info.isSocket;
        const result = {
            exists,
            isSocket,
            serverRunning: this.server !== null && this.server.listening,
            clientConnected: this.isConnected(),
        };
        logger.debug(`${LOG_PREFIX} Health check`, {
            socketPath: this.socketPath,
            ...result,
        });
        return result;
    }

    /**
     * Clean up socket file if it exists and is safe to remove
     * @param reason - Why cleanup is being called (for logging)
     * @param fileInfo - Optional pre-fetched file info to avoid redundant FS calls
     */
    private cleanup(reason: string, fileInfo?: SocketFileInfoResult): void {
        const callerContext = getCallerContext();

        logger.info(`${LOG_PREFIX} cleanup() called`, {
            socketPath: this.socketPath,
            reason,
            ...(callerContext && { callerContext }),
        });

        // Use provided file info or fetch it
        const info = fileInfo ?? this.getSocketFileInfo();

        // Handle error case
        if (info.status === "error") {
            logger.error(`${LOG_PREFIX} cleanup() cannot proceed - failed to check socket file`, {
                socketPath: this.socketPath,
                reason,
                error: info.error,
            });
            return;
        }

        // Nothing to clean up
        if (!info.exists) {
            logger.debug(`${LOG_PREFIX} cleanup() - socket does not exist, nothing to unlink`, {
                socketPath: this.socketPath,
                reason,
            });
            return;
        }

        // CRITICAL SAFETY CHECK: Only unlink if it's actually a socket
        if (!info.isSocket) {
            logger.error(`${LOG_PREFIX} cleanup() REFUSED to unlink - path is not a socket`, {
                socketPath: this.socketPath,
                reason,
                isFile: info.isFile,
                mode: info.mode,
            });
            return;
        }

        // Safe to unlink - it's a socket
        try {
            logger.info(`${LOG_PREFIX} About to unlink socket`, {
                socketPath: this.socketPath,
                reason,
                age: info.age,
            });

            fs.unlinkSync(this.socketPath);

            logger.info(`${LOG_PREFIX} Socket unlinked successfully`, {
                socketPath: this.socketPath,
                reason,
            });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const errorCode = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;

            logger.error(`${LOG_PREFIX} cleanup() failed to unlink socket`, {
                socketPath: this.socketPath,
                reason,
                error: errorMessage,
                errorCode,
            });
        }
    }

    getSocketPath(): string {
        return this.socketPath;
    }
}
