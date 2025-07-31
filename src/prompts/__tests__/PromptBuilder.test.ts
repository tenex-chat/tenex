import { PromptBuilder } from "../core/PromptBuilder";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

describe("PromptBuilder", () => {
    let builder: PromptBuilder;

    beforeEach(() => {
        // Clear the global registry before each test
        fragmentRegistry.clear();

        builder = new PromptBuilder();
    });

    afterEach(() => {
        // Restore registry state
        fragmentRegistry.clear();
    });

    describe("add", () => {
        it("should add fragment by id", () => {
            const fragment: PromptFragment = {
                id: "test-fragment",
                template: () => "Test content",
            };
            fragmentRegistry.register(fragment);

            builder.add("test-fragment", {});
            expect(builder.getFragmentCount()).toBe(1);
        });

        it("should throw error for non-existent fragment", () => {
            expect(() => builder.add("non-existent", {})).toThrow(
                'Fragment "non-existent" not found in registry'
            );
        });

        it("should include available fragments in error message", () => {
            fragmentRegistry.register({ id: "fragment1", template: () => "Test 1" });
            fragmentRegistry.register({ id: "fragment2", template: () => "Test 2" });

            expect(() => builder.add("non-existent", {})).toThrow(
                "Available fragments: fragment1, fragment2"
            );
        });

        it("should support chaining", () => {
            fragmentRegistry.register({ id: "fragment1", template: () => "Test 1" });
            fragmentRegistry.register({ id: "fragment2", template: () => "Test 2" });

            const result = builder.add("fragment1", {}).add("fragment2", {});

            expect(result).toBe(builder);
            expect(builder.getFragmentCount()).toBe(2);
        });

        it("should pass arguments to fragment", () => {
            interface TestArgs {
                name: string;
                value: number;
            }

            const fragment: PromptFragment<TestArgs> = {
                id: "test-fragment",
                template: ({ name, value }) => `Name: ${name}, Value: ${value}`,
            };
            fragmentRegistry.register(fragment);

            const result = builder.add("test-fragment", { name: "Test", value: 42 }).build();

            expect(result).toBe("Name: Test, Value: 42");
        });
    });

    describe("addFragment", () => {
        it("should register and add fragment inline", () => {
            const fragment: PromptFragment = {
                id: "inline-fragment",
                template: () => "Inline content",
            };

            builder.addFragment(fragment, {});

            expect(fragmentRegistry.has("inline-fragment")).toBe(true);
            expect(builder.getFragmentCount()).toBe(1);
        });

        it("should support chaining", () => {
            const result = builder
                .addFragment({ id: "f1", template: () => "Test 1" }, {})
                .addFragment({ id: "f2", template: () => "Test 2" }, {});

            expect(result).toBe(builder);
            expect(builder.getFragmentCount()).toBe(2);
        });
    });

    describe("build", () => {
        it("should concatenate fragments with double newlines", () => {
            fragmentRegistry.register({ id: "f1", template: () => "Fragment 1" });
            fragmentRegistry.register({ id: "f2", template: () => "Fragment 2" });
            fragmentRegistry.register({ id: "f3", template: () => "Fragment 3" });

            const result = builder.add("f1", {}).add("f2", {}).add("f3", {}).build();

            expect(result).toBe("Fragment 1\n\nFragment 2\n\nFragment 3");
        });

        it("should respect fragment priority ordering", () => {
            fragmentRegistry.register({ id: "f1", priority: 30, template: () => "Third" });
            fragmentRegistry.register({ id: "f2", priority: 10, template: () => "First" });
            fragmentRegistry.register({ id: "f3", priority: 20, template: () => "Second" });

            const result = builder.add("f1", {}).add("f2", {}).add("f3", {}).build();

            expect(result).toBe("First\n\nSecond\n\nThird");
        });

        it("should use default priority of 50 when not specified", () => {
            fragmentRegistry.register({ id: "f1", priority: 60, template: () => "Last" });
            fragmentRegistry.register({ id: "f2", template: () => "Middle" }); // default 50
            fragmentRegistry.register({ id: "f3", priority: 40, template: () => "First" });

            const result = builder.add("f1", {}).add("f2", {}).add("f3", {}).build();

            expect(result).toBe("First\n\nMiddle\n\nLast");
        });

        it("should filter out empty content", () => {
            fragmentRegistry.register({ id: "f1", template: () => "Content" });
            fragmentRegistry.register({ id: "f2", template: () => "" });
            fragmentRegistry.register({ id: "f3", template: () => "   " });
            fragmentRegistry.register({ id: "f4", template: () => "More content" });

            const result = builder.add("f1", {}).add("f2", {}).add("f3", {}).add("f4", {}).build();

            expect(result).toBe("Content\n\nMore content");
        });

        it("should respect conditions", () => {
            fragmentRegistry.register({ id: "f1", template: () => "Always shown" });
            fragmentRegistry.register({ id: "f2", template: () => "Conditionally shown" });
            fragmentRegistry.register({ id: "f3", template: () => "Not shown" });

            const result = builder
                .add("f1", {})
                .add("f2", { show: true }, (args: any) => args.show === true)
                .add("f3", { show: false }, (args: any) => args.show === true)
                .build();

            expect(result).toBe("Always shown\n\nConditionally shown");
        });

        it("should handle complex template functions", () => {
            interface UserArgs {
                user: { name: string; role: string };
                permissions: string[];
            }

            const fragment: PromptFragment<UserArgs> = {
                id: "user-fragment",
                template: ({ user, permissions }) => {
                    let prompt = `User: ${user.name} (${user.role})`;
                    if (permissions.length > 0) {
                        prompt += `\nPermissions: ${permissions.join(", ")}`;
                    }
                    return prompt;
                },
            };

            fragmentRegistry.register(fragment);

            const result = builder
                .add("user-fragment", {
                    user: { name: "Alice", role: "Admin" },
                    permissions: ["read", "write", "delete"],
                })
                .build();

            expect(result).toBe("User: Alice (Admin)\nPermissions: read, write, delete");
        });
    });

    describe("clear", () => {
        it("should remove all fragments from builder", () => {
            fragmentRegistry.register({ id: "f1", template: () => "Test 1" });
            fragmentRegistry.register({ id: "f2", template: () => "Test 2" });

            builder.add("f1", {}).add("f2", {});
            expect(builder.getFragmentCount()).toBe(2);

            builder.clear();
            expect(builder.getFragmentCount()).toBe(0);
            expect(builder.build()).toBe("");
        });

        it("should support chaining", () => {
            fragmentRegistry.register({ id: "f1", template: () => "Test" });

            const result = builder.add("f1", {}).clear().add("f1", {});

            expect(result).toBe(builder);
            expect(builder.getFragmentCount()).toBe(1);
        });
    });

    describe("error handling", () => {
        it("should throw error if fragment not found during build", () => {
            // Manually add a fragment config without registering the fragment
            (builder as any).fragments.push({ fragmentId: "non-existent", args: {} });

            expect(() => builder.build()).toThrow("Fragment non-existent not found");
        });
    });
});
