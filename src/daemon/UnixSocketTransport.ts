import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { StreamTransport } from "@/llm";
import type { LocalStreamChunk } from "@/llm";
import { logger } from "@/utils/logger";

/** Extract a brief caller context from stack trace for debugging */
function getCallerContext(): string {
    const stack = new Error().stack;
    if (!stack) return "unknown";
    // Skip first 3 lines: Error, getCallerContext, cleanup/caller
    const lines = stack.split("\n").slice(3, 6);
    return lines.map((l) => l.trim()).join(" <- ");
}

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
        logger.info("[UnixSocketTransport] start() called", {
            socketPath: this.socketPath,
        });

        // Check for existing socket and log details
        const existingSocketInfo = this.getSocketFileInfo();
        if (existingSocketInfo.exists) {
            logger.warn("[UnixSocketTransport] Stale socket found before start", {
                socketPath: this.socketPath,
                ...existingSocketInfo,
            });
        }

        // Clean up stale socket
        this.cleanup("start() - cleaning stale socket before creating new one");

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                logger.info("[UnixSocketTransport] Client connected to streaming socket", {
                    socketPath: this.socketPath,
                });

                // Only one client at a time
                if (this.client) {
                    logger.warn("[UnixSocketTransport] Replacing existing client connection", {
                        socketPath: this.socketPath,
                    });
                    this.client.destroy();
                }

                this.client = socket;

                socket.on("close", () => {
                    logger.info("[UnixSocketTransport] Client disconnected from streaming socket", {
                        socketPath: this.socketPath,
                    });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });

                socket.on("error", (err) => {
                    logger.error("[UnixSocketTransport] Socket client error", {
                        error: err.message,
                        socketPath: this.socketPath,
                    });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });
            });

            this.server.on("error", (err) => {
                logger.error("[UnixSocketTransport] Socket server error", {
                    error: err.message,
                    socketPath: this.socketPath,
                });
                reject(err);
            });

            this.server.listen(this.socketPath, () => {
                logger.info("[UnixSocketTransport] Streaming socket started and listening", {
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
            logger.error("Failed to write chunk", { error: err });
        }
    }

    isConnected(): boolean {
        return this.client !== null && !this.client.destroyed;
    }

    async stop(): Promise<void> {
        const callerContext = getCallerContext();
        logger.info("[UnixSocketTransport] stop() called", {
            socketPath: this.socketPath,
            hasClient: !!this.client,
            hasServer: !!this.server,
            callerContext,
        });

        if (this.client) {
            logger.info("[UnixSocketTransport] Destroying client connection in stop()", {
                socketPath: this.socketPath,
            });
            this.client.destroy();
            this.client = null;
        }

        return new Promise((resolve) => {
            if (this.server) {
                logger.info("[UnixSocketTransport] Closing server in stop()", {
                    socketPath: this.socketPath,
                });
                this.server.close(() => {
                    logger.info("[UnixSocketTransport] Server closed, now calling cleanup()", {
                        socketPath: this.socketPath,
                    });
                    this.cleanup("stop() - server closed callback");
                    logger.info("[UnixSocketTransport] stop() completed", {
                        socketPath: this.socketPath,
                    });
                    resolve();
                });
            } else {
                logger.info("[UnixSocketTransport] stop() called but no server to close", {
                    socketPath: this.socketPath,
                });
                resolve();
            }
        });
    }

    /**
     * Get file info for the socket path (for debugging)
     */
    private getSocketFileInfo(): {
        exists: boolean;
        isSocket?: boolean;
        isFile?: boolean;
        mode?: string;
        mtime?: string;
        age?: string;
        error?: string;
    } {
        try {
            if (!fs.existsSync(this.socketPath)) {
                return { exists: false };
            }
            const stats = fs.statSync(this.socketPath);
            const ageMs = Date.now() - stats.mtime.getTime();
            return {
                exists: true,
                isSocket: stats.isSocket(),
                isFile: stats.isFile(),
                mode: stats.mode.toString(8),
                mtime: stats.mtime.toISOString(),
                age: `${Math.floor(ageMs / 1000)}s`,
            };
        } catch (err) {
            return {
                exists: false,
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
        const result = {
            exists: info.exists,
            isSocket: info.isSocket ?? false,
            serverRunning: this.server !== null && this.server.listening,
            clientConnected: this.isConnected(),
        };
        logger.debug("[UnixSocketTransport] Health check", {
            socketPath: this.socketPath,
            ...result,
        });
        return result;
    }

    private cleanup(reason: string): void {
        const callerContext = getCallerContext();
        const timestamp = new Date().toISOString();

        logger.info("[UnixSocketTransport] cleanup() called", {
            socketPath: this.socketPath,
            reason,
            callerContext,
            timestamp,
        });

        try {
            const existsBefore = fs.existsSync(this.socketPath);

            if (existsBefore) {
                // Get file info before unlinking
                const fileInfo = this.getSocketFileInfo();
                logger.info("[UnixSocketTransport] About to unlink socket", {
                    socketPath: this.socketPath,
                    reason,
                    fileInfo,
                    timestamp,
                });

                fs.unlinkSync(this.socketPath);

                logger.info("[UnixSocketTransport] Socket unlinked successfully", {
                    socketPath: this.socketPath,
                    reason,
                    timestamp,
                });
            } else {
                logger.debug("[UnixSocketTransport] cleanup() - socket does not exist, nothing to unlink", {
                    socketPath: this.socketPath,
                    reason,
                    timestamp,
                });
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const errorCode = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;

            logger.error("[UnixSocketTransport] cleanup() failed to unlink socket", {
                socketPath: this.socketPath,
                reason,
                error: errorMessage,
                errorCode,
                callerContext,
                timestamp,
            });
        }
    }

    getSocketPath(): string {
        return this.socketPath;
    }
}
