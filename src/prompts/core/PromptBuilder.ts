import { formatAnyError } from "@/lib/error-formatter";
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

    async build(): Promise<string> {
        const fragmentsWithPriority = await Promise.all(
            this.fragments
                .filter((config) => !config.condition || config.condition(config.args))
                .map(async (config) => {
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
                            content: await fragment.template(config.args),
                        };
                    } catch (error) {
                        const errorMessage = formatAnyError(error);
                        const receivedArgs = JSON.stringify(config.args, null, 2);
                        throw new Error(
                            `Error executing fragment "${config.fragmentId}":\n` +
                                `${errorMessage}\n` +
                                `Arguments provided: ${receivedArgs}\n` +
                                `Expected: ${fragment.expectedArgs || "Check fragment definition"}`
                        );
                    }
                })
        );

        return fragmentsWithPriority
            .sort((a, b) => a.priority - b.priority)
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

    /**
     * Static method for building a single fragment without creating an instance
     * @param fragmentId The ID of the fragment to build
     * @param args The arguments to pass to the fragment
     * @returns The built fragment content as a string
     */
    static async buildFragment<T>(fragmentId: string, args: T): Promise<string> {
        return await new PromptBuilder().add(fragmentId, args).build();
    }
}
