import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Lockfile } from "../lockfile";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("Lockfile", () => {
  let testLockfilePath: string;
  let lockfile: Lockfile;

  beforeEach(() => {
    // Use a temporary test lockfile
    testLockfilePath = path.join(os.tmpdir(), `test-lockfile-${Date.now()}.lock`);
    lockfile = new Lockfile(testLockfilePath);
  });

  afterEach(async () => {
    // Clean up test lockfile
    try {
      await fs.unlink(testLockfilePath);
    } catch {
      // Ignore errors if file doesn't exist
    }
  });

  it("should acquire lockfile successfully", async () => {
    await lockfile.acquire();

    // Verify lockfile exists
    const content = await fs.readFile(testLockfilePath, "utf-8");
    const lockInfo = JSON.parse(content);

    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.hostname).toBe(os.hostname());
    expect(lockInfo.startedAt).toBeTypeOf("number");
  });

  it("should release lockfile successfully", async () => {
    await lockfile.acquire();
    await lockfile.release();

    // Verify lockfile is removed
    await expect(fs.access(testLockfilePath)).rejects.toThrow();
  });

  it("should throw error when lockfile already exists with running process", async () => {
    // Acquire first lock
    await lockfile.acquire();

    // Try to acquire again with different instance
    const lockfile2 = new Lockfile(testLockfilePath);
    await expect(lockfile2.acquire()).rejects.toThrow(/already running/);
  });

  it("should acquire lockfile if previous process is not running", async () => {
    // Create a fake lockfile with non-existent PID
    const staleLockInfo = {
      pid: 999999, // Very unlikely to be a real process
      hostname: os.hostname(),
      startedAt: Date.now() - 10000,
    };
    await fs.writeFile(testLockfilePath, JSON.stringify(staleLockInfo), "utf-8");

    // Should be able to acquire the lock (stale lockfile removed)
    await lockfile.acquire();

    // Verify new lockfile has current PID
    const content = await fs.readFile(testLockfilePath, "utf-8");
    const lockInfo = JSON.parse(content);
    expect(lockInfo.pid).toBe(process.pid);
  });

  it("should treat EPERM as process running when checking lockfile", async () => {
    // Create a lockfile with a PID that will trigger EPERM
    const testPid = 1; // Root process, likely to cause EPERM on non-root systems
    const lockInfo = {
      pid: testPid,
      hostname: os.hostname(),
      startedAt: Date.now(),
    };
    await fs.writeFile(testLockfilePath, JSON.stringify(lockInfo), "utf-8");

    // Spy on process.kill to simulate EPERM error
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      // Should throw because EPERM means process exists but we can't signal it
      await expect(lockfile.acquire()).rejects.toThrow(/already running/);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("should get default lockfile path", () => {
    const defaultPath = Lockfile.getDefaultPath();
    expect(defaultPath).toContain(".tenex");
    expect(defaultPath).toContain("daemon");
    expect(defaultPath).toContain("tenex.lock");
  });
});
