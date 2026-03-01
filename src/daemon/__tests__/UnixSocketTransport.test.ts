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

        const dataPromise = new Promise<string>((resolve) => {
            client.once("data", (data) => resolve(data.toString()));
        });

        transport.write({
            agent_pubkey: "abc123",
            conversation_id: "def456",
            data: { type: "text-delta", textDelta: "Hello" },
        });

        const received = await dataPromise;
        const parsed = JSON.parse(received.trim());
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

    test("broadcasts to multiple clients", async () => {
        await transport.start();

        const client1 = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client1.on("connect", resolve));

        const client2 = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client2.on("connect", resolve));

        // Both clients should receive the chunk
        const data1 = new Promise<string>((resolve) => {
            client1.once("data", (data) => resolve(data.toString()));
        });
        const data2 = new Promise<string>((resolve) => {
            client2.once("data", (data) => resolve(data.toString()));
        });

        transport.write({
            agent_pubkey: "abc123",
            conversation_id: "def456",
            data: { type: "text-delta", textDelta: "Hello" },
        });

        const [received1, received2] = await Promise.all([data1, data2]);
        expect(JSON.parse(received1.trim()).data.textDelta).toBe("Hello");
        expect(JSON.parse(received2.trim()).data.textDelta).toBe("Hello");

        client1.destroy();
        client2.destroy();
    });

    test("continues broadcasting after one client disconnects", async () => {
        await transport.start();

        const client1 = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client1.on("connect", resolve));

        const client2 = net.createConnection(testSocketPath);
        await new Promise<void>((resolve) => client2.on("connect", resolve));

        // Disconnect client1
        client1.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Client2 should still receive chunks
        const data2 = new Promise<string>((resolve) => {
            client2.once("data", (data) => resolve(data.toString()));
        });

        transport.write({
            agent_pubkey: "abc123",
            conversation_id: "def456",
            data: { type: "text-delta", textDelta: "Still here" },
        });

        const received = await data2;
        expect(JSON.parse(received.trim()).data.textDelta).toBe("Still here");

        client2.destroy();
    });
});
