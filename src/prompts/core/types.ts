export interface PromptFragment<T = unknown> {
  id: string;
  priority?: number;
  template: (args: T) => string;
  validateArgs?: (args: unknown) => args is T;
  expectedArgs?: string; // Description of expected arguments for error messages
}

export interface FragmentConfig {
  fragmentId: string;
  args: unknown;
  condition?: (args: unknown) => boolean;
}
