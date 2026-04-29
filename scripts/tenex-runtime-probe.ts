#!/usr/bin/env bun
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nip19, SimplePool, type Event } from "nostr-tools";
import {
    cassetteToMockScenario,
    parseProbeLlmOptions,
    type ProbeLlmOptions,
} from "./tenex-runtime-probe-cassette";
import { setupMcpProbeFixture } from "./tenex-runtime-probe-mcp";
import {
    availableScenarios,
    mockScenario,
    pmInstructions,
    runScenario,
    scenarioProjectDtag,
    type ScenarioName,
} from "./tenex-runtime-probe-scenarios";
import {
    bytesToHex,
    delay,
    freePort,
    keypair,
    mergeEvents,
    now,
    readJsonLines,
    readRequestRecords,
    sign,
    waitForHealth,
    waitForObservedEvent,
    waitForOutput,
    waitForRequestRecord,
    writeJson,
} from "./tenex-runtime-probe-utils";
import { evaluate } from "./tenex-runtime-probe-verdicts";

type Proc = {
    label: string;
    child: ChildProcessByStdio<null, Readable, Readable>;
    output: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcherRelayDir = "/home/pablo/Work/tenex-launcher/relay";
const cliArgs = process.argv.slice(2);
const scenarioName = (positionalArgs(cliArgs)[0] ?? "delegation-basic") as ScenarioName;
const keep = cliArgs.includes("--keep");
const llm = parseProbeLlmOptions(cliArgs);

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
const cassetteRecordPath = llm.recordCassettePath
    ? path.resolve(llm.recordCassettePath)
    : path.join(runDir, "llm-cassette.jsonl");
const llmModelName = llm.mode === "ollama" ? "probe-real" : "mock";

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
    configurations:
        llm.mode === "ollama"
            ? { [llmModelName]: { provider: "ollama", model: llm.ollamaModel } }
            : { mock: { provider: "mock", model: scenarioName } },
    default: llmModelName,
});
writeJson(path.join(baseDir, "providers.json"), {
    providers:
        llm.mode === "ollama"
            ? {
                  ollama: {
                      apiKeys: [{ key: llm.ollamaBaseUrl ?? "none" }],
                      baseUrl: llm.ollamaBaseUrl,
                  },
              }
            : { mock: { apiKeys: [{ key: "none" }] } },
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
            ? { model: llmModelName, mcp: ["probe"] }
            : scenarioName === "fs-read-adjustment"
            ? { model: llmModelName, skills: ["read-access"] }
            : { model: llmModelName },
});
writeJson(path.join(agentsDir, `${worker.pubkey}.json`), {
    name: "Probe Worker",
    slug: "worker",
    nsec: nip19.nsecEncode(worker.secret),
    category: "worker",
    description: "Completes delegated probe tasks",
    instructions:
        "Complete delegated probe tasks with a concise result. If asked to choose a random color, never call no_response; reply with exactly one color name.",
    default: { model: llmModelName },
});

const mockScenarioPath = path.join(runDir, "mock-llm.json");
if (llm.mode === "mock") {
    writeJson(mockScenarioPath, mockScenario(scenarioName));
} else if (llm.mode === "cassette") {
    if (!llm.cassettePath) {
        throw new Error("Cassette replay requires --cassette or TENEX_PROBE_CASSETTE");
    }
    writeJson(
        mockScenarioPath,
        cassetteToMockScenario(path.resolve(llm.cassettePath), llm.generationTimeFactor)
    );
}

const relayCommand = resolveRelayCommand(path.join(relayDir, "relay.json"));
const tenexBin = process.env.TENEX_BIN ?? path.join(repoRoot, "target", "debug", "tenex");
const agentBin = path.join(path.dirname(tenexBin), "tenex-agent");

if (!existsSync(tenexBin) || !existsSync(agentBin)) {
    console.error("Missing Rust binaries. Build them first:");
    console.error("  cargo build -p tenex -p tenex-agent");
    process.exit(2);
}

console.log(`scenario: ${scenarioName}`);
console.log(`llm    : ${describeLlm(llm)}`);
console.log(`baseDir : ${baseDir}`);
console.log(`relay   : ${relayUrl}`);
if (llm.mode === "ollama" || llm.recordCassettePath) {
    console.log(`cassette record: ${cassetteRecordPath}`);
}
if (llm.mode === "cassette" && llm.cassettePath) {
    console.log(`cassette replay: ${path.resolve(llm.cassettePath)}`);
}

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
        env: runtimeEnv(llm, mockScenarioPath, requestRecordPath, cassetteRecordPath),
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
    workerPubkey: worker.pubkey,
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
    modelName: llmModelName,
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
if (llm.mode === "mock" || llm.mode === "cassette") {
    console.log(`requests : ${requestRecordPath}`);
}
if (llm.mode === "ollama" || llm.recordCassettePath) {
    console.log(`cassette : ${cassetteRecordPath}`);
}

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

function runtimeEnv(
    options: ProbeLlmOptions,
    mockScenarioPath: string,
    mockRecordPath: string,
    cassettePath: string
): NodeJS.ProcessEnv {
    const env = probeEnv();
    if (options.mode === "mock" || options.mode === "cassette") {
        env.TENEX_MOCK_LLM_SCENARIO = mockScenarioPath;
        env.TENEX_MOCK_LLM_RECORD_PATH = mockRecordPath;
    }
    if (options.mode === "ollama" || options.recordCassettePath) {
        env.TENEX_LLM_CASSETTE_RECORD_PATH = cassettePath;
    }
    if (options.ollamaBaseUrl) {
        env.OLLAMA_API_BASE_URL = options.ollamaBaseUrl;
    }
    return env;
}

function describeLlm(options: ProbeLlmOptions): string {
    if (options.mode === "ollama") {
        return `ollama/${options.ollamaModel}`;
    }
    if (options.mode === "cassette") {
        return `cassette factor=${options.generationTimeFactor}`;
    }
    return "mock";
}

function positionalArgs(args: string[]): string[] {
    const valueFlags = new Set([
        "--llm",
        "--cassette",
        "--record-cassette",
        "--llm-generation-time-factor",
        "--ollama-model",
        "--ollama-base-url",
    ]);
    const result: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg.startsWith("--")) {
            if (
                valueFlags.has(arg) &&
                !arg.includes("=") &&
                args[index + 1] &&
                !args[index + 1].startsWith("--")
            ) {
                index += 1;
            }
            continue;
        }
        result.push(arg);
    }
    return result;
}

function cleanup(): void {
    for (const proc of procs.splice(0).reverse()) {
        if (!proc.child.killed) {
            proc.child.kill("SIGTERM");
        }
    }
}
