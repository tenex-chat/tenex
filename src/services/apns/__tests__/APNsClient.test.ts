import { describe, expect, it, mock } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

import { APNsClient, type APNsClientConfig } from "../APNsClient";

/**
 * Generate a test EC P-256 key pair and write the private key as a .p8 file.
 */
function generateTestP8Key(): { keyPath: string; cleanup: () => void } {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
    });

    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const keyPath = path.join(os.tmpdir(), `test-apns-key-${Date.now()}.p8`);
    fs.writeFileSync(keyPath, pem);

    return {
        keyPath,
        cleanup: () => {
            try {
                fs.unlinkSync(keyPath);
            } catch {
                // ignore
            }
        },
    };
}

/**
 * Create a mock fetch that returns a configurable response.
 * Returns the mock function and a way to inspect captured calls.
 */
function createMockFetch(status: number, body: unknown = {}) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: url.toString(),
            headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
            body: (init?.body as string) ?? "",
        });
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

    return { mockFetch, calls };
}

/**
 * Create a mock fetch that throws an error.
 */
function createThrowingFetch(errorMessage: string) {
    return (async () => {
        throw new Error(errorMessage);
    }) as typeof fetch;
}

describe("APNsClient", () => {
    describe("JWT generation", () => {
        it("generates a valid JWT structure with ES256", () => {
            const { keyPath, cleanup } = generateTestP8Key();

            try {
                const clientConfig: APNsClientConfig = {
                    keyPath,
                    keyId: "TESTKEY123",
                    teamId: "TESTTEAM",
                    bundleId: "com.test.app",
                    production: false,
                };

                const client = new APNsClient(clientConfig);
                expect(client).toBeDefined();
            } finally {
                cleanup();
            }
        });
    });

    describe("error paths", () => {
        it("returns failure when key file does not exist", async () => {
            const { mockFetch } = createMockFetch(200);

            const client = new APNsClient(
                {
                    keyPath: "/tmp/nonexistent-key-file-12345.p8",
                    keyId: "KEY",
                    teamId: "TEAM",
                    bundleId: "com.test",
                    production: false,
                },
                mockFetch,
            );

            const result = await client.send("some-token", {
                aps: {
                    alert: { title: "T", body: "B" },
                    sound: "default",
                },
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(0);
            expect(result.reason).toBe("network_error");
        });

        it("returns failure when key file contains invalid data", async () => {
            const keyPath = path.join(os.tmpdir(), `test-invalid-key-${Date.now()}.p8`);
            fs.writeFileSync(keyPath, "this is not a valid PEM key");
            const { mockFetch } = createMockFetch(200);

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "KEY",
                        teamId: "TEAM",
                        bundleId: "com.test",
                        production: false,
                    },
                    mockFetch,
                );

                const result = await client.send("some-token", {
                    aps: {
                        alert: { title: "T", body: "B" },
                        sound: "default",
                    },
                });

                expect(result.success).toBe(false);
                expect(result.statusCode).toBe(0);
                expect(result.reason).toBe("network_error");
            } finally {
                try { fs.unlinkSync(keyPath); } catch { /* ignore */ }
            }
        });
    });

    describe("send", () => {
        it("sends to sandbox URL when production is false", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const { mockFetch, calls } = createMockFetch(200);

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "TESTKEY123",
                        teamId: "TESTTEAM",
                        bundleId: "com.test.app",
                        production: false,
                    },
                    mockFetch,
                );

                const result = await client.send("device-token-123", {
                    aps: {
                        alert: { title: "Test", body: "Test body" },
                        sound: "default",
                    },
                });

                expect(result.success).toBe(true);
                expect(result.statusCode).toBe(200);
                expect(calls).toHaveLength(1);
                expect(calls[0]!.url).toContain("api.sandbox.push.apple.com");
                expect(calls[0]!.url).toContain("device-token-123");
                expect(calls[0]!.headers["apns-topic"]).toBe("com.test.app");
                expect(calls[0]!.headers["authorization"]).toMatch(/^bearer /);
            } finally {
                cleanup();
            }
        });

        it("sends to production URL when production is true", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const { mockFetch, calls } = createMockFetch(200);

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "TESTKEY123",
                        teamId: "TESTTEAM",
                        bundleId: "com.test.app",
                        production: true,
                    },
                    mockFetch,
                );

                await client.send("device-token-456", {
                    aps: {
                        alert: { title: "Test", body: "Body" },
                        sound: "default",
                    },
                });

                expect(calls).toHaveLength(1);
                expect(calls[0]!.url).toContain("api.push.apple.com");
                expect(calls[0]!.url).not.toContain("sandbox");
            } finally {
                cleanup();
            }
        });

        it("returns failure with reason on APNs rejection", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const { mockFetch } = createMockFetch(400, { reason: "BadDeviceToken" });

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "KEY",
                        teamId: "TEAM",
                        bundleId: "com.test",
                        production: false,
                    },
                    mockFetch,
                );

                const result = await client.send("bad-token", {
                    aps: {
                        alert: { title: "T", body: "B" },
                        sound: "default",
                    },
                });

                expect(result.success).toBe(false);
                expect(result.statusCode).toBe(400);
                expect(result.reason).toBe("BadDeviceToken");
            } finally {
                cleanup();
            }
        });

        it("handles 410 Gone with timestamp", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const unregTimestamp = Date.now();
            const { mockFetch } = createMockFetch(410, {
                reason: "Unregistered",
                timestamp: unregTimestamp,
            });

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "KEY",
                        teamId: "TEAM",
                        bundleId: "com.test",
                        production: false,
                    },
                    mockFetch,
                );

                const result = await client.send("gone-token", {
                    aps: {
                        alert: { title: "T", body: "B" },
                        sound: "default",
                    },
                });

                expect(result.success).toBe(false);
                expect(result.statusCode).toBe(410);
                expect(result.reason).toBe("Unregistered");
                expect(result.timestampMs).toBe(unregTimestamp);
            } finally {
                cleanup();
            }
        });

        it("handles network errors gracefully", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const throwingFetch = createThrowingFetch("Network timeout");

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "KEY",
                        teamId: "TEAM",
                        bundleId: "com.test",
                        production: false,
                    },
                    throwingFetch,
                );

                const result = await client.send("some-token", {
                    aps: {
                        alert: { title: "T", body: "B" },
                        sound: "default",
                    },
                });

                expect(result.success).toBe(false);
                expect(result.statusCode).toBe(0);
                expect(result.reason).toBe("network_error");
            } finally {
                cleanup();
            }
        });

        it("caches JWT across multiple sends", async () => {
            const { keyPath, cleanup } = generateTestP8Key();
            const { mockFetch, calls } = createMockFetch(200);

            try {
                const client = new APNsClient(
                    {
                        keyPath,
                        keyId: "KEY",
                        teamId: "TEAM",
                        bundleId: "com.test",
                        production: false,
                    },
                    mockFetch,
                );

                // Send twice
                await client.send("token-1", {
                    aps: { alert: { title: "T", body: "B" }, sound: "default" },
                });
                await client.send("token-2", {
                    aps: { alert: { title: "T", body: "B" }, sound: "default" },
                });

                expect(calls).toHaveLength(2);
                // Both should use the same JWT (cached)
                const jwt1 = calls[0]!.headers["authorization"];
                const jwt2 = calls[1]!.headers["authorization"];
                expect(jwt1).toBe(jwt2);
            } finally {
                cleanup();
            }
        });
    });
});
