import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import * as nodefs from "node:fs";
import { AgentConfigWatcher } from "../AgentConfigWatcher";

// Valid 64-hex pubkey used across tests
const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const FILE_A = `${PUBKEY_A}.json`;
const FILE_B = `${PUBKEY_B}.json`;

/**
 * Controllable FSWatcher emitter for testing.
 */
class MockFSWatcher extends EventEmitter {
    close = mock(() => {});
}

let mockWatcher: MockFSWatcher;
let watchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
    mockWatcher = new MockFSWatcher();
    watchSpy = spyOn(nodefs, "watch").mockImplementation(
        (_path: unknown, _callback?: unknown) => {
            if (typeof _callback === "function") {
                mockWatcher.on("change", (eventType: string, filename: string | null) => {
                    (_callback as (eventType: string, filename: string | null) => void)(
                        eventType,
                        filename
                    );
                });
            }
            return mockWatcher as unknown as nodefs.FSWatcher;
        }
    );
});

afterEach(() => {
    watchSpy.mockRestore();
});

function fireEvent(
    eventType: string,
    filename: string | null,
    watcher = mockWatcher
): void {
    watcher.emit("change", eventType, filename);
}

describe("AgentConfigWatcher", () => {
    describe("start() and stop()", () => {
        it("calls fs.watch on start", () => {
            const watcher = new AgentConfigWatcher("/agents", () => true, mock(async () => {}));
            watcher.start();
            expect(watchSpy).toHaveBeenCalledWith("/agents", expect.any(Function));
            watcher.stop();
        });

        it("stop() closes the FSWatcher", () => {
            const watcher = new AgentConfigWatcher("/agents", () => true, mock(async () => {}));
            watcher.start();
            watcher.stop();
            expect(mockWatcher.close).toHaveBeenCalledTimes(1);
        });

        it("does not throw if stop is called before start", () => {
            const watcher = new AgentConfigWatcher("/agents", () => true, mock(async () => {}));
            expect(() => watcher.stop()).not.toThrow();
        });
    });

    describe("file filtering", () => {
        it("ignores non-pubkey files (.DS_Store, backup.bak, readme.txt)", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            fireEvent("change", ".DS_Store");
            fireEvent("change", "backup.bak");
            fireEvent("change", "readme.txt");
            fireEvent("change", "tooshort.json");
            fireEvent("change", null);

            // Wait past debounce
            await new Promise((r) => setTimeout(r, 200));
            expect(onChange).not.toHaveBeenCalled();
            watcher.stop();
        });

        it("ignores files for agents not in this project", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => false, onChange);
            watcher.start();

            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(onChange).not.toHaveBeenCalled();
            watcher.stop();
        });

        it("calls onChange for relevant agent files", async () => {
            const onChange = mock(async () => {});
            const isRelevant = mock((pubkey: string) => pubkey === PUBKEY_A);
            const watcher = new AgentConfigWatcher("/agents", isRelevant, onChange);
            watcher.start();

            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith(PUBKEY_A);
            watcher.stop();
        });

        it("handles rename events the same as change events", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            fireEvent("rename", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith(PUBKEY_A);
            watcher.stop();
        });
    });

    describe("debounce", () => {
        it("debounces rapid changes — calls onChange exactly once", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            // Fire 5 events within 50ms
            for (let i = 0; i < 5; i++) {
                fireEvent("change", FILE_A);
                await new Promise((r) => setTimeout(r, 10));
            }

            // Wait past debounce window
            await new Promise((r) => setTimeout(r, 250));
            expect(onChange).toHaveBeenCalledTimes(1);
            watcher.stop();
        });

        it("independent debounce per pubkey — both get callbacks", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            fireEvent("change", FILE_A);
            fireEvent("change", FILE_B);

            await new Promise((r) => setTimeout(r, 250));
            expect(onChange).toHaveBeenCalledTimes(2);
            const calls = onChange.mock.calls.map((c) => c[0]);
            expect(calls).toContain(PUBKEY_A);
            expect(calls).toContain(PUBKEY_B);
            watcher.stop();
        });
    });

    describe("stop() prevents further callbacks", () => {
        it("stop() prevents callbacks after being called", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();
            watcher.stop();

            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(onChange).not.toHaveBeenCalled();
        });

        it("stop() clears pending debounce timers before they fire", async () => {
            const onChange = mock(async () => {});
            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            // Queue a debounced event...
            fireEvent("change", FILE_A);
            // ...then stop before the 150ms debounce fires
            watcher.stop();

            await new Promise((r) => setTimeout(r, 250));
            expect(onChange).not.toHaveBeenCalled();
        });
    });

    describe("in-flight guard", () => {
        it("serializes overlapping reloads — second runs after first completes", async () => {
            const order: string[] = [];
            let resolveFirst!: () => void;

            const onChange = mock(async (pubkey: string) => {
                if (order.length === 0) {
                    // First call: slow — block until resolved externally
                    await new Promise<void>((r) => {
                        resolveFirst = r;
                    });
                    order.push("first");
                } else {
                    order.push("second");
                }
            });

            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            // First event
            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200)); // wait for debounce + first reload start

            // Second event while first is in-flight
            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200)); // wait for debounce

            // Resolve the first slow reload
            resolveFirst();

            // Give time for second reload to run
            await new Promise((r) => setTimeout(r, 100));

            // Both ran, in order
            expect(order).toEqual(["first", "second"]);
            watcher.stop();
        });
    });

    describe("error handling", () => {
        it("error in onChange doesn't crash the watcher — subsequent events still work", async () => {
            let callCount = 0;
            const onChange = mock(async () => {
                callCount++;
                if (callCount === 1) {
                    throw new Error("reload failed");
                }
            });

            const watcher = new AgentConfigWatcher("/agents", () => true, onChange);
            watcher.start();

            // First event — will throw
            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(callCount).toBe(1);

            // Second event — watcher should still function
            fireEvent("change", FILE_A);
            await new Promise((r) => setTimeout(r, 200));
            expect(callCount).toBe(2);

            watcher.stop();
        });
    });
});
