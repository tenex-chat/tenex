#!/usr/bin/env bun
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import {
    conversationDbPath,
    monitorConversation,
    readAllConversationTranscripts,
} from "./tenex-runtime-probe-conversations";
import { setupMcpProbeFixture } from "./tenex-runtime-probe-mcp";
import {
    acpProbeModelName,
    agentConfigUpdateModelName,
    availableScenarios,
    delegationWorkerPrompt,
    mockScenario,
    nestedAgentsMdGlobInstruction,
    nestedAgentsMdReadInstruction,
    nestedAgentsMdRootInstruction,
    pmInstructions,
    rootAgentsMdInstruction,
    runScenario,
    scenarioProjectDtag,
    type ScenarioName,
    worktreeAgentsMdInstruction,
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
const verbose = cliArgs.includes("--verbose");
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
const convDbPath = conversationDbPath(baseDir, projectDtag);
const agentsDir = path.join(baseDir, "agents");
const projectsBaseDir = path.join(runDir, "project-workspaces");
const workspaceDir = path.join(projectsBaseDir, projectDtag);
const artifactPath = path.join(runDir, "events.json");
const transcriptArtifactPath = path.join(runDir, "conversation-transcripts.json");
const processOutputArtifactPath = path.join(runDir, "process-output.json");
const requestRecordPath = path.join(runDir, "mock-requests.jsonl");
const cassetteRecordPath = llm.recordCassettePath
    ? path.resolve(llm.recordCassettePath)
    : path.join(runDir, "llm-cassette.jsonl");
const llmModelName =
    llm.mode === "ollama"
        ? "probe-real"
        : llm.mode === "anthropic"
        ? "probe-anthropic"
        : llm.mode === "openrouter"
        ? "probe-openrouter"
        : "mock";
const usesAcp =
    scenarioName === "acp-worker-basic" ||
    scenarioName === "acp-delegation-mcp" ||
    scenarioName === "agent-config-reload";

mkdirSync(relayDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
for (let index = 1; index <= 10; index += 1) {
    writeFileSync(path.join(workspaceDir, `file-${index}.txt`), `content-file-${index}\n`);
}
const rootAgentsMdWorktreeDir = path.join(workspaceDir, ".worktrees", "root-agents-probe");
if (scenarioName === "root-agents-md") {
    mkdirSync(rootAgentsMdWorktreeDir, { recursive: true });
    writeFileSync(
        path.join(workspaceDir, "AGENTS.md"),
        `Root AGENTS instruction: ${rootAgentsMdInstruction}\n`
    );
    writeFileSync(
        path.join(rootAgentsMdWorktreeDir, "AGENTS.md"),
        `Worktree instruction: ${worktreeAgentsMdInstruction}\n`
    );
}
if (scenarioName === "nested-agents-md") {
    mkdirSync(path.join(workspaceDir, "src", "nested"), { recursive: true });
    writeFileSync(
        path.join(workspaceDir, "AGENTS.md"),
        `Root AGENTS instruction: ${nestedAgentsMdRootInstruction}\n`
    );
    writeFileSync(
        path.join(workspaceDir, "src", "AGENTS.md"),
        `src AGENTS instruction: ${nestedAgentsMdReadInstruction}\n`
    );
    writeFileSync(
        path.join(workspaceDir, "src", "nested", "AGENTS.md"),
        `nested AGENTS instruction: ${nestedAgentsMdGlobInstruction}\n`
    );
    writeFileSync(path.join(workspaceDir, "src", "file.txt"), "src file content\n");
    writeFileSync(path.join(workspaceDir, "src", "nested", "file.txt"), "nested file content\n");
}
const mcpProbe =
    scenarioName === "mcp-tool-basic" || scenarioName === "mcp-resource-basic"
        ? setupMcpProbeFixture({
              runDir,
              workspaceDir,
              bunPath: process.execPath,
          })
        : undefined;
const acpProbe =
    usesAcp
        ? buildAcpProbeRuntime({ delegateViaMcp: scenarioName === "acp-delegation-mcp" })
        : undefined;

const relayPort = await freePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const httpUrl = `http://127.0.0.1:${relayPort}/health`;

const owner = keypair();
const user = keypair();
const backend = keypair();
const pm = keypair();
const worker = keypair();
// For cross-project delegation, the second project has its own worker keypair
// and an additional dtag. The runtime is per-project, so we spawn a second
// runtime process that watches projectB's dtag against the same relay/baseDir.
const isCrossProjectScenario = scenarioName === "delegation-crossproject";
const projectBDtag = "probe-crossproject-b";
const projectBWorker = isCrossProjectScenario ? keypair() : null;
const projectBDir = path.join(baseDir, "projects", projectBDtag);
const projectBWorkspaceDir = path.join(projectsBaseDir, projectBDtag);
if (isCrossProjectScenario) {
    mkdirSync(projectBDir, { recursive: true });
    mkdirSync(projectBWorkspaceDir, { recursive: true });
}

const initialProjectAgentPubkeys =
    scenarioName === "project-membership-reload"
        ? [pm.pubkey]
        : [pm.pubkey, worker.pubkey];
const projectEvent = buildProjectEvent(initialProjectAgentPubkeys);
const projectRef = `31933:${owner.pubkey}:${projectDtag}`;
const pmWorkingDirectory =
    scenarioName === "root-agents-md" ? rootAgentsMdWorktreeDir : workspaceDir;
const nip46Config =
    scenarioName === "sign-as-user-nip46"
        ? {
              enabled: true,
              signingTimeoutMs: 15_000,
              maxRetries: 0,
              owners: {
                  [owner.pubkey]: {
                      bunkerUri: `bunker://${owner.pubkey}?relay=${encodeURIComponent(relayUrl)}`,
                  },
              },
          }
        : undefined;

writeJson(path.join(projectDir, "event.json"), projectEvent);
writeJson(path.join(baseDir, "config.json"), {
    // For cross-project delegation, project B receives kind:1 events authored
    // by project A's agents. Project B's runtime would otherwise classify
    // those as external authors and refuse to dispatch (routeUnauthorizedAuthors
    // defaults to false). Whitelisting the source project's PM mirrors a real
    // deployment where the operator opts every cross-project author in.
    whitelistedPubkeys: isCrossProjectScenario
        ? [user.pubkey, owner.pubkey, backend.pubkey, pm.pubkey]
        : [user.pubkey, owner.pubkey, backend.pubkey],
    tenexPrivateKey: bytesToHex(backend.secret),
    projectsBase: projectsBaseDir,
    relays: [relayUrl],
    telemetry: { enabled: false },
    ...(nip46Config ? { nip46: nip46Config } : {}),
});
const llmConfigurations: Record<string, unknown> =
   llm.mode === "ollama"
       ? {
             [llmModelName]: { provider: "ollama", model: llm.ollamaModel },
             [agentConfigUpdateModelName]: { provider: "ollama", model: llm.ollamaModel },
         }
       : llm.mode === "anthropic"
       ? {
             [llmModelName]: { provider: "anthropic", model: llm.anthropicModel },
             [agentConfigUpdateModelName]: { provider: "anthropic", model: llm.anthropicModel },
         }
    : llm.mode === "openrouter"
    ? {
          [llmModelName]: { provider: "openrouter", model: llm.openrouterModel },
          [agentConfigUpdateModelName]: { provider: "openrouter", model: llm.openrouterModel },
      }
       : {
             mock: { provider: "mock", model: scenarioName },
             [agentConfigUpdateModelName]: { provider: "mock", model: scenarioName },
         };
if (acpProbe) {
    llmConfigurations[acpProbeModelName] = acpProbe;
}
writeJson(path.join(baseDir, "llms.json"), {
    configurations: llmConfigurations,
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
            : llm.mode === "anthropic"
           ? {
                 anthropic: {
                     apiKey: llm.anthropicApiKey ?? "",
                 },
             }
            : llm.mode === "openrouter"
            ? {
                  openrouter: {
                      apiKeys: [{ key: llm.openrouterApiKey ?? "none" }],
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
    ...(scenarioName === "project-membership-reload"
        ? {}
        : { working_directory: pmWorkingDirectory }),
    default:
        scenarioName === "mcp-tool-basic"
            ? { model: llmModelName, mcp: ["probe"] }
            : scenarioName === "mcp-resource-basic"
            ? { model: llmModelName, mcp: ["probe"], skills: ["mcp"] }
            : scenarioName === "acp-delegation-mcp"
            ? { model: acpProbeModelName }
            : scenarioName === "fs-read-adjustment"
              || scenarioName === "nested-agents-md"
            ? { model: llmModelName, skills: ["read-access"] }
            : scenarioName === "sign-as-user-nip46"
            ? { model: llmModelName, skills: ["signer"] }
            : { model: llmModelName },
});
writeJson(path.join(agentsDir, `${worker.pubkey}.json`), {
    name: "Probe Worker",
    slug: "worker",
    nsec: nip19.nsecEncode(worker.secret),
    category: "worker",
    description: "Completes delegated probe tasks",
    instructions:
        "Complete delegated probe tasks with a concise result. If asked to choose a random color, never call no_response; reply with exactly one lowercase color word and no punctuation.",
    default: { model: scenarioName === "acp-worker-basic" ? acpProbeModelName : llmModelName },
    ...(scenarioName === "acp-worker-basic" && acpProbe ? { runtime: acpProbe } : {}),
});

let projectBEvent: Event | null = null;
if (isCrossProjectScenario && projectBWorker) {
    projectBEvent = sign(
        {
            kind: 31933,
            created_at: now(),
            content: "",
            tags: [
                ["d", projectBDtag],
                ["title", "TENEX cross-project probe (B)"],
                ["client", "tenex-runtime-probe"],
                ["p", projectBWorker.pubkey],
            ],
        },
        owner.secret
    );
    writeJson(path.join(projectBDir, "event.json"), projectBEvent);
    writeJson(path.join(agentsDir, `${projectBWorker.pubkey}.json`), {
        name: "Probe Worker B",
        slug: "worker",
        nsec: nip19.nsecEncode(projectBWorker.secret),
        category: "worker",
        description: "Cross-project worker for project B",
        working_directory: projectBWorkspaceDir,
        instructions:
            "Complete cross-project delegated tasks. If asked to choose a random color, never call no_response; reply with exactly one lowercase color word and no punctuation.",
        default: { model: llmModelName },
    });
}

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
const agentAcpBin = path.join(path.dirname(tenexBin), "tenex-agent-acp");

if (!existsSync(tenexBin) || !existsSync(agentBin) || (usesAcp && !existsSync(agentAcpBin))) {
    console.error("Missing Rust binaries. Build them first:");
    console.error("  cargo build -p tenex -p tenex-agent");
    process.exit(2);
}

console.log(`scenario: ${scenarioName}`);
console.log(`llm    : ${describeLlm(llm)}`);
console.log(`baseDir : ${baseDir}`);
console.log(`relay   : ${relayUrl}`);
if (llm.mode === "ollama" || llm.mode === "anthropic" || llm.recordCassettePath) {
    console.log(`cassette record: ${cassetteRecordPath}`);
}
if (llm.mode === "openrouter") {
    console.log(`openrouter model: ${llm.openrouterModel}`);
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
    { kinds: [1, 24010, 24020, 24133, 24135, 31933], since: startTime },
    { onevent: (event) => events.push(event) }
);

const runtimeProc = spawnLogged(
    "runtime",
    tenexBin,
    ["runtime", projectDtag, "--base-dir", baseDir],
    {
        cwd:
            scenarioName === "mcp-tool-basic" || scenarioName === "mcp-resource-basic"
                ? workspaceDir
                : repoRoot,
        env: runtimeEnv(llm, mockScenarioPath, requestRecordPath, cassetteRecordPath),
    }
);

await waitForOutput(runtimeProc, "subscriptions active", 15_000);
if (isCrossProjectScenario && projectBEvent) {
    const runtimeBProc = spawnLogged(
        "runtime-b",
        tenexBin,
        ["runtime", projectBDtag, "--base-dir", baseDir],
        {
            cwd: repoRoot,
            env: runtimeEnv(llm, mockScenarioPath, requestRecordPath, cassetteRecordPath),
        }
    );
    await waitForOutput(runtimeBProc, "subscriptions active", 15_000);
    await Promise.all(pool.publish([relayUrl], projectBEvent));
}
await Promise.all(pool.publish([relayUrl], projectEvent));
let scenarioError: unknown = null;
try {
    await runScenario(scenarioName, {
        pool,
        events,
        relayUrl,
        projectDtag,
        projectRef,
        workspaceDir,
        agentsDir,
        conversationDbPath: convDbPath,
        pmPubkey: pm.pubkey,
        workerPubkey: isCrossProjectScenario && projectBWorker ? projectBWorker.pubkey : worker.pubkey,
        ownerPubkey: owner.pubkey,
        ownerSecret: owner.secret,
        userSecret: user.secret,
        requestRecordPath,
        sign,
        now,
        delay,
        waitForObservedEvent,
        waitForRequestRecord,
        publishProjectEvent: async (agentPubkeys, createdAt) => {
            const event = buildProjectEvent(agentPubkeys, createdAt);
            await Promise.all(pool.publish([relayUrl], event));
            return event;
        },
        configureWorkerForAcp: () => {
            const workerAgentPath = path.join(agentsDir, `${worker.pubkey}.json`);
            const agent = JSON.parse(readFileSync(workerAgentPath, "utf8")) as Record<string, unknown>;
            agent.default = { model: acpProbeModelName };
            agent.runtime = buildAcpProbeRuntime();
            writeJson(workerAgentPath, agent);
        },
        monitorConversation: (conversationId, onEvent) =>
            monitorConversation(pool, relayUrl, conversationId, {
                since: startTime,
                onEvent,
                delay,
            }),
    });
} catch (error) {
    scenarioError = error;
    console.error(`scenario driver failed: ${errorMessage(error)}`);
}
sub.close();

let mergedEvents = events;
try {
    const storedEvents = await pool.querySync(
        [relayUrl],
        { kinds: [1, 24010, 24020, 24133, 24135, 31933], since: startTime },
        { maxWait: 2_000 }
    );
    mergedEvents = mergeEvents(events, storedEvents);
} catch (error) {
    console.error(`relay artifact query failed: ${errorMessage(error)}`);
}
pool.close([relayUrl]);

writeJson(artifactPath, mergedEvents);
writeJson(transcriptArtifactPath, readAllConversationTranscripts(convDbPath));
writeJson(
    processOutputArtifactPath,
    procs.map((proc) => ({
        label: proc.label,
        output: proc.output,
    }))
);

const requestRecords = [
    ...readRequestRecords(requestRecordPath),
    ...readRequestRecords(cassetteRecordPath),
];
const mcpProbeRecords = mcpProbe ? readJsonLines(mcpProbe.logPath) : [];
const verdicts = evaluate(scenarioName, mergedEvents, requestRecords, {
    pmPubkey: pm.pubkey,
    workerPubkey: isCrossProjectScenario && projectBWorker ? projectBWorker.pubkey : worker.pubkey,
    modelName: llmModelName,
    llmProvider: llm.mode,
    conversationDbPath: convDbPath,
    mcpProbeRecords,
    workspaceDir,
    ownerPubkey: owner.pubkey,
    agentHomeDir: path.join(baseDir, "agents", pm.pubkey, "home"),
});
if (scenarioError) {
    verdicts.unshift({
        name: "Scenario driver completed",
        ok: false,
        detail: errorMessage(scenarioError),
    });
}
for (const verdict of verdicts) {
    const prefix = verdict.ok
        ? "ok  "
        : verdict.pending
        ? "skip"
        : "BAD ";
    console.log(`${prefix} ${verdict.name}`);
    if (!verdict.ok) {
        console.log(`    ${verdict.detail}`);
    }
}
const passedCount = verdicts.filter((v) => v.ok).length;
const failedCount = verdicts.filter((v) => !v.ok && !v.pending).length;
const skippedCount = verdicts.filter((v) => v.pending).length;
console.log(`---`);
console.log(`verdicts: ${passedCount} ok, ${failedCount} bad, ${skippedCount} skip (total ${verdicts.length})`);
if (verbose) {
    console.log("--- verbose event timeline ---");
    for (const event of mergedEvents) {
        const toolTag = event.tags.find((tag) => tag[0] === "tool");
        const statusTag = event.tags.find((tag) => tag[0] === "status");
        const kind = event.kind;
        const author = event.pubkey === pm.pubkey ? "pm" : event.pubkey === worker.pubkey ? "worker" : event.pubkey.slice(0, 8);
        const toolLabel = toolTag ? ` tool=${toolTag[1] ?? ""}` : "";
        const statusLabel = statusTag ? ` status=${statusTag[1] ?? ""}` : "";
        const contentPreview = event.content.slice(0, 120).replace(/\n/g, " \\n");
        console.log(`  kind=${kind} ${author}${toolLabel}${statusLabel}: ${contentPreview}`);
    }
    console.log("--- verbose request records ---");
    for (const record of requestRecords) {
        const tools = record.toolCalls?.join(",") ?? "(none)";
        const contentPreview = (record.content ?? "").slice(0, 80).replace(/\n/g, " \\n");
        console.log(`  ${record.agent} turn=${record.turn} tools=[${tools}] delay=${record.delayMs}ms: ${contentPreview}`);
    }
}
console.log(`events : ${artifactPath}`);
console.log(`conversations : ${transcriptArtifactPath}`);
console.log(`processes : ${processOutputArtifactPath}`);
if (llm.mode === "mock" || llm.mode === "cassette") {
    console.log(`requests : ${requestRecordPath}`);
}
if (llm.mode === "ollama" || llm.mode === "anthropic" || llm.mode === "openrouter" || llm.recordCassettePath) {
    console.log(`cassette : ${cassetteRecordPath}`);
}

if (!keep) {
    cleanup();
}

// `pending` failures mark known unimplemented gaps and do not break the
// probe run; only hard failures (BAD) flip the exit code.
process.exit(verdicts.every((v) => v.ok || v.pending) ? 0 : 1);

function resolveRelayCommand(configPath: string): { cmd: string; args: string[]; cwd: string } {
    const candidates = [
        process.env.TENEX_RELAY_BIN,
        path.join(repoRoot, "relay", "dist", "tenex-relay-linux-amd64"),
        path.join(repoRoot, "relay", "dist", "tenex-relay-x86_64"),
        path.join(repoRoot, "relay", "dist", "tenex-relay-arm64"),
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
    const repoRelayDir = path.join(repoRoot, "relay");
    if (existsSync(repoRelayDir)) {
        return { cmd: "go", args: ["run", ".", "-config", configPath], cwd: repoRelayDir };
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
    if (options.mode === "ollama" || options.mode === "anthropic" || options.recordCassettePath) {
        env.TENEX_LLM_CASSETTE_RECORD_PATH = cassettePath;
    }
    if (options.mode === "openrouter") {
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
    if (options.mode === "anthropic") {
        return `anthropic/${options.anthropicModel}`;
    }
    if (options.mode === "openrouter") {
        return `openrouter/${options.openrouterModel}`;
    }
    if (options.mode === "cassette") {
        return `cassette factor=${options.generationTimeFactor}`;
    }
    return "mock";
}

function buildAcpProbeRuntime(options: { delegateViaMcp?: boolean } = {}): Record<string, unknown> {
    const backend = process.env.TENEX_PROBE_ACP_BACKEND ?? "fake";
    const model = process.env.TENEX_PROBE_ACP_MODEL ?? "haiku";
    if (backend === "claude") {
        const command = process.env.TENEX_PROBE_ACP_COMMAND ?? "npx";
        const args = process.env.TENEX_PROBE_ACP_ARGS
            ? JSON.parse(process.env.TENEX_PROBE_ACP_ARGS)
            : ["-y", "@agentclientprotocol/claude-agent-acp@latest"];
        const env: Record<string, string> = {
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL:
                process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001",
        };
        for (const key of ["ANTHROPIC_API_KEY", "HOME", "XDG_CONFIG_HOME"]) {
            const value = process.env[key];
            if (value) {
                env[key] = value;
            }
        }
        return {
            provider: "acp",
            backend: "claude-code",
            command,
            args,
            model,
            permissionPolicy: "allow",
            env,
        };
    }
    const env: Record<string, string> = {
        ANTHROPIC_MODEL: model,
        TENEX_PROBE_ACP_MODEL: model,
        TENEX_PROBE_ACP_RESPONSE: `haiku acp worker completed with model ${model}`,
    };
    if (options.delegateViaMcp) {
        env.TENEX_PROBE_ACP_DELEGATE_RECIPIENT = "worker";
        env.TENEX_PROBE_ACP_DELEGATE_PROMPT = delegationWorkerPrompt;
        env.TENEX_PROBE_ACP_RESPONSE = "Delegation started.";
    }
    return {
        provider: "acp",
        backend: "fake-claude-code",
        command: process.execPath,
        args: [path.join(scriptDir, "tenex-runtime-probe-acp.ts")],
        model,
        permissionPolicy: "allow",
        env,
    };
}

function buildProjectEvent(agentPubkeys: string[], createdAt = now()): Event {
    return sign(
        {
            kind: 31933,
            created_at: createdAt,
            content: "",
            tags: [
                ["d", projectDtag],
                ["title", "TENEX runtime probe"],
                ["client", "tenex-runtime-probe"],
                ...agentPubkeys.map((pubkey) => ["p", pubkey]),
            ],
        },
        owner.secret
    );
}

function positionalArgs(args: string[]): string[] {
    const valueFlags = new Set([
        "--llm",
        "--cassette",
        "--record-cassette",
        "--llm-generation-time-factor",
        "--ollama-model",
        "--ollama-base-url",
        "--openrouter-model",
        "--openrouter-api-key",
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cleanup(): void {
    for (const proc of procs.splice(0).reverse()) {
        if (!proc.child.killed) {
            proc.child.kill("SIGTERM");
        }
    }
}
