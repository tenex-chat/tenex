#!/usr/bin/env python3
"""
Probe the Claude Code ACP backend and dump every session/update message
raw so we can see exactly what a tool_call update looks like.

Usage: python3 acp_probe.py [file-to-read]
"""

import json
import os
import subprocess
import sys

TARGET_FILE = sys.argv[1] if len(sys.argv) > 1 else "/etc/hostname"
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")

CMD = ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"]


def send(proc, msg: dict):
    line = json.dumps(msg) + "\n"
    proc.stdin.write(line.encode())
    proc.stdin.flush()


def recv(proc) -> dict:
    line = proc.stdout.readline()
    if not line:
        raise EOFError("ACP process closed stdout")
    return json.loads(line)


def rpc(proc, method: str, params: dict, req_id: int):
    send(proc, {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    while True:
        msg = recv(proc)

        # Incoming client request (e.g. permission prompt) — respond and loop
        if msg.get("method") is not None and msg.get("id") is not None:
            handle_client_request(proc, msg)
            continue

        # Notification (no id, has method)
        if msg.get("method") == "session/update":
            update = msg.get("params", {}).get("update", {})
            kind = update.get("sessionUpdate", "?")
            if kind == "tool_call":
                print("\n" + "=" * 60)
                print("TOOL CALL session/update — full payload:")
                print(json.dumps(update, indent=2))
                print("=" * 60 + "\n")
            elif kind == "agent_message_chunk":
                text = update.get("content", {}).get("text", "")
                print(text, end="", flush=True)
            else:
                print(f"\n[session/update {kind}] {json.dumps(update)}")
            continue

        # Response to our own request
        if msg.get("id") == req_id:
            if "error" in msg:
                raise RuntimeError(f"ACP error from {method}: {msg['error']}")
            return msg.get("result")


def handle_client_request(proc, msg: dict):
    method = msg.get("method")
    req_id = msg["id"]
    if method == "session/request_permission":
        options = msg.get("params", {}).get("options", [])
        print(f"[probe] permission request, options: {[o.get('kind') for o in options]}")
        option_id = next(
            (o["optionId"] for o in options if o.get("kind", "").startswith("allow")),
            options[0]["optionId"] if options else None,
        )
        print(f"[probe] choosing option: {option_id}")
        result = (
            {"outcome": "selected", "optionId": option_id}
            if option_id
            else {"outcome": "cancelled"}
        )
        send(proc, {"jsonrpc": "2.0", "id": req_id, "result": result})
    else:
        send(proc, {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"probe does not implement {method}"},
        })


def main():
    env = {**os.environ, "ANTHROPIC_MODEL": MODEL}
    proc = subprocess.Popen(
        CMD,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        env=env,
    )

    try:
        print(f"[probe] spawned ACP — model={MODEL} file={TARGET_FILE}")

        rpc(proc, "initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {"name": "acp-probe", "title": "ACP probe", "version": "0.1"},
        }, 1)

        session_result = rpc(proc, "session/new", {"cwd": os.getcwd(), "mcpServers": []}, 2)
        session_id = session_result["sessionId"]
        print(f"[probe] session={session_id}\n")

        rpc(proc, "session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": f"Please read the file {TARGET_FILE} and tell me what's in it."}],
        }, 3)

        print("\n[probe] done")
    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    main()
