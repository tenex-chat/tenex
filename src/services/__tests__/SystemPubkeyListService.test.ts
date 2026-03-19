import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentStorage } from "@/agents/AgentStorage";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

let mockTenexBaseDir = "";
let mockWhitelistedPubkeys: string[] = [];
let mockBackendPubkey = "backend-pubkey";
let mockBackendSignerShouldFail = false;
let mockKnownAgentPubkeys = new Set<string>();

import { SystemPubkeyListService } from "../trust-pubkeys/SystemPubkeyListService";

describe("SystemPubkeyListService", () => {
    let getConfigPathSpy: ReturnType<typeof spyOn>;
    let getConfigSpy: ReturnType<typeof spyOn>;
    let getGlobalPathSpy: ReturnType<typeof spyOn>;
    let getProjectsBaseSpy: ReturnType<typeof spyOn>;
    let getContextManagementConfigSpy: ReturnType<typeof spyOn>;
    let getWhitelistedPubkeysSpy: ReturnType<typeof spyOn>;
    let getBackendSignerSpy: ReturnType<typeof spyOn>;
    let getAllKnownPubkeysSpy: ReturnType<typeof spyOn>;
    let loggerDebugSpy: ReturnType<typeof spyOn>;
    let loggerInfoSpy: ReturnType<typeof spyOn>;
    let loggerWarnSpy: ReturnType<typeof spyOn>;
    let loggerErrorSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        (SystemPubkeyListService as any).instance = undefined;

        mockTenexBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-pubkeys-"));
        mockWhitelistedPubkeys = [];
        mockBackendPubkey = "backend-pubkey";
        mockBackendSignerShouldFail = false;
        mockKnownAgentPubkeys = new Set<string>();

        getConfigPathSpy = spyOn(config, "getConfigPath").mockImplementation(
            (subdir?: string) =>
                subdir ? path.join(mockTenexBaseDir, subdir) : mockTenexBaseDir
        );
        getConfigSpy = spyOn(config, "getConfig").mockImplementation(
            () => ({ whitelistedPubkeys: mockWhitelistedPubkeys }) as never
        );
        getGlobalPathSpy = spyOn(config, "getGlobalPath").mockImplementation(
            () => mockTenexBaseDir
        );
        getProjectsBaseSpy = spyOn(config, "getProjectsBase").mockImplementation(
            () => path.join(mockTenexBaseDir, "projects")
        );
        getContextManagementConfigSpy = spyOn(
            config,
            "getContextManagementConfig"
        ).mockImplementation(() => undefined);
        getWhitelistedPubkeysSpy = spyOn(config, "getWhitelistedPubkeys").mockImplementation(
            () => mockWhitelistedPubkeys
        );
        getBackendSignerSpy = spyOn(config, "getBackendSigner").mockImplementation(async () => {
            if (mockBackendSignerShouldFail) {
                throw new Error("Backend signer unavailable");
            }
            return { pubkey: mockBackendPubkey } as never;
        });
        getAllKnownPubkeysSpy = spyOn(agentStorage, "getAllKnownPubkeys").mockImplementation(
            async () => new Set(mockKnownAgentPubkeys)
        );
        loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});
        loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {});
        loggerWarnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
        getConfigPathSpy?.mockRestore();
        getConfigSpy?.mockRestore();
        getGlobalPathSpy?.mockRestore();
        getProjectsBaseSpy?.mockRestore();
        getContextManagementConfigSpy?.mockRestore();
        getWhitelistedPubkeysSpy?.mockRestore();
        getBackendSignerSpy?.mockRestore();
        getAllKnownPubkeysSpy?.mockRestore();
        loggerDebugSpy?.mockRestore();
        loggerInfoSpy?.mockRestore();
        loggerWarnSpy?.mockRestore();
        loggerErrorSpy?.mockRestore();
        mock.restore();
        await fs.rm(mockTenexBaseDir, { recursive: true, force: true });
    });

    it("writes one pubkey per line from whitelist, backend, agents, and additional pubkeys", async () => {
        mockWhitelistedPubkeys = ["owner-b", "owner-a"];
        mockBackendPubkey = "backend-main";
        mockKnownAgentPubkeys = new Set(["agent-2", "agent-1", "owner-a"]);

        const service = SystemPubkeyListService.getInstance();
        await service.syncWhitelistFile({
            additionalPubkeys: ["runtime-agent", "agent-1", "  ", ""],
        });

        const whitelistPath = path.join(mockTenexBaseDir, "daemon", "whitelist.txt");
        const content = await fs.readFile(whitelistPath, "utf-8");

        expect(content).toBe(
            "agent-1\nagent-2\nbackend-main\nowner-a\nowner-b\nruntime-agent\n"
        );
    });

    it("continues when backend signer is unavailable", async () => {
        mockWhitelistedPubkeys = ["owner"];
        mockBackendSignerShouldFail = true;
        mockKnownAgentPubkeys = new Set(["agent-1"]);

        const service = SystemPubkeyListService.getInstance();
        await service.syncWhitelistFile({
            additionalPubkeys: ["runtime-agent"],
        });

        const whitelistPath = path.join(mockTenexBaseDir, "daemon", "whitelist.txt");
        const content = await fs.readFile(whitelistPath, "utf-8");

        expect(content).toBe("agent-1\nowner\nruntime-agent\n");
    });

    it("rebuilds file content when known pubkeys change", async () => {
        mockWhitelistedPubkeys = ["owner-1"];
        mockBackendPubkey = "backend-1";
        mockKnownAgentPubkeys = new Set(["agent-old"]);

        const service = SystemPubkeyListService.getInstance();
        await service.syncWhitelistFile();

        mockWhitelistedPubkeys = ["owner-2"];
        mockBackendPubkey = "backend-2";
        mockKnownAgentPubkeys = new Set(["agent-new"]);

        await service.syncWhitelistFile();

        const whitelistPath = path.join(mockTenexBaseDir, "daemon", "whitelist.txt");
        const content = await fs.readFile(whitelistPath, "utf-8");

        expect(content).toBe("agent-new\nbackend-2\nowner-2\n");
        expect(content).not.toContain("agent-old");
        expect(content).not.toContain("backend-1");
        expect(content).not.toContain("owner-1");
    });
});
