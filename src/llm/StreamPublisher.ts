import type { LocalStreamChunk } from "./types";

/**
 * Interface for stream transports (Unix socket, future Nostr ephemeral)
 */
export interface StreamTransport {
    write(chunk: LocalStreamChunk): void;
    isConnected(): boolean;
}

/**
 * Publishes AI SDK chunks to connected transports
 * Fire-and-forget: silently drops if no transport connected
 */
export class StreamPublisher {
    private transport: StreamTransport | null = null;

    setTransport(transport: StreamTransport | null): void {
        this.transport = transport;
    }

    write(chunk: LocalStreamChunk): void {
        if (this.transport?.isConnected()) {
            this.transport.write(chunk);
        }
    }

    isConnected(): boolean {
        return this.transport?.isConnected() ?? false;
    }
}

/** Singleton instance */
export const streamPublisher = new StreamPublisher();
