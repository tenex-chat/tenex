#!/usr/bin/env bun
import readline from "node:readline";

type JsonRpc = {
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
};

const sessionId = "probe-acp-session";
let model = process.env.ANTHROPIC_MODEL ?? process.env.TENEX_PROBE_ACP_MODEL ?? "haiku";
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

function send(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
