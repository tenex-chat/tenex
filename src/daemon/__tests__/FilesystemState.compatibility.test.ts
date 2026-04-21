import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import filesystemStateFixture from "@/test-utils/fixtures/daemon/filesystem-state.compat.json";
import { Lockfile } from "@/utils/lockfile";
import { logger } from "@/utils/logger";
import { RestartState } from "../RestartState";
import { StatusFile } from "../StatusFile";

describe("daemon filesystem state compatibility fixture", () => {
    let tempDir: string;
    let daemonDir: string;

    beforeEach(async () => {
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-daemon-state-compat-"));
        daemonDir = path.join(tempDir, filesystemStateFixture.daemonDirName);
        await fs.mkdir(daemonDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
        mock.restore();
    });

    it("uses the canonical daemon state filenames", () => {
        expect(path.join(daemonDir, filesystemStateFixture.relativePaths.lockfile)).toBe(
            path.join(daemonDir, "tenex.lock")
        );
        expect(path.join(daemonDir, filesystemStateFixture.relativePaths.status)).toBe(
            path.join(daemonDir, "status.json")
        );
        expect(path.join(daemonDir, filesystemStateFixture.relativePaths.restartState)).toBe(
            path.join(daemonDir, "restart-state.json")
        );
    });

    it("writes and reads status.json with the shared JSON shape", async () => {
        const statusFile = new StatusFile(daemonDir);

        await statusFile.write(filesystemStateFixture.status);

        const rawStatus = JSON.parse(
            await fs.readFile(
                path.join(daemonDir, filesystemStateFixture.relativePaths.status),
                "utf-8"
            )
        );

        expect(rawStatus).toEqual(filesystemStateFixture.status);
        expect(await statusFile.read()).toEqual(filesystemStateFixture.status);

        await statusFile.remove();
        expect(await statusFile.read()).toBeNull();
    });

    it("loads, detects, and clears restart-state.json with the shared JSON shape", async () => {
        const restartState = new RestartState(daemonDir);
        const restartStatePath = path.join(
            daemonDir,
            filesystemStateFixture.relativePaths.restartState
        );

        await fs.writeFile(
            restartStatePath,
            JSON.stringify(filesystemStateFixture.restartState, null, 2),
            "utf-8"
        );

        expect(await restartState.exists()).toBe(true);
        expect(await restartState.load()).toEqual(filesystemStateFixture.restartState);

        await restartState.clear();
        expect(await restartState.exists()).toBe(false);
        expect(await restartState.load()).toBeNull();
    });

    it("writes tenex.lock using the shared key names and replaces stale locks", async () => {
        const lockfilePath = path.join(daemonDir, filesystemStateFixture.relativePaths.lockfile);
        const lockfile = new Lockfile(lockfilePath);

        await fs.writeFile(
            lockfilePath,
            JSON.stringify(filesystemStateFixture.staleLockfile, null, 2),
            "utf-8"
        );

        await lockfile.acquire();

        const rawLockfile = JSON.parse(await fs.readFile(lockfilePath, "utf-8"));
        expect(Object.keys(rawLockfile).sort()).toEqual(
            Object.keys(filesystemStateFixture.lockfile).sort()
        );
        expect(rawLockfile.pid).toBe(process.pid);
        expect(rawLockfile.hostname).toBe(os.hostname());
        expect(rawLockfile.startedAt).toBeTypeOf("number");

        await lockfile.release();
        await expect(fs.access(lockfilePath)).rejects.toThrow();
    });
});
