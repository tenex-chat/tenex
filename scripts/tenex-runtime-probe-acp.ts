#!/usr/bin/env bun
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type JsonRpc = {
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
};

type McpServerConfig = {
    name?: string;
    command?: string;
    args?: string[];
    env?: Array<{ name?: string; value?: string }> | Record<string, string>;
};

const sessionId = "probe-acp-session";
let model = process.env.ANTHROPIC_MODEL ?? process.env.TENEX_PROBE_ACP_MODEL ?? "haiku";
let mcpServers: McpServerConfig[] = [];
const responseText =
    process.env.TENEX_PROBE_ACP_RESPONSE ??
    `haiku acp worker completed with model ${model}`;

const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
});

rl.on("line", (line) => {
    const msg = JSON.parse(line) as JsonRpc;
    void handle(msg).catch((error) => {
        if (msg.id !== undefined) {
            send({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    });
});

async function handle(msg: JsonRpc): Promise<void> {
    if (msg.method === "initialize") {
        send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
                protocolVersion: 1,
                agentCapabilities: {
                    promptCapabilities: {},
                    sessionCapabilities: {},
                },
                agentInfo: {
                    name: "probe-acp",
                    title: "Probe ACP",
                    version: "1.0.0",
                },
                authMethods: [],
            },
        });
        return;
    }

    if (msg.method === "session/new") {
        mcpServers = Array.isArray(msg.params?.mcpServers)
            ? (msg.params.mcpServers as McpServerConfig[])
            : [];
        send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
                sessionId,
                configOptions: configOptions(),
            },
        });
        return;
    }

    if (msg.method === "session/set_config_option") {
        if (msg.params?.configId === "model" && typeof msg.params.value === "string") {
            model = msg.params.value;
        }
        send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { configOptions: configOptions() },
        });
        return;
    }

    if (msg.method === "session/prompt") {
        if (process.env.TENEX_PROBE_ACP_DELEGATE_PROMPT) {
            await delegateViaMcp();
        }
        send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
                sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: responseText },
                },
            },
        });
        send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" },
        });
        return;
    }

    send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unknown method ${msg.method}` },
    });
}

function configOptions(): unknown[] {
    return [
        {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: model,
            options: [
                { value: "haiku", name: "Haiku" },
                { value: "sonnet", name: "Sonnet" },
            ],
        },
    ];
}

async function delegateViaMcp(): Promise<void> {
    const recipient = process.env.TENEX_PROBE_ACP_DELEGATE_RECIPIENT ?? "worker";
    const prompt = process.env.TENEX_PROBE_ACP_DELEGATE_PROMPT;
    const server =
        mcpServers.find((candidate) => candidate.name === "tenex") ?? mcpServers[0];
    if (!prompt) {
        return;
    }
    if (!server?.command) {
        throw new Error("TENEX MCP delegation requested but no MCP server was configured");
    }

    const client = new McpClient(server);
    try {
        await client.request("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "tenex-runtime-probe-acp", version: "1.0.0" },
        });
        client.notify("notifications/initialized", {});
        const listed = await client.request("tools/list", {});
        if (!mcpTools(listed).includes("delegate")) {
            throw new Error("TENEX MCP server did not list delegate");
        }
        const result = await client.request("tools/call", {
            name: "delegate",
            arguments: { recipient, prompt },
        });
        if (mcpToolErrored(result)) {
            throw new Error(`TENEX MCP delegate failed: ${JSON.stringify(result)}`);
        }
    } finally {
        client.close();
    }
}

class McpClient {
    private child: ChildProcessWithoutNullStreams;
    private nextId = 1;
    private pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();

    constructor(config: McpServerConfig) {
        this.child = spawn(config.command!, config.args ?? [], {
            env: mcpEnv(config),
            stdio: ["pipe", "pipe", "inherit"],
        });
        const lines = readline.createInterface({
            input: this.child.stdout,
            crlfDelay: Infinity,
        });
        lines.on("line", (line) => this.handleLine(line));
        this.child.on("error", (error) => this.rejectAll(error));
        this.child.on("exit", (code, signal) => {
            if (this.pending.size > 0) {
                this.rejectAll(
                    new Error(`MCP server exited before responses code=${code} signal=${signal}`)
                );
            }
        });
    }

    request(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = this.nextId;
        this.nextId += 1;
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.write({ jsonrpc: "2.0", id, method, params });
        return promise;
    }

    notify(method: string, params: Record<string, unknown>): void {
        this.write({ jsonrpc: "2.0", method, params });
    }

    close(): void {
        if (!this.child.killed) {
            this.child.kill("SIGTERM");
        }
    }

    private write(value: unknown): void {
        this.child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    private handleLine(line: string): void {
        const message = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
        };
        if (message.id === undefined) {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message ?? "MCP request failed"));
        } else {
            pending.resolve(message.result);
        }
    }

    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function mcpEnv(config: McpServerConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (Array.isArray(config.env)) {
        for (const entry of config.env) {
            if (entry.name && entry.value !== undefined) {
                env[entry.name] = entry.value;
            }
        }
    } else if (config.env) {
        for (const [name, value] of Object.entries(config.env)) {
            env[name] = value;
        }
    }
    return env;
}

function mcpTools(result: unknown): string[] {
    const tools = (result as { tools?: Array<{ name?: unknown }> })?.tools;
    if (!Array.isArray(tools)) {
        return [];
    }
    return tools.flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : []));
}

function mcpToolErrored(result: unknown): boolean {
    return Boolean((result as { isError?: unknown })?.isError);
}

function send(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
