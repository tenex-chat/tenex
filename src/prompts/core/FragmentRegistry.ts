import type { PromptFragment } from "./types";

export class FragmentRegistry {
  private fragments = new Map<string, PromptFragment<unknown>>();

  register<T>(fragment: PromptFragment<T>): void {
    if (!fragment.id) {
      throw new Error("Fragment must have an id");
    }
    this.fragments.set(fragment.id, fragment as PromptFragment<unknown>);
  }

  get(id: string): PromptFragment<unknown> | undefined {
    return this.fragments.get(id);
  }

  has(id: string): boolean {
    return this.fragments.has(id);
  }

  clear(): void {
    this.fragments.clear();
  }

  getAllIds(): string[] {
    return Array.from(this.fragments.keys());
  }
}

export const fragmentRegistry = new FragmentRegistry();
