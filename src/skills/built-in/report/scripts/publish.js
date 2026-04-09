#!/usr/bin/env node
// publish.js — publish NIP-23 long-form articles (kind 30023) to Nostr
// Inputs (environment):
//   NSEC           — agent private key (nsec1... bech32 or hex)
//   RELAYS         — comma-separated relay URLs (optional, falls back to TENEX config)
//   TENEX_BASE_DIR — base tenex directory (default: ~/.tenex)
// Usage:
//   node publish.js <path> [--project 31933:pubkey:dtag]
//
// <path>       — absolute or project-relative path to a markdown file or directory
// --project    — project a-tag for association (e.g. 31933:abc123:my-project)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

const LONG_FORM_ARTICLE_KIND = 30023;
const DEFAULT_RELAY = "wss://tenex.chat";

const NSEC = process.env.NSEC;
const TENEX_BASE_DIR = process.env.TENEX_BASE_DIR ?? path.join(os.homedir(), ".tenex");

if (!NSEC) {
    process.stderr.write("Error: $NSEC is required\n");
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
    process.stderr.write(
        "Usage: node publish.js <path> [--project 31933:pubkey:dtag]\n" +
        "\n" +
        "  <path>       path to a markdown file or directory\n" +
        "  --project    project a-tag for association\n"
    );
    process.exit(1);
}

const inputPath = path.isAbsolute(args[0])
    ? args[0]
    : path.resolve(process.env.PROJECT_BASE ?? process.cwd(), args[0]);

let projectATag = null;
for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
        projectATag = args[++i];
    }
}

function getRelayUrls() {
    const envRelays = process.env.RELAYS;
    if (envRelays) {
        const urls = envRelays
            .split(",")
            .map((u) => u.trim())
            .filter((u) => u.startsWith("ws://") || u.startsWith("wss://"));
        if (urls.length > 0) {
            return urls;
        }
    }

    try {
        const configPath = path.join(TENEX_BASE_DIR, "config.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (Array.isArray(config.relays) && config.relays.length > 0) {
            return config.relays;
        }
    } catch {
        // No config found
    }

    return [DEFAULT_RELAY];
}

function collectFiles(inputPath) {
    if (!fs.existsSync(inputPath)) {
        process.stderr.write(`Error: path does not exist: ${inputPath}\n`);
        process.exit(1);
    }

    const stat = fs.statSync(inputPath);
    if (!stat.isDirectory()) {
        const filename = path.basename(inputPath);
        return [
            {
                absolutePath: inputPath,
                dTag: filename,
                documentTag: filename.replace(/\.[^.]+$/, ""),
            },
        ];
    }

    const dirName = path.basename(inputPath);
    const files = [];

    function walk(current, base) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath, base);
            } else {
                files.push({
                    absolutePath: fullPath,
                    dTag: `${dirName}/${path.relative(base, fullPath)}`,
                    documentTag: dirName,
                });
            }
        }
    }

    walk(inputPath, inputPath);
    return files.sort((a, b) => a.dTag.localeCompare(b.dTag));
}

async function main() {
    const relayUrls = getRelayUrls();
    const signer = new NDKPrivateKeySigner(NSEC);

    const ndk = new NDK({
        explicitRelayUrls: relayUrls,
        signer,
        enableOutboxModel: false,
    });

    let relayReady = false;
    const readyPromise = new Promise((resolve) => {
        ndk.pool.on("relay:ready", () => {
            if (!relayReady) {
                relayReady = true;
                resolve();
            }
        });
    });

    await ndk.connect();
    await Promise.race([readyPromise, new Promise((resolve) => setTimeout(resolve, 5000))]);

    const files = collectFiles(inputPath);
    if (files.length === 0) {
        process.stderr.write(`Error: no files found at ${inputPath}\n`);
        process.exit(1);
    }

    const published = [];

    for (const file of files) {
        const content = fs.readFileSync(file.absolutePath, "utf-8");

        const event = new NDKEvent(ndk);
        event.kind = LONG_FORM_ARTICLE_KIND;
        event.content = content;
        event.tags = [
            ["d", file.dTag],
            ["document", file.documentTag],
        ];

        if (projectATag) {
            event.tags.push(["a", projectATag]);
        }

        await event.sign(signer);
        await event.publish();

        published.push(file.dTag);
        process.stdout.write(`Published: ${file.dTag}\n`);
    }

    const summary =
        published.length === 1
            ? `Published 1 article: ${published[0]}`
            : `Published ${published.length} articles`;

    process.stdout.write(`\n${summary}\n`);

    for (const relay of ndk.pool.relays.values()) {
        relay.disconnect();
    }

    process.exit(0);
}

main().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
