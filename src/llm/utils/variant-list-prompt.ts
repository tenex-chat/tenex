import {
    createPrompt,
    useState,
    useKeypress,
    usePrefix,
    isUpKey,
    isDownKey,
    isEnterKey,
    isBackspaceKey,
    makeTheme,
    type Theme,
} from "@inquirer/core";
import type { PartialDeep } from "@inquirer/type";
import { cursorHide } from "@inquirer/ansi";
import chalk from "chalk";
import inquirer from "inquirer";
import { inquirerTheme } from "@/utils/cli-theme";
import type { MetaModelConfiguration, MetaModelVariant } from "@/services/config/types";
import * as display from "@/commands/setup/display";

type VariantListAction =
    | { action: "edit"; variantName: string }
    | { action: "add" }
    | { action: "done" };

type VariantListResult = VariantListAction & {
    variants: Record<string, MetaModelVariant>;
    defaultVariant: string;
};

type VariantListConfig = {
    message: string;
    variants: Record<string, MetaModelVariant>;
    defaultVariant: string;
    theme?: PartialDeep<Theme>;
};

const variantListRawPrompt = createPrompt<VariantListResult, VariantListConfig>(
    (config, done) => {
        const theme = makeTheme(config.theme);
        const prefix = usePrefix({ status: "idle", theme });

        const [active, setActive] = useState(0);
        const [variants, setVariants] = useState<Record<string, MetaModelVariant>>(
            () => ({ ...config.variants }),
        );
        const [defaultVariant, setDefaultVariant] = useState(config.defaultVariant);

        const variantNames = Object.keys(variants);
        const addIndex = variantNames.length;
        const doneIndex = variantNames.length + 1;
        const itemCount = variantNames.length + 2;

        useKeypress((key, rl) => {
            rl.clearLine(0);

            if (isUpKey(key)) {
                setActive(Math.max(0, active - 1));
            } else if (isDownKey(key)) {
                setActive(Math.min(itemCount - 1, active + 1));
            } else if (isEnterKey(key)) {
                if (active < variantNames.length) {
                    const name = variantNames[active];
                    if (name) {
                        done({
                            action: "edit",
                            variantName: name,
                            variants: { ...variants },
                            defaultVariant,
                        });
                    }
                } else if (active === addIndex) {
                    done({
                        action: "add",
                        variants: { ...variants },
                        defaultVariant,
                    });
                } else if (active === doneIndex) {
                    if (variantNames.length < 2) return;
                    done({
                        action: "done",
                        variants: { ...variants },
                        defaultVariant,
                    });
                }
            } else if (key.name === "d" && active < variantNames.length) {
                const name = variantNames[active];
                if (name) setDefaultVariant(name);
            } else if (
                (isBackspaceKey(key) || key.name === "delete") &&
                active < variantNames.length
            ) {
                if (variantNames.length <= 2) return;

                const nameToDelete = variantNames[active];
                if (!nameToDelete) return;

                const updated = { ...variants };
                delete updated[nameToDelete];
                setVariants(updated);

                if (defaultVariant === nameToDelete) {
                    const remaining = Object.keys(updated);
                    setDefaultVariant(remaining[0] ?? "");
                }

                const newCount = Object.keys(updated).length;
                if (active >= newCount) {
                    setActive(Math.max(0, newCount - 1));
                }
            }
        });

        // Render
        const cursor = chalk.hex("#FFC107")("›");
        const lines: string[] = [];

        lines.push(`${prefix} ${theme.style.message(config.message, "idle")}`);
        lines.push("");
        lines.push(chalk.dim("  Variants:"));

        for (let i = 0; i < variantNames.length; i++) {
            const name = variantNames[i]!;
            const variant = variants[name]!;
            const isDefault = name === defaultVariant;
            const pfx = i === active ? `${cursor} ` : "  ";
            const defaultTag = isDefault ? chalk.dim(" (default)") : "";
            const modelDisplay = chalk.gray(`[${variant.model}]`);

            lines.push(`${pfx}${name} ${modelDisplay}${defaultTag}`);
        }

        lines.push(`  ${"─".repeat(40)}`);

        // Add variant
        const addPfx = active === addIndex ? `${cursor} ` : "  ";
        lines.push(`${addPfx}${chalk.cyan("Add variant")}`);

        // Done
        const donePfx = active === doneIndex ? `${cursor} ` : "  ";
        if (variantNames.length < 2) {
            lines.push(`${donePfx}${chalk.dim("Done (need at least 2 variants)")}`);
        } else {
            lines.push(`${donePfx}${display.doneLabel()}`);
        }

        // Help line
        const helpParts = [
            `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
            `${chalk.bold("⏎")} ${chalk.dim("edit")}`,
            `${chalk.bold("d")} ${chalk.dim("set default")}`,
            `${chalk.bold("⌫")} ${chalk.dim("remove")}`,
        ];
        lines.push(chalk.dim(`  ${helpParts.join(chalk.dim(" • "))}`));

        return `${lines.join("\n")}${cursorHide}`;
    },
);

async function editVariantDetail(
    variantName: string,
    state: { variants: Record<string, MetaModelVariant>; defaultVariant: string },
    standardConfigs: string[],
): Promise<void> {
    const variant = state.variants[variantName];
    if (!variant) return;

    while (true) {
        const isDefault = variantName === state.defaultVariant;
        const defaultTag = isDefault ? " (default)" : "";

        display.blank();
        display.context(`Variant: ${variantName} → ${variant.model}${defaultTag}`);
        display.blank();

        const { field } = await inquirer.prompt([{
            type: "select",
            name: "field",
            message: `Edit ${variantName}:`,
            choices: [
                {
                    name: `Model              ${chalk.dim(variant.model)}`,
                    value: "model",
                },
                {
                    name: `Trigger keyword    ${chalk.dim(variant.keywords?.join(", ") || "(none)")}`,
                    value: "keywords",
                },
                {
                    name: `When to use        ${chalk.dim(variant.description || "(none)")}`,
                    value: "description",
                },
                {
                    name: `Behavior when active  ${chalk.dim(variant.systemPrompt || "(none)")}`,
                    value: "systemPrompt",
                    description: "Extra instructions given to the agent when this variant is selected, e.g. 'Reason step by step'",
                },
                {
                    name: "Back",
                    value: "back",
                },
            ],
            theme: inquirerTheme,
        }]);

        if (field === "back") break;

        if (field === "model") {
            const { model } = await inquirer.prompt([{
                type: "select",
                name: "model",
                message: "Select model:",
                choices: standardConfigs.map((n) => ({ name: n, value: n })),
                theme: inquirerTheme,
            }]);
            variant.model = model;
        } else if (field === "keywords") {
            const { keywordsInput } = await inquirer.prompt([{
                type: "input",
                name: "keywordsInput",
                message: "Trigger keywords (comma-separated):",
                default: variant.keywords?.join(", ") || "",
                theme: inquirerTheme,
            }]);
            const keywords = keywordsInput
                ? keywordsInput.split(",").map((k: string) => k.trim().toLowerCase()).filter((k: string) => k.length > 0)
                : [];
            if (keywords.length > 0) {
                variant.keywords = keywords;
            } else {
                delete variant.keywords;
            }
        } else if (field === "description") {
            const { desc } = await inquirer.prompt([{
                type: "input",
                name: "desc",
                message: "When to use this variant:",
                default: variant.description || "",
                theme: inquirerTheme,
            }]);
            if (desc) {
                variant.description = desc;
            } else {
                delete variant.description;
            }
        } else if (field === "systemPrompt") {
            const { prompt } = await inquirer.prompt([{
                type: "input",
                name: "prompt",
                message: "Behavior when active:",
                default: variant.systemPrompt || "",
                theme: inquirerTheme,
            }]);
            if (prompt) {
                variant.systemPrompt = prompt;
            } else {
                delete variant.systemPrompt;
            }
        }
    }
}

async function addVariant(
    state: { variants: Record<string, MetaModelVariant>; defaultVariant: string },
    standardConfigs: string[],
): Promise<void> {
    const { name } = await inquirer.prompt([{
        type: "input",
        name: "name",
        message: "Variant name:",
        validate: (input: string) => {
            if (!input.trim()) return "Name is required";
            if (state.variants[input]) return "Variant already exists";
            return true;
        },
        theme: inquirerTheme,
    }]);

    const { model } = await inquirer.prompt([{
        type: "select",
        name: "model",
        message: "Select model for this variant:",
        choices: standardConfigs.map((n) => ({ name: n, value: n })),
        theme: inquirerTheme,
    }]);

    const isFirst = Object.keys(state.variants).length === 0;

    state.variants[name] = { model };

    // First variant auto-becomes default
    if (!state.defaultVariant || isFirst) {
        state.defaultVariant = name;
    }

    // For non-first variants, ask "when to use" so the system prompt is useful
    if (!isFirst) {
        const { desc } = await inquirer.prompt([{
            type: "input",
            name: "desc",
            message: "When to use this variant:",
            theme: inquirerTheme,
        }]);
        if (desc) {
            state.variants[name]!.description = desc;
        }
    }
}

/**
 * Interactive variant list prompt for multi-modal configuration.
 * Shows variants in a navigable list with add/edit/delete/set-default actions.
 * Returns a complete MetaModelConfiguration when done.
 */
export async function variantListPrompt(
    configName: string,
    standardConfigs: string[],
): Promise<MetaModelConfiguration> {
    let variants: Record<string, MetaModelVariant> = {};
    let defaultVariant = "";

    // No variants yet — go straight to adding the first one
    const initialState = { variants, defaultVariant };
    await addVariant(initialState, standardConfigs);
    variants = initialState.variants;
    defaultVariant = initialState.defaultVariant;

    while (true) {
        const result = await variantListRawPrompt({
            message: configName,
            variants,
            defaultVariant,
            theme: inquirerTheme,
        });

        variants = result.variants;
        defaultVariant = result.defaultVariant;

        if (result.action === "done") {
            return {
                provider: "meta",
                variants,
                default: defaultVariant,
            };
        }

        if (result.action === "edit" && result.variantName) {
            const state = { variants, defaultVariant };
            await editVariantDetail(result.variantName, state, standardConfigs);
            variants = state.variants;
            defaultVariant = state.defaultVariant;
        }

        if (result.action === "add") {
            const state = { variants, defaultVariant };
            await addVariant(state, standardConfigs);
            variants = state.variants;
            defaultVariant = state.defaultVariant;
        }
    }
}
