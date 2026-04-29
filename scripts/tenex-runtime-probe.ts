#!/usr/bin/env bun
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip19,
    SimplePool,
    type Event,
    type EventTemplate,
} from "nostr-tools";
import { setupMcpProbeFixture } from "./tenex-runtime-probe-mcp";
import {
    availableScenarios,
    mockScenario,
    pmInstructions,
    runScenario,
    scenarioProjectDtag,
    type MockRequestRecord,
    type ScenarioName,
} from "./tenex-runtime-probe-scenarios";
import { evaluate } from "./tenex-runtime-probe-verdicts";

type Proc = {
    label: string;
    child: ChildProcessByStdio<null, Readable, Readable>;
    output: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcherRelayDir = "/home/pablo/Work/tenex-launcher/relay";
const scenarioName = (process.argv[2] ?? "delegation-basic") as ScenarioName;
const keep = process.argv.includes("--keep");

if (!availableScenarios.includes(scenarioName)) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available scenarios: ${availableScenarios.join(", ")}`);
    process.exit(2);
}

const procs: Proc[] = [];

process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
});
process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
});
process.on("exit", cleanup);

const runDir = mkdtempSync(path.join(tmpdir(), "tenex-runtime-probe-"));
const baseDir = path.join(runDir, ".tenex");
const relayDir = path.join(baseDir, "relay");
const projectDtag = scenarioProjectDtag(scenarioName);
const projectDir = path.join(baseDir, "projects", projectDtag);
const agentsDir = path.join(baseDir, "agents");
const workspaceDir = path.join(runDir, "workspace");
const artifactPath = path.join(runDir, "events.json");
const requestRecordPath = path.join(runDir, "mock-requests.jsonl");

mkdirSync(relayDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
for (let index = 1; index <= 10; index += 1) {
    writeFileSync(path.join(workspaceDir, `file-${index}.txt`), `content-file-${index}\n`);
}
const mcpProbe =
    scenarioName === "mcp-tool-basic"
        ? setupMcpProbeFixture({
              runDir,
              workspaceDir,
              bunPath: process.execPath,
          })
        : undefined;

const relayPort = await freePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const httpUrl = `http://127.0.0.1:${relayPort}/health`;

const owner = keypair();
const user = keypair();
const backend = keypair();
const pm = keypair();
const worker = keypair();

const projectEvent = sign(
    {
        kind: 31933,
        created_at: now(),
        content: "",
        tags: [
            ["d", projectDtag],
            ["title", "TENEX runtime probe"],
            ["p", pm.pubkey],
            ["p", worker.pubkey],
        ],
    },
    owner.secret
);
const projectRef = `31933:${owner.pubkey}:${projectDtag}`;

writeJson(path.join(projectDir, "event.json"), projectEvent);
writeJson(path.join(baseDir, "config.json"), {
    whitelistedPubkeys: [user.pubkey, owner.pubkey, backend.pubkey],
    tenexPrivateKey: bytesToHex(backend.secret),
    relays: [relayUrl],
    telemetry: { enabled: false },
});
writeJson(path.join(baseDir, "llms.json"), {
    configurations: { mock: { provider: "mock", model: scenarioName } },
    default: "mock",
});
writeJson(path.join(baseDir, "providers.json"), {
    providers: { mock: { apiKeys: [{ key: "none" }] } },
});
writeJson(path.join(relayDir, "relay.json"), {
    port: relayPort,
    bind_address: "127.0.0.1",
    data_dir: path.join(relayDir, "data"),
    require_auth: false,
    sync: { relays: [], kinds: [] },
    admin_pubkeys: [],
});
writeJson(path.join(agentsDir, `${pm.pubkey}.json`), {
    name: "Probe PM",
    slug: "pm",
    nsec: nip19.nsecEncode(pm.secret),
    category: "orchestrator",
    description: "Delegates probe tasks to workers",
    instructions: pmInstructions(scenarioName),
    working_directory: workspaceDir,
    default:
        scenarioName === "mcp-tool-basic"
            ? { model: "mock", mcp: ["probe"] }
            : scenarioName === "fs-read-adjustment"
            ? { model: "mock", skills: ["read-access"] }
            : { model: "mock" },
});
writeJson(path.join(agentsDir, `${worker.pubkey}.json`), {
    name: "Probe Worker",
    slug: "worker",
    nsec: nip19.nsecEncode(worker.secret),
    category: "worker",
    description: "Completes delegated probe tasks",
    instructions: "Complete delegated probe tasks with a concise result.",
    default: { model: "mock" },
});

const mockScenarioPath = path.join(runDir, "mock-llm.json");
writeJson(mockScenarioPath, mockScenario(scenarioName));

const relayCommand = resolveRelayCommand(path.join(relayDir, "relay.json"));
const tenexBin = process.env.TENEX_BIN ?? path.join(repoRoot, "target", "debug", "tenex");
const agentBin = path.join(path.dirname(tenexBin), "tenex-agent");

if (!existsSync(tenexBin) || !existsSync(agentBin)) {
    console.error("Missing Rust binaries. Build them first:");
    console.error("  cargo build -p tenex -p tenex-agent");
    process.exit(2);
}

console.log(`scenario: ${scenarioName}`);
console.log(`baseDir : ${baseDir}`);
console.log(`relay   : ${relayUrl}`);

spawnLogged("relay", relayCommand.cmd, relayCommand.args, {
    cwd: relayCommand.cwd,
    env: probeEnv(),
});
await waitForHealth(httpUrl, 5_000);

const startTime = now() - 2;
const events: Event[] = [];
const pool = new SimplePool();
await pool.ensureRelay(relayUrl);
const sub = pool.subscribeMany(
    [relayUrl],
    { kinds: [1, 24010, 24133, 24135, 31933], since: startTime },
    { onevent: (event) => events.push(event) }
);

const runtimeProc = spawnLogged(
    "runtime",
    tenexBin,
    ["runtime", projectDtag, "--base-dir", baseDir],
    {
        cwd: scenarioName === "mcp-tool-basic" ? workspaceDir : repoRoot,
        env: {
            ...probeEnv(),
            TENEX_MOCK_LLM_SCENARIO: mockScenarioPath,
            TENEX_MOCK_LLM_RECORD_PATH: requestRecordPath,
        },
    }
);

await waitForOutput(runtimeProc, "subscriptions active", 15_000);
await Promise.all(pool.publish([relayUrl], projectEvent));
await runScenario(scenarioName, {
    pool,
    events,
    relayUrl,
    projectRef,
    pmPubkey: pm.pubkey,
    userSecret: user.secret,
    requestRecordPath,
    sign,
    now,
    delay,
    waitForObservedEvent,
    waitForRequestRecord,
});
sub.close();

const storedEvents = await pool.querySync(
    [relayUrl],
    { kinds: [1, 24010, 24133, 31933], since: startTime },
    { maxWait: 2_000 }
);
const mergedEvents = mergeEvents(events, storedEvents);
pool.close([relayUrl]);

writeJson(artifactPath, mergedEvents);

const requestRecords = readRequestRecords(requestRecordPath);
const mcpProbeRecords = mcpProbe ? readJsonLines(mcpProbe.logPath) : [];
const verdicts = evaluate(scenarioName, mergedEvents, requestRecords, {
    pmPubkey: pm.pubkey,
    workerPubkey: worker.pubkey,
    mcpProbeRecords,
    workspaceDir,
});
for (const verdict of verdicts) {
    console.log(`${verdict.ok ? "ok " : "BAD"} ${verdict.name}`);
    if (!verdict.ok) {
        console.log(`    ${verdict.detail}`);
    }
}
console.log(`events : ${artifactPath}`);
console.log(`requests : ${requestRecordPath}`);

if (!keep) {
    cleanup();
}

process.exit(verdicts.every((v) => v.ok) ? 0 : 1);

function resolveRelayCommand(configPath: string): { cmd: string; args: string[]; cwd: string } {
    const candidates = [
        process.env.TENEX_RELAY_BIN,
        path.join(launcherRelayDir, "dist", "tenex-relay-linux-amd64"),
        path.join(launcherRelayDir, "dist", "tenex-relay-x86_64"),
        path.join(launcherRelayDir, "dist", "tenex-relay-arm64"),
    ].filter(Boolean) as string[];

    const binary = candidates.find((candidate) => existsSync(candidate));
    if (binary) {
        return { cmd: binary, args: ["-config", configPath], cwd: repoRoot };
    }
    if (existsSync(launcherRelayDir)) {
        return { cmd: "go", args: ["run", ".", "-config", configPath], cwd: launcherRelayDir };
    }
    throw new Error("Cannot locate TENEX launcher relay. Set TENEX_RELAY_BIN.");
}

function spawnLogged(
    label: string,
    cmd: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
): Proc {
    const child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const proc: Proc = { label, child, output: "" };
    child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        proc.output += text;
        process.stdout.write(`[${label}] ${text}`);
    });
    child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        proc.output += text;
        process.stderr.write(`[${label}] ${text}`);
    });
    child.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
            console.error(`[${label}] exited with code ${code}`);
        } else if (signal) {
            console.error(`[${label}] exited with signal ${signal}`);
        }
    });
    procs.push(proc);
    return proc;
}

function probeEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HOME: runDir,
        TENEX_BASE_DIR: baseDir,
        RUST_LOG: process.env.RUST_LOG ?? "info,nostr_sdk=warn,nostr_relay_pool=warn",
    };
}

function cleanup(): void {
    for (const proc of procs.splice(0).reverse()) {
        if (!proc.child.killed) {
            proc.child.kill("SIGTERM");
        }
    }
}

function keypair(): { secret: Uint8Array; pubkey: string } {
    const secret = generateSecretKey();
    return { secret, pubkey: getPublicKey(secret) };
}

function sign(template: EventTemplate, secret: Uint8Array): Event {
    return finalizeEvent(template, secret);
}

function mergeEvents(...groups: Event[][]): Event[] {
    const byId = new Map<string, Event>();
    for (const group of groups) {
        for (const event of group) {
            byId.set(event.id, event);
        }
    }
    return Array.from(byId.values()).sort((a, b) => a.created_at - b.created_at);
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readRequestRecords(file: string): MockRequestRecord[] {
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as MockRequestRecord];
            } catch {
                return [];
            }
        });
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
            try {
                const parsed = JSON.parse(line) as unknown;
                return parsed && typeof parsed === "object"
                    ? [parsed as Record<string, unknown>]
                    : [];
            } catch {
                return [];
            }
        });
}

