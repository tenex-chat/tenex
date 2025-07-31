import { fragmentRegistry } from "./FragmentRegistry";
import type { FragmentConfig, PromptFragment } from "./types";

export class PromptBuilder {
    private fragments: FragmentConfig[] = [];

    add<T>(fragmentId: string, args: T, condition?: (args: T) => boolean): this {
        if (!fragmentRegistry.has(fragmentId)) {
            throw new Error(
                `Fragment "${fragmentId}" not found in registry. Available fragments: ${fragmentRegistry.getAllIds().join(", ")}`
            );
        }
        this.fragments.push({
            fragmentId,
            args,
            condition: condition ? (unknownArgs) => condition(unknownArgs as T) : undefined,
        });
        return this;
    }

    addFragment<T>(fragment: PromptFragment<T>, args: T, condition?: (args: T) => boolean): this {
        fragmentRegistry.register(fragment);
        this.fragments.push({
            fragmentId: fragment.id,
            args,
            condition: condition ? (unknownArgs) => condition(unknownArgs as T) : undefined,
        });
        return this;
    }

    build(): string {
        const fragmentsWithPriority = this.fragments
            .filter((config) => !config.condition || config.condition(config.args))
            .map((config) => {
                const fragment = fragmentRegistry.get(config.fragmentId);
                if (!fragment) {
                    throw new Error(`Fragment ${config.fragmentId} not found`);
                }

                // Validate arguments if validator is provided
                if (fragment.validateArgs && !fragment.validateArgs(config.args)) {
                    const receivedArgs = JSON.stringify(config.args, null, 2);
                    const expectedDesc =
                        fragment.expectedArgs || "Check fragment definition for expected arguments";
                    throw new Error(
                        `Fragment "${config.fragmentId}" received invalid arguments.\n` +
                            `Expected: ${expectedDesc}\n` +
                            `Received: ${receivedArgs}`
                    );
                }

                try {
                    return {
                        priority: fragment.priority || 50,
                        content: fragment.template(config.args),
                    };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const receivedArgs = JSON.stringify(config.args, null, 2);
                    throw new Error(
                        `Error executing fragment "${config.fragmentId}":\n` +
                            `${errorMessage}\n` +
                            `Arguments provided: ${receivedArgs}\n` +
                            `Expected: ${fragment.expectedArgs || "Check fragment definition"}`
                    );
                }
            })
            .sort((a, b) => a.priority - b.priority);

        return fragmentsWithPriority
            .map((f) => f.content)
            .filter((content) => content.trim().length > 0)
            .join("\n\n");
    }

    clear(): this {
        this.fragments = [];
        return this;
    }

    getFragmentCount(): number {
        return this.fragments.length;
    }
}
