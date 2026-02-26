import { describe, it, expect, beforeEach } from "bun:test";
import { KeyManager } from "../key-manager";

describe("KeyManager", () => {
    let km: KeyManager;

    beforeEach(() => {
        km = new KeyManager({
            failureWindowMs: 1000,
            failureThreshold: 3,
            disableDurationMs: 2000,
        });
    });

    describe("registerKeys", () => {
        it("registers a single key as string", () => {
            km.registerKeys("openai", "sk-single");
            expect(km.selectKey("openai")).toBe("sk-single");
        });

        it("registers multiple keys as array", () => {
            km.registerKeys("openai", ["sk-1", "sk-2", "sk-3"]);
            const key = km.selectKey("openai");
            expect(["sk-1", "sk-2", "sk-3"]).toContain(key);
        });

        it("ignores empty arrays", () => {
            km.registerKeys("openai", []);
            expect(km.selectKey("openai")).toBeUndefined();
        });

        it("returns undefined for unregistered providers", () => {
            expect(km.selectKey("unknown")).toBeUndefined();
        });
    });

    describe("selectKey", () => {
        it("returns the only key when single key is registered", () => {
            km.registerKeys("anthropic", "sk-only");
            for (let i = 0; i < 10; i++) {
                expect(km.selectKey("anthropic")).toBe("sk-only");
            }
        });

        it("returns keys from the pool (random distribution)", () => {
            const keys = ["sk-a", "sk-b", "sk-c"];
            km.registerKeys("openai", keys);

            const selected = new Set<string>();
            // With 100 selections from 3 keys, we should see all of them
            for (let i = 0; i < 100; i++) {
                const key = km.selectKey("openai");
                if (key) selected.add(key);
            }

            expect(selected.size).toBe(3);
        });

        it("skips disabled keys", () => {
            km.registerKeys("openai", ["sk-good", "sk-bad"]);

            // Fail sk-bad enough times to disable it
            km.reportFailure("openai", "sk-bad");
            km.reportFailure("openai", "sk-bad");
            km.reportFailure("openai", "sk-bad");

            // Now only sk-good should be returned
            for (let i = 0; i < 20; i++) {
                expect(km.selectKey("openai")).toBe("sk-good");
            }
        });

        it("falls back to all keys when everything is disabled", () => {
            km.registerKeys("openai", ["sk-1", "sk-2"]);

            // Disable both keys
            for (let i = 0; i < 3; i++) {
                km.reportFailure("openai", "sk-1");
                km.reportFailure("openai", "sk-2");
            }

            // Should still return a key (fallback to all)
            const key = km.selectKey("openai");
            expect(["sk-1", "sk-2"]).toContain(key);
        });
    });

    describe("reportFailure", () => {
        it("does not disable key below threshold", () => {
            km.registerKeys("openai", ["sk-a", "sk-b"]);

            km.reportFailure("openai", "sk-a");
            km.reportFailure("openai", "sk-a");
            // Only 2 failures, threshold is 3

            const selected = new Set<string>();
            for (let i = 0; i < 50; i++) {
                const key = km.selectKey("openai");
                if (key) selected.add(key);
            }
            // sk-a should still be available
            expect(selected.has("sk-a")).toBe(true);
        });

        it("disables key at threshold", () => {
            km.registerKeys("openai", ["sk-a", "sk-b"]);

            km.reportFailure("openai", "sk-a");
            km.reportFailure("openai", "sk-a");
            km.reportFailure("openai", "sk-a");

            // sk-a should be disabled, only sk-b returned
            for (let i = 0; i < 20; i++) {
                expect(km.selectKey("openai")).toBe("sk-b");
            }
        });

        it("ignores failures for unregistered providers", () => {
            // Should not throw
            km.reportFailure("unknown", "sk-test");
        });
    });

    describe("key re-enabling", () => {
        it("re-enables key after disable duration", () => {
            let now = 1000;
            const clock = { now: () => now };

            km = new KeyManager({
                failureWindowMs: 500,
                failureThreshold: 2,
                disableDurationMs: 100,
                clock,
            });

            km.registerKeys("openai", ["sk-a", "sk-b"]);

            // Disable sk-a
            km.reportFailure("openai", "sk-a");
            km.reportFailure("openai", "sk-a");

            // Immediately, sk-a should be disabled
            for (let i = 0; i < 10; i++) {
                expect(km.selectKey("openai")).toBe("sk-b");
            }

            // Advance clock past the disable duration
            now += 150;

            // sk-a should be re-enabled now
            const selected = new Set<string>();
            for (let i = 0; i < 50; i++) {
                const key = km.selectKey("openai");
                if (key) selected.add(key);
            }
            expect(selected.has("sk-a")).toBe(true);
        });
    });

    describe("failure window expiry", () => {
        it("prunes old failures outside the window", () => {
            let now = 1000;
            const clock = { now: () => now };

            km = new KeyManager({
                failureWindowMs: 100,
                failureThreshold: 3,
                disableDurationMs: 2000,
                clock,
            });

            km.registerKeys("openai", ["sk-a", "sk-b"]);

            // Two failures now
            km.reportFailure("openai", "sk-a");
            km.reportFailure("openai", "sk-a");

            // Advance clock past the failure window
            now += 150;

            // Third failure should NOT trigger disable (old failures pruned)
            km.reportFailure("openai", "sk-a");

            // sk-a should still be available
            const selected = new Set<string>();
            for (let i = 0; i < 50; i++) {
                const key = km.selectKey("openai");
                if (key) selected.add(key);
            }
            expect(selected.has("sk-a")).toBe(true);
        });
    });

    describe("hasMultipleKeys", () => {
        it("returns false for single key", () => {
            km.registerKeys("openai", "sk-single");
            expect(km.hasMultipleKeys("openai")).toBe(false);
        });

        it("returns true for multiple keys", () => {
            km.registerKeys("openai", ["sk-1", "sk-2"]);
            expect(km.hasMultipleKeys("openai")).toBe(true);
        });

        it("returns false for unregistered providers", () => {
            expect(km.hasMultipleKeys("unknown")).toBe(false);
        });
    });

    describe("getHealthyKeyCount", () => {
        it("returns total count when all healthy", () => {
            km.registerKeys("openai", ["sk-1", "sk-2", "sk-3"]);
            expect(km.getHealthyKeyCount("openai")).toBe(3);
        });

        it("returns reduced count when keys disabled", () => {
            km.registerKeys("openai", ["sk-1", "sk-2", "sk-3"]);

            // Disable sk-1
            km.reportFailure("openai", "sk-1");
            km.reportFailure("openai", "sk-1");
            km.reportFailure("openai", "sk-1");

            expect(km.getHealthyKeyCount("openai")).toBe(2);
        });

        it("returns 0 for unregistered providers", () => {
            expect(km.getHealthyKeyCount("unknown")).toBe(0);
        });
    });

    describe("reset", () => {
        it("clears all state", () => {
            km.registerKeys("openai", ["sk-1", "sk-2"]);
            km.reportFailure("openai", "sk-1");

            km.reset();

            expect(km.selectKey("openai")).toBeUndefined();
            expect(km.getRegisteredProviders()).toEqual([]);
        });
    });

    describe("backwards compatibility", () => {
        it("works with a single string key (no array)", () => {
            km.registerKeys("anthropic", "sk-ant-key123");
            expect(km.selectKey("anthropic")).toBe("sk-ant-key123");
            expect(km.hasMultipleKeys("anthropic")).toBe(false);
            expect(km.getHealthyKeyCount("anthropic")).toBe(1);
        });
    });
});
