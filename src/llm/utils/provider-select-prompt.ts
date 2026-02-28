import {
    createPrompt,
    useState,
    useKeypress,
    usePrefix,
    useMemo,
    isUpKey,
    isDownKey,
    isSpaceKey,
    isEnterKey,
    makeTheme,
    type Theme,
    type KeypressEvent,
} from "@inquirer/core";
import type { PartialDeep } from "@inquirer/type";
import { cursorHide } from "@inquirer/ansi";
import chalk from "chalk";
import type { ProviderCredentials } from "@/services/config/types";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { ProviderConfigUI } from "@/llm/utils/ProviderConfigUI";
import * as display from "@/commands/setup/display";

// --- Public types ---

export type PromptState = {
    providers: Record<string, ProviderCredentials>;
    stash: Record<string, ProviderCredentials>;
    active: number;
    mode: "browse" | "keys";
    keysTarget: string | null;
    keysActive: number;
};

export type PromptResult =
    | { action: "done"; providers: Record<string, ProviderCredentials> }
    | { action: "add-key"; providerId: string; returnTo: "browse" | "keys"; state: PromptState };

export type ProviderSelectConfig = {
    message: string;
    providerIds: string[];
    initialProviders: Record<string, ProviderCredentials>;
    resumeState?: PromptState;
    theme?: PartialDeep<Theme>;
};

// --- Helpers ---

type Mode = "browse" | "keys";

export function getKeys(apiKey: string | string[] | undefined): string[] {
    if (!apiKey) return [];
    if (Array.isArray(apiKey)) return apiKey.filter((k) => k.length > 0);
    return apiKey.length > 0 && apiKey !== "none" ? [apiKey] : [];
}

function needsApiKey(providerId: string): boolean {
    return providerId !== PROVIDER_IDS.CODEX_APP_SERVER;
}

export function isOllama(providerId: string): boolean {
    return providerId === PROVIDER_IDS.OLLAMA;
}

function formatKeyInfo(apiKey: string | string[] | undefined): string {
    const count = getKeys(apiKey).length;
    if (count === 0) return "";
    return chalk.gray(` [${count} key${count !== 1 ? "s" : ""}]`);
}

function maskKey(providerId: string, key: string): string {
    if (isOllama(providerId)) return key;
    if (key.length <= 4) return "*".repeat(key.length);
    return "*".repeat(key.length - 4) + key.slice(-4);
}

const CURSOR = chalk.hex("#FFC107")("›");
const RULE_WIDTH = 30;

// --- Prompt ---