function now(): number {
    return Math.floor(Date.now() / 1000);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (typeof address === "object" && address?.port) {
                const port = address.port;
                server.close(() => resolve(port));
            } else {
                reject(new Error("failed to allocate port"));
            }
        });
        server.on("error", reject);
    });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // keep polling
        }
        await delay(100);
    }
    throw new Error(`relay did not become healthy: ${url}`);
}

async function waitForOutput(proc: Proc, needle: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (proc.output.includes(needle)) {
            return;
        }
        await delay(100);
    }
    throw new Error(`${proc.label} did not print '${needle}' within ${timeoutMs}ms`);
}

async function waitForObservedEvent(
    events: Event[],
    predicate: (event: Event) => boolean,
    timeoutMs: number,
    label: string
): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) {
            return event;
        }
        await delay(100);
    }
    throw new Error(`did not observe ${label} within ${timeoutMs}ms`);
}

async function waitForRequestRecord(
    file: string,
    predicate: (records: MockRequestRecord[]) => boolean,
    timeoutMs: number,
    label: string
): Promise<MockRequestRecord[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const records = readRequestRecords(file);
        if (predicate(records)) {
            return records;
        }
        await delay(50);
    }
    throw new Error(`did not observe ${label} within ${timeoutMs}ms`);
}
