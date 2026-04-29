import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type McpProbeFixture = {
    logPath: string;
};

export function setupMcpProbeFixture(options: {
    runDir: string;
    workspaceDir: string;
    bunPath: string;
}): McpProbeFixture {
    const serverPath = path.join(options.runDir, "mcp-probe-server.ts");
    const logPath = path.join(options.runDir, "mcp-probe-server.jsonl");
    writeFileSync(serverPath, mcpServerSource());
    mkdirSync(options.workspaceDir, { recursive: true });
    writeFileSync(
        path.join(options.workspaceDir, ".mcp.json"),
        `${JSON.stringify(
            {
                mcpServers: {
                    probe: {
                        type: "stdio",
                        command: options.bunPath,
                        args: [serverPath],
                        env: { TENEX_MCP_PROBE_LOG: logPath },
                    },
                },
            },
            null,
            2
        )}\n`
    );
    return { logPath };
}

function mcpServerSource(): string {
    return String.raw`import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = process.env.TENEX_MCP_PROBE_LOG;

function log(record: Record<string, unknown>): void {
    if (!logPath) return;
    appendFileSync(logPath, JSON.stringify({ ...record, cwd: process.cwd() }) + "\n");
}

function send(message: unknown): void {
    process.stdout.write(JSON.stringify(message) + "\n");
}

function error(id: unknown, code: number, message: string): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin });
log({ event: "started" });

rl.on("line", (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line) as {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (request.method === "notifications/initialized") {
        log({ event: "initialized" });
        return;
    }

    if (request.id === undefined) {
        return;
    }

    if (request.method === "initialize") {
        log({ event: "initialize" });
        send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "tenex-probe-mcp", version: "1.0.0" },
            },
        });
        return;
    }

    if (request.method === "tools/list") {
        log({ event: "list_tools" });
        send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
                tools: [
                    {
                        name: "answer_probe",
                        description: "Return a deterministic MCP probe response.",
                        inputSchema: {
                            type: "object",
                            properties: { prompt: { type: "string" } },
                            required: ["prompt"],
                            additionalProperties: false,
                        },
                    },
                ],
            },
        });
        return;
    }

    if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        log({ event: "call_tool", toolName: name, args });
        if (name !== "answer_probe") {
            error(request.id, -32602, "unknown tool: " + String(name));
            return;
        }
        send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
                content: [
                    {
                        type: "text",
                        text: "MCP probe answered: " + String(args.prompt ?? "missing"),
                    },
                ],
                isError: false,
            },
        });
        return;
    }

    error(request.id, -32601, "unknown method: " + String(request.method));
});
`;
}
