import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { StreamTransport } from "@/llm";
import type { LocalStreamChunk } from "@/llm";
import { logger } from "@/utils/logger";

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
        // Clean up stale socket
        this.cleanup();

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                logger.info("Client connected to streaming socket");

                // Only one client at a time
                if (this.client) {
                    logger.warn("Replacing existing client connection");
                    this.client.destroy();
                }

                this.client = socket;

                socket.on("close", () => {
                    logger.info("Client disconnected from streaming socket");
                    if (this.client === socket) {
                        this.client = null;
                    }
                });

                socket.on("error", (err) => {
                    logger.error("Socket client error", { error: err.message });
                    if (this.client === socket) {
                        this.client = null;
                    }
                });
            });

            this.server.on("error", (err) => {
                logger.error("Socket server error", { error: err.message });
                reject(err);
            });

            this.server.listen(this.socketPath, () => {
                logger.info("Streaming socket started", { path: this.socketPath });
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
        console.log("stop() called");
        if (this.client) {
            console.log("destroying client");
            this.client.destroy();
            this.client = null;
        }

        return new Promise((resolve) => {
            if (this.server) {
                console.log("closing server");
                this.server.close(() => {
                    console.log("server closed");
                    this.cleanup();
                    resolve();
                });
            } else {
                console.log("no server to close");
                resolve();
            }
        });
    }

    private cleanup(): void {
        try {
            console.log("cleaning up socket path", this.socketPath);
            if (fs.existsSync(this.socketPath)) {
                fs.unlinkSync(this.socketPath);
            }
        } catch (e) {
            // Ignore cleanup errors
            console.log("cleanup error", e);
        }
    }

    getSocketPath(): string {
        return this.socketPath;
    }
}
