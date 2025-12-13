import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fragmentRegistry } from "../FragmentRegistry";
import { PromptBuilder } from "../PromptBuilder";
import type { PromptFragment } from "../types";

describe("PromptBuilder.buildFragment static method", () => {
    beforeEach(() => {
        // Clear the global registry before each test
        fragmentRegistry.clear();
    });

    afterEach(() => {
        // Restore registry state
        fragmentRegistry.clear();
    });

    describe("equivalence with instance method", () => {
        it("should produce the same output as the instance method for simple fragments", async () => {
            const fragment: PromptFragment = {
                id: "simple-fragment",
                template: () => "Simple test content",
            };
            fragmentRegistry.register(fragment);

            const staticResult = await PromptBuilder.buildFragment("simple-fragment", {});
            const instanceResult = await new PromptBuilder().add("simple-fragment", {}).build();

            expect(staticResult).toBe(instanceResult);
            expect(staticResult).toBe("Simple test content");
        });

        it("should produce the same output for fragments with arguments", async () => {
            interface TestArgs {
                name: string;
                value: number;
            }

            const fragment: PromptFragment<TestArgs> = {
                id: "args-fragment",
                template: ({ name, value }) => `Name: ${name}, Value: ${value}`,
            };
            fragmentRegistry.register(fragment);

            const args = { name: "Test", value: 42 };
            const staticResult = await PromptBuilder.buildFragment("args-fragment", args);
            const instanceResult = await new PromptBuilder().add("args-fragment", args).build();

            expect(staticResult).toBe(instanceResult);
            expect(staticResult).toBe("Name: Test, Value: 42");
        });

        it("should produce the same output for fragments with priority", async () => {
            const fragment: PromptFragment = {
                id: "priority-fragment",
                priority: 10,
                template: () => "Priority content",
            };
            fragmentRegistry.register(fragment);

            const staticResult = await PromptBuilder.buildFragment("priority-fragment", {});
            const instanceResult = await new PromptBuilder().add("priority-fragment", {}).build();

            expect(staticResult).toBe(instanceResult);
            expect(staticResult).toBe("Priority content");
        });

        it("should handle fragments that return empty content", async () => {
            const fragment: PromptFragment = {
                id: "empty-fragment",
                template: () => "",
            };
            fragmentRegistry.register(fragment);

            const staticResult = await PromptBuilder.buildFragment("empty-fragment", {});
            const instanceResult = await new PromptBuilder().add("empty-fragment", {}).build();

            expect(staticResult).toBe(instanceResult);
            expect(staticResult).toBe("");
        });

        it("should handle fragments that return whitespace-only content", async () => {
            const fragment: PromptFragment = {
                id: "whitespace-fragment",
                template: () => "   \n  \t  ",
            };
            fragmentRegistry.register(fragment);

            const staticResult = await PromptBuilder.buildFragment("whitespace-fragment", {});
            const instanceResult = await new PromptBuilder().add("whitespace-fragment", {}).build();

            expect(staticResult).toBe(instanceResult);
            expect(staticResult).toBe("");
        });
    });

    describe("fragment argument handling", () => {
        it("should correctly pass simple arguments to fragments", async () => {
            interface SimpleArgs {
                message: string;
            }

            const fragment: PromptFragment<SimpleArgs> = {
                id: "simple-args",
                template: ({ message }) => `Message: ${message}`,
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("simple-args", { message: "Hello World" });
            expect(result).toBe("Message: Hello World");
        });

        it("should correctly pass complex nested arguments to fragments", async () => {
            interface ComplexArgs {
                user: {
                    name: string;
                    details: {
                        age: number;
                        roles: string[];
                    };
                };
                settings: {
                    theme: string;
                    notifications: boolean;
                };
            }

            const fragment: PromptFragment<ComplexArgs> = {
                id: "complex-args",
                template: ({ user, settings }) => {
                    const rolesText = user.details.roles.join(", ");
                    return `User: ${user.name} (${user.details.age})\nRoles: ${rolesText}\nTheme: ${settings.theme}\nNotifications: ${settings.notifications}`;
                },
            };
            fragmentRegistry.register(fragment);

            const args: ComplexArgs = {
                user: {
                    name: "Alice",
                    details: {
                        age: 30,
                        roles: ["admin", "user"],
                    },
                },
                settings: {
                    theme: "dark",
                    notifications: true,
                },
            };

            const result = await PromptBuilder.buildFragment("complex-args", args);
            expect(result).toBe(
                "User: Alice (30)\nRoles: admin, user\nTheme: dark\nNotifications: true"
            );
        });

        it("should handle arrays as arguments", async () => {
            interface ArrayArgs {
                items: string[];
                numbers: number[];
            }

            const fragment: PromptFragment<ArrayArgs> = {
                id: "array-args",
                template: ({ items, numbers }) => {
                    return `Items: [${items.join(", ")}]\nNumbers: [${numbers.join(", ")}]`;
                },
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("array-args", {
                items: ["apple", "banana", "cherry"],
                numbers: [1, 2, 3, 4, 5],
            });
            expect(result).toBe("Items: [apple, banana, cherry]\nNumbers: [1, 2, 3, 4, 5]");
        });

        it("should handle null and undefined values in arguments", async () => {
            interface NullableArgs {
                optionalString?: string;
                nullableNumber: number | null;
                undefinedValue: string | undefined;
            }

            const fragment: PromptFragment<NullableArgs> = {
                id: "nullable-args",
                template: ({ optionalString, nullableNumber, undefinedValue }) => {
                    return `Optional: ${optionalString || "not provided"}\nNullable: ${nullableNumber === null ? "null" : nullableNumber}\nUndefined: ${undefinedValue || "undefined"}`;
                },
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("nullable-args", {
                nullableNumber: null,
                undefinedValue: undefined,
            });
            expect(result).toBe("Optional: not provided\nNullable: null\nUndefined: undefined");
        });

        it("should respect fragment validation if provided", async () => {
            interface ValidatedArgs {
                value: number;
            }

            const fragment: PromptFragment<ValidatedArgs> = {
                id: "validated-fragment",
                template: ({ value }) => `Value: ${value}`,
                validateArgs: (args: unknown): args is ValidatedArgs => {
                    return (
                        typeof args === "object" &&
                        args !== null &&
                        "value" in args &&
                        typeof (args as any).value === "number" &&
                        (args as any).value > 0
                    );
                },
                expectedArgs: "{ value: number } where value > 0",
            };
            fragmentRegistry.register(fragment);

            // Valid arguments should work
            const result = await PromptBuilder.buildFragment("validated-fragment", { value: 42 });
            expect(result).toBe("Value: 42");

            // Invalid arguments should throw with descriptive error
            await expect(PromptBuilder.buildFragment("validated-fragment", { value: -1 })).rejects.toThrow(
                'Fragment "validated-fragment" received invalid arguments'
            );
        });
    });

    describe("error handling for non-existent fragments", () => {
        it("should throw error when fragment does not exist", () => {
            expect(() => PromptBuilder.buildFragment("non-existent", {})).toThrow(
                'Fragment "non-existent" not found in registry'
            );
        });

        it("should include available fragments in error message when fragment not found", () => {
            fragmentRegistry.register({ id: "fragment1", template: () => "Test 1" });
            fragmentRegistry.register({ id: "fragment2", template: () => "Test 2" });

            expect(() => PromptBuilder.buildFragment("non-existent", {})).toThrow(
                "Available fragments: fragment1, fragment2"
            );
        });

        it("should provide helpful error message when no fragments are registered", () => {
            expect(() => PromptBuilder.buildFragment("any-fragment", {})).toThrow(
                'Fragment "any-fragment" not found in registry. Available fragments: '
            );
        });

        it("should throw error if fragment template throws during execution", async () => {
            const fragment: PromptFragment = {
                id: "throwing-fragment",
                template: () => {
                    throw new Error("Template execution failed");
                },
                expectedArgs: "No arguments required",
            };
            fragmentRegistry.register(fragment);

            await expect(PromptBuilder.buildFragment("throwing-fragment", {})).rejects.toThrow(
                'Error executing fragment "throwing-fragment"'
            );
        });

        it("should include argument details in template execution error", async () => {
            interface ErrorArgs {
                shouldThrow: boolean;
            }

            const fragment: PromptFragment<ErrorArgs> = {
                id: "conditional-error",
                template: ({ shouldThrow }) => {
                    if (shouldThrow) {
                        throw new Error("Intentional error");
                    }
                    return "Success";
                },
                expectedArgs: "{ shouldThrow: boolean }",
            };
            fragmentRegistry.register(fragment);

            await expect(
                PromptBuilder.buildFragment("conditional-error", { shouldThrow: true })
            ).rejects.toThrow('Error executing fragment "conditional-error"');
        });
    });

    describe("edge cases and boundary conditions", () => {
        it("should handle fragments with zero priority", async () => {
            const fragment: PromptFragment = {
                id: "zero-priority",
                priority: 0,
                template: () => "Zero priority content",
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("zero-priority", {});
            expect(result).toBe("Zero priority content");
        });

        it("should handle fragments with very high priority", async () => {
            const fragment: PromptFragment = {
                id: "high-priority",
                priority: 999999,
                template: () => "High priority content",
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("high-priority", {});
            expect(result).toBe("High priority content");
        });

        it("should handle fragments that return multiline content", async () => {
            const fragment: PromptFragment = {
                id: "multiline-fragment",
                template: () => "Line 1\nLine 2\nLine 3",
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("multiline-fragment", {});
            expect(result).toBe("Line 1\nLine 2\nLine 3");
        });

        it("should handle arguments with special characters and symbols", async () => {
            interface SpecialArgs {
                text: string;
            }

            const fragment: PromptFragment<SpecialArgs> = {
                id: "special-chars",
                template: ({ text }) => `Content: ${text}`,
            };
            fragmentRegistry.register(fragment);

            const result = await PromptBuilder.buildFragment("special-chars", {
                text: "Special chars: !@#$%^&*()_+-=[]{}|;:'\",.<>?/~`",
            });
            expect(result).toBe("Content: Special chars: !@#$%^&*()_+-=[]{}|;:'\",.<>?/~`");
        });
    });
});
