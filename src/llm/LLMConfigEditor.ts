import { config } from "@/services/ConfigService";
import type { TenexLLMs } from "@/services/config/types";
import {
    createPrompt,
    useState,
    useEffect,
    useRef,
    useKeypress,
    usePrefix,
    isEnterKey,
    isUpKey,
    isDownKey,
    makeTheme,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import chalk from "chalk";
import { inquirerTheme } from "@/utils/cli-theme";
import * as display from "@/commands/setup/display";
import { llmServiceFactory } from "./LLMServiceFactory";
import { ConfigurationManager } from "./utils/ConfigurationManager";
import { ConfigurationTester } from "./utils/ConfigurationTester";
import type { TestResult } from "./utils/ConfigurationTester";
import { ProviderConfigUI } from "./utils/ProviderConfigUI";

type LLMConfigWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string | string[] }>;
};

type ListItem = { name: string; value: string; configName?: string };
type ActionItem = { name: string; value: string; key: string };

type MenuConfig = {
    message: string;
    items: ListItem[];
    actions: ActionItem[];
    onTest?: (configName: string) => Promise<TestResult>;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const menuTheme = {
    icon: { cursor: inquirerTheme.icon.cursor },
    style: {
        highlight: inquirerTheme.style.highlight,
    },
};

const selectWithFooter = createPrompt<string, MenuConfig>((config, done) => {
    const { items, actions } = config;
    const theme = makeTheme(menuTheme);
    // items + actions + Done
    const doneIndex = items.length + actions.length;
    const totalNavigable = doneIndex + 1;

    const [active, setActive] = useState(0);
    const resultsRef = useRef<Record<string, TestResult>>({});
    const [testing, setTesting] = useState<string | null>(null);
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    const prefix = usePrefix({ status: "idle", theme });

    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (testing && !timerRef.current) {
            timerRef.current = setInterval(() => {
                setSpinnerFrame(spinnerFrame + 1);
            }, 80);
        }
        if (!testing && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [testing != null, spinnerFrame]);

    useKeypress((key, rl) => {
        if (testing) return;

        if (isEnterKey(key)) {
            if (active < items.length) {
                done(items[active]!.value);
            } else if (active < doneIndex) {
                done(actions[active - items.length]!.value);
            } else {
                done("done");
            }
        } else if (isUpKey(key) || isDownKey(key)) {
            rl.clearLine(0);
            const offset = isUpKey(key) ? -1 : 1;
            setActive((active + offset + totalNavigable) % totalNavigable);
        } else if (key.name === "t" && active < items.length) {
            const item = items[active];
            if (item?.configName && config.onTest) {
                if (resultsRef.current[item.configName]) return;
                setTesting(item.configName);
                config.onTest(item.configName).then((result) => {
                    resultsRef.current[item.configName!] = result;
                    setTesting(null);
                });
            }
        } else if (key.name === "d" && active < items.length) {
            const configValue = items[active]?.value;
            if (configValue?.startsWith("config:")) {
                const configName = configValue.slice("config:".length);
                done(`delete:${configName}`);
            }
        } else {
            const match = actions.find((a) => a.key === key.name);
            if (match) {
                done(match.value);
            }
        }
    });

    const message = theme.style.message(config.message, "idle");
    const cursor = theme.icon.cursor;
    const lines: string[] = [];

    lines.push(`${prefix} ${message}`);

    if (items.length === 0) {
        lines.push(chalk.dim("  No configurations yet"));
    } else {
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            const isActive = i === active;
            const pfx = isActive ? `${cursor} ` : "  ";
            const color = isActive ? theme.style.highlight : (x: string) => x;
            const name = item.configName;

            if (name && testing === name) {
                const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
                lines.push(`${pfx}${chalk.yellow(frame)} ${color(item.name)}`);
            } else {
                const result = name ? resultsRef.current[name] : undefined;
                if (result) {
                    const icon = result.success ? chalk.green("✓") : chalk.red("✗");
                    const errorHint = !result.success ? ` ${chalk.dim(result.error)}` : "";
                    lines.push(`${pfx}${icon} ${color(item.name)}${errorHint}`);
                } else {
                    lines.push(`${pfx}  ${color(item.name)}`);
                }
            }
        }
    }

    lines.push(`  ${"─".repeat(40)}`);

    for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        const idx = items.length + i;
        const isActive = active === idx;
        const pfx = isActive ? `${cursor} ` : "  ";
        lines.push(`${pfx}${chalk.cyan(action.name)}`);
    }

    const donePfx = active === doneIndex ? `${cursor} ` : "  ";
    lines.push(`${donePfx}${display.doneLabel()}`);

    const helpParts = [
        `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
        `${chalk.bold("⏎")} ${chalk.dim("select")}`,
        `${chalk.bold("t")} ${chalk.dim("test")}`,
        `${chalk.bold("d")} ${chalk.dim("delete")}`,
    ];
    lines.push(chalk.dim(`  ${helpParts.join(chalk.dim(" • "))}`));

    return `${lines.join("\n")}${cursorHide}`;
});

export class LLMConfigEditor {
    private advanced: boolean;

    constructor(options: { advanced?: boolean } = {}) {
        this.advanced = options.advanced ?? false;
    }

    async showMainMenu(): Promise<void> {
        const llmsConfig = await this.loadConfig();

        display.blank();
        display.step(0, 0, "LLM Configuration");
        ProviderConfigUI.displayProviders(llmsConfig);

        const configNames = Object.keys(llmsConfig.configurations);
        const items: ListItem[] = configNames.map((name) => {
            const cfg = llmsConfig.configurations[name];
            const detail =
                cfg.provider === "meta"
                    ? `multi-modal, ${Object.keys((cfg as { variants: Record<string, unknown> }).variants).length} variants`
                    : `${"model" in cfg ? cfg.model : "unknown"}`;
            return {
                name: `${name} ${chalk.dim(detail)}`,
                value: `config:${name}`,
                configName: name,
            };
        });

        const actions: ActionItem[] = [
            { name: `Add new configuration ${chalk.dim("(a)")}`, value: "add", key: "a" },
            { name: `Add multi-modal configuration ${chalk.dim("(m)")}`, value: "addMultiModal", key: "m" },
        ];

        const action = await selectWithFooter({
            message: "Configurations",
            items,
            actions,
            onTest: (configName) => ConfigurationTester.runTest(llmsConfig, configName),
        });

        if (action.startsWith("delete:")) {
            const configName = action.slice("delete:".length);
            await this.deleteConfig(llmsConfig, configName);
        } else if (action === "add") {
            await ConfigurationManager.add(llmsConfig, this.advanced);
            await this.saveConfig(llmsConfig);
        } else if (action === "addMultiModal") {
            await ConfigurationManager.addMultiModal(llmsConfig);
            await this.saveConfig(llmsConfig);
        } else if (action === "done") {
            return;
        }

        await this.showMainMenu();
    }

    private async deleteConfig(llmsConfig: LLMConfigWithProviders, configName: string): Promise<void> {
        delete llmsConfig.configurations[configName];

        if (llmsConfig.default === configName) {
            const remaining = Object.keys(llmsConfig.configurations);
            llmsConfig.default = remaining.length > 0 ? remaining[0] : undefined;
            if (llmsConfig.default) {
                display.hint(`Default changed to "${llmsConfig.default}"`);
            }
        }

        display.success(`Configuration "${configName}" deleted`);
        await this.saveConfig(llmsConfig);
    }

    private async loadConfig(): Promise<LLMConfigWithProviders> {
        const globalPath = config.getGlobalPath();

        const providersConfig = await config.loadTenexProviders(globalPath);
        const llmsConfig = await config.loadTenexLLMs(globalPath);

        return {
            ...llmsConfig,
            providers: providersConfig.providers,
        };
    }

    private async saveConfig(llmsConfig: LLMConfigWithProviders): Promise<void> {
        const { providers, ...llmsWithoutProviders } = llmsConfig;

        await config.saveGlobalProviders({ providers });
        await config.saveGlobalLLMs(llmsWithoutProviders as TenexLLMs);
        await llmServiceFactory.initializeProviders(providers);
    }
}