export default createPrompt<PromptResult, ProviderSelectConfig>((config, done) => {
    const { providerIds, message, resumeState } = config;
    const theme = makeTheme(config.theme);
    const prefix = usePrefix({ status: "idle", theme });
    const doneIndex = providerIds.length;

    const [active, setActive] = useState(resumeState?.active ?? 0);
    const [providers, setProviders] = useState<Record<string, ProviderCredentials>>(
        () => resumeState?.providers ?? { ...config.initialProviders },
    );
    const [stash, setStash] = useState<Record<string, ProviderCredentials>>(
        () => resumeState?.stash ?? {},
    );
    const [mode, setMode] = useState<Mode>(resumeState?.mode ?? "browse");
    const [keysTarget, setKeysTarget] = useState<string | null>(resumeState?.keysTarget ?? null);
    const [keysActive, setKeysActive] = useState(resumeState?.keysActive ?? 0);

    const activeProviderId = useMemo(
        () => (active < providerIds.length ? providerIds[active] : null),
        [active],
    );

    function currentState(): PromptState {
        return { providers, stash, active, mode, keysTarget, keysActive };
    }

    function requestAddKey(providerId: string, returnTo: "browse" | "keys") {
        done({ action: "add-key", providerId, returnTo, state: currentState() });
    }

    // --- Keypress handlers ---

    useKeypress((key, rl) => {
        rl.clearLine(0);
        if (mode === "browse") {
            handleBrowse(key);
        } else {
            handleKeys(key);
        }
    });

    function handleBrowse(key: KeypressEvent) {
        if (isUpKey(key)) {
            setActive(Math.max(0, active - 1));
        } else if (isDownKey(key)) {
            setActive(Math.min(doneIndex, active + 1));
        } else if (isSpaceKey(key) && activeProviderId) {
            toggleProvider(activeProviderId);
        } else if (isEnterKey(key)) {
            if (active === doneIndex) {
                done({ action: "done", providers });
            } else if (activeProviderId && activeProviderId in providers && needsApiKey(activeProviderId)) {
                enterKeysMode(activeProviderId);
            }
        }
    }

    function toggleProvider(pid: string) {
        const enabled = pid in providers;
        if (enabled) {
            const updated = { ...providers };
            const newStash = { ...stash };
            newStash[pid] = updated[pid]!;
            delete updated[pid];
            setProviders(updated);
            setStash(newStash);
        } else if (!needsApiKey(pid)) {
            setProviders({ ...providers, [pid]: { apiKey: "none" } });
        } else if (stash[pid]) {
            const newStash = { ...stash };
            const restored = newStash[pid]!;
            delete newStash[pid];
            setProviders({ ...providers, [pid]: restored });
            setStash(newStash);
        } else {
            requestAddKey(pid, "browse");
        }
    }

    function enterKeysMode(pid: string) {
        setMode("keys");
        setKeysTarget(pid);
        setKeysActive(0);
    }

    function exitKeysMode() {
        setMode("browse");
        setKeysTarget(null);
        setKeysActive(0);
    }

    function handleKeys(key: KeypressEvent) {
        if (!keysTarget) return;

        const keys = getKeys(providers[keysTarget]?.apiKey);
        const addIndex = keys.length;
        const backIndex = keys.length + 1;

        if (isUpKey(key)) {
            setKeysActive(Math.max(0, keysActive - 1));
        } else if (isDownKey(key)) {
            setKeysActive(Math.min(backIndex, keysActive + 1));
        } else if (key.name === "d" && keysActive < keys.length) {
            deleteKey(keysTarget, keysActive, keys);
        } else if (isEnterKey(key)) {
            if (keysActive === addIndex) {
                requestAddKey(keysTarget, "keys");
            } else if (keysActive === backIndex) {
                exitKeysMode();
            }
        } else if (key.name === "escape") {
            exitKeysMode();
        }
    }

    function deleteKey(pid: string, index: number, keys: string[]) {
        const remaining = keys.filter((_, i) => i !== index);
        if (remaining.length === 0) {
            const updated = { ...providers };
            delete updated[pid];
            setProviders(updated);
            exitKeysMode();
        } else {
            setProviders({
                ...providers,
                [pid]: { ...providers[pid], apiKey: remaining.length === 1 ? remaining[0]! : remaining },
            });
            setKeysActive(Math.min(keysActive, remaining.length - 1));
        }
    }

    // --- Rendering ---

    const styledMessage = theme.style.message(message, "idle");
    const lines: string[] = [`${prefix} ${styledMessage}`];

    if (mode === "keys" && keysTarget) {
        renderKeysView(lines, keysTarget);
    } else {
        renderBrowseView(lines);
    }

    return `${lines.join("\n")}${cursorHide}`;

    function renderBrowseView(out: string[]) {
        for (let i = 0; i < providerIds.length; i++) {
            const pid = providerIds[i]!;
            const name = ProviderConfigUI.getProviderDisplayName(pid);
            const pfx = i === active ? `${CURSOR} ` : "  ";
            const enabled = pid in providers;

            if (enabled) {
                const keyInfo = formatKeyInfo(providers[pid]?.apiKey);
                out.push(`${pfx}${display.providerCheck(name)}${keyInfo}`);
            } else {
                out.push(`${pfx}${display.providerUncheck(name)}`);
            }
        }

        const donePfx = active === doneIndex ? `${CURSOR} ` : "  ";
        out.push(`${donePfx}${display.doneLabel()}`);

        const help = [
            `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
            `${chalk.bold("space")} ${chalk.dim("toggle")}`,
            `${chalk.bold("⏎")} ${chalk.dim("manage keys / done")}`,
        ];
        out.push(chalk.dim(`  ${help.join(chalk.dim(" • "))}`));
    }

    function renderKeysView(out: string[], pid: string) {
        const name = ProviderConfigUI.getProviderDisplayName(pid);
        const keys = getKeys(providers[pid]?.apiKey);
        const addIndex = keys.length;
        const backIndex = keys.length + 1;

        out.push(`  ${chalk.bold(name)} ${chalk.dim("— API Keys")}`);
        out.push(`  ${chalk.dim("─".repeat(RULE_WIDTH))}`);

        for (let i = 0; i < keys.length; i++) {
            const pfx = keysActive === i ? `${CURSOR} ` : "  ";
            const masked = maskKey(pid, keys[i]!);
            const deleteHint = keysActive === i ? chalk.dim("  d delete") : "";
            out.push(`${pfx}${masked}${deleteHint}`);
        }

        const addPfx = keysActive === addIndex ? `${CURSOR} ` : "  ";
        out.push(`${addPfx}${chalk.dim("+ Add another key")}`);

        const backPfx = keysActive === backIndex ? `${CURSOR} ` : "  ";
        out.push(`${backPfx}${chalk.dim("← Back")}`);

        const help = [
            `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
            `${chalk.bold("d")} ${chalk.dim("delete key")}`,
            `${chalk.bold("⏎")} ${chalk.dim("select")}`,
            `${chalk.bold("esc")} ${chalk.dim("back")}`,
        ];
        out.push(chalk.dim(`  ${help.join(chalk.dim(" • "))}`));
    }
});
