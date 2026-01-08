import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UnixSocketTransport } from "../UnixSocketTransport";

describe("UnixSocketTransport", () => {
    let transport: UnixSocketTransport;
    let testSocketPath: string;

    beforeEach(() => {
        testSocketPath = path.join(os.tmpdir(), `test-stream-${Date.now()}.sock`);
        transport = new UnixSocketTransport(testSocketPath);
    });

    afterEach(async () => {
        await transport.stop();
        if (fs.existsSync(testSocketPath)) {
            fs.unlinkSync(testSocketPath);
        }
    });

    test("starts and accepts connections", async () => {
        await transport.start();
        expect(fs.existsSync(testSocketPath)).toBe(true);

        const client = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client.on("connect", resolve));

        expect(transport.isConnected()).toBe(true);
        client.destroy();
    });

    test("writes NDJSON chunks to client", async () => {
        await transport.start();

        const client = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client.on("connect", resolve));

        const received: string[] = [];
        client.on("data", (data) => {
            received.push(data.toString());
        });

        transport.write({
            agent_pubkey: "abc123",
            conversation_id: "def456",
            data: { type: "text-delta", textDelta: "Hello" },
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(received.length).toBe(1);
        const parsed = JSON.parse(received[0].trim());
        expect(parsed.agent_pubkey).toBe("abc123");
        expect(parsed.data.textDelta).toBe("Hello");

        client.destroy();
    });

    test("silently drops writes when no client", async () => {
        await transport.start();
        expect(transport.isConnected()).toBe(false);

        // Should not throw
        transport.write({
            agent_pubkey: "abc",
            conversation_id: "def",
            data: {},
        });
    });
});
