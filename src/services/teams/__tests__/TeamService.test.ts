import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as filesystem from "@/lib/fs/filesystem";
import { logger } from "@/utils/logger";
import { TeamService } from "../TeamService";
import type { ConfigService } from "@/services/ConfigService";

// =============================================================================
// Helpers
// =============================================================================

function makeStats(mtimeMs: number, size: number): Partial<import("node:fs").Stats> {
    return { mtimeMs, size } as Partial<import("node:fs").Stats>;
}

function makeConfig(globalPath = "/global", projectBase = "/projects"): ConfigService {
    return {
        getConfigPath: () => globalPath,
        getProjectMetadataPath: (id: string) => `${projectBase}/${id}`,
    } as unknown as ConfigService;
}

const VALID_TEAMS_JSON = {
    teams: {
        "alpha": {
            description: "Alpha team",
            teamLead: "agent-a",
            members: ["agent-b"],
        },
    },
};

// =============================================================================
// Tests
// =============================================================================

describe("TeamService", () => {
    let statSpy: ReturnType<typeof spyOn>;
    let readJsonSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        statSpy = spyOn(fsPromises, "stat");
        readJsonSpy = spyOn(filesystem, "readJsonFile");
        warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    // =========================================================================
    // Issue 1: TTL expiry triggers reload even when files are unchanged
    // =========================================================================

    describe("cache TTL expiry", () => {
        it("serves cached data when files are unchanged and TTL has not expired", async () => {
            const fileState = makeStats(1000, 512);
            statSpy.mockResolvedValue(fileState as import("node:fs").Stats);
            readJsonSpy.mockResolvedValue(VALID_TEAMS_JSON);

            const service = new TeamService(makeConfig());

            // First call populates cache
            const first = await service.getTeams();
            expect(first).toHaveLength(1);

            // Second call — files unchanged, TTL not expired → should NOT re-read
            readJsonSpy.mockClear();
            const second = await service.getTeams();
            expect(second).toHaveLength(1);
            expect(readJsonSpy).not.toHaveBeenCalled();
        });

        it("reloads when TTL expires even though files are unchanged", async () => {
            const fileState = makeStats(1000, 512);
            statSpy.mockResolvedValue(fileState as import("node:fs").Stats);
            readJsonSpy.mockResolvedValue(VALID_TEAMS_JSON);

            const service = new TeamService(makeConfig());

            // Spy on Date.now to control time
            const nowSpy = spyOn(Date, "now");

            // t=0: initial load
            nowSpy.mockReturnValue(0);
            await service.getTeams();

            // t=10s: still within TTL — should use cache
            nowSpy.mockReturnValue(10_000);
            readJsonSpy.mockClear();
            await service.getTeams();
            expect(readJsonSpy).not.toHaveBeenCalled();

            // t=31s: TTL expired — should reload
            nowSpy.mockReturnValue(31_000);
            readJsonSpy.mockClear();
            await service.getTeams();
            expect(readJsonSpy).toHaveBeenCalled();
        });

        it("reloads immediately when file mtime changes regardless of TTL", async () => {
            statSpy.mockResolvedValue(makeStats(1000, 512) as import("node:fs").Stats);
            readJsonSpy.mockResolvedValue(VALID_TEAMS_JSON);

            const service = new TeamService(makeConfig());
            const nowSpy = spyOn(Date, "now").mockReturnValue(0);

            // Initial load
            await service.getTeams();

            // File mtime changes before TTL expires
            statSpy.mockResolvedValue(makeStats(2000, 512) as import("node:fs").Stats);
            readJsonSpy.mockClear();
            nowSpy.mockReturnValue(5_000); // well within TTL

            await service.getTeams();
            expect(readJsonSpy).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Issue 3: Malformed JSON degrades safely instead of throwing
    // =========================================================================

    describe("malformed teams.json", () => {
        it("returns empty teams and logs a warning when JSON is malformed", async () => {
            statSpy.mockResolvedValue(makeStats(1000, 512) as import("node:fs").Stats);
            readJsonSpy.mockRejectedValue(new SyntaxError("Unexpected token } in JSON"));

            const service = new TeamService(makeConfig());
            const teams = await service.getTeams();

            expect(teams).toEqual([]);
            expect(warnSpy).toHaveBeenCalledWith(
                "Could not read teams file, returning empty teams",
                expect.objectContaining({ warning: "file read or parse failure" })
            );
        });

        it("returns empty teams and logs a warning when file read throws generically", async () => {
            statSpy.mockResolvedValue(makeStats(1000, 512) as import("node:fs").Stats);
            readJsonSpy.mockRejectedValue(new Error("EACCES: permission denied"));

            const service = new TeamService(makeConfig());
            const teams = await service.getTeams();

            expect(teams).toEqual([]);
            expect(warnSpy).toHaveBeenCalledWith(
                "Could not read teams file, returning empty teams",
                expect.objectContaining({ warning: "file read or parse failure" })
            );
        });

        it("returns empty teams when file disappears between stat and read (TOCTOU)", async () => {
            statSpy.mockResolvedValue(makeStats(1000, 512) as import("node:fs").Stats);
            // readJsonFile returns null for ENOENT
            readJsonSpy.mockResolvedValue(null);

            const service = new TeamService(makeConfig());
            const teams = await service.getTeams();

            expect(teams).toEqual([]);
        });
    });
});
