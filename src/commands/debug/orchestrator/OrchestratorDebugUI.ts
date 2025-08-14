import chalk from "chalk";
import inquirer from "inquirer";
import { logger } from "@/utils/logger";
import type { Phase } from "@/conversations/phases";
import { ALL_PHASES, PHASE_DESCRIPTIONS } from "@/conversations/phases";
import type { 
    OrchestratorDebugState, 
    DebugAction, 
    SimulatedCompletion,
    ExportFormat 
} from "./types";
import type { 
    RoutingEntry, 
    OrchestratorTurn, 
    Completion 
} from "@/conversations/types";
import type { AgentInstance } from "@/agents/types";
import { v4 as uuidv4 } from 'uuid';

export class OrchestratorDebugUI {
    displayState(state: OrchestratorDebugState): void {
        // Don't clear console here since menu will handle it
    }

    async promptMainAction(state: OrchestratorDebugState, lastAction?: DebugAction): Promise<DebugAction> {
        // Build dynamic menu based on current state
        const choices = this.buildDynamicMenu(state, lastAction);
        
        // Show menu with shortcuts
        return this.showMenuWithShortcuts(choices, state);
    }
    
    private async showMenuWithShortcuts(choices: any[], state?: OrchestratorDebugState): Promise<DebugAction> {
        const readline = await import('readline');
        
        // Create shortcut map
        const shortcutMap = new Map<string, string>();
        let selectedIndex = 0;
        const selectableChoices: any[] = [];
        
        // Display the menu
        console.clear();
        logger.info(chalk.cyan("🎭 Orchestrator Debug Tool\n"));
        
        // Show state if provided
        if (state) {
            this.showStateInfo(state);
        }
        
        logger.info(chalk.gray("Use arrow keys to navigate, Enter to select, or press shortcut keys directly\n"));
        
        choices.forEach((choice, index) => {
            if (choice.type === 'separator') {
                logger.info(chalk.gray(choice.line || "──────────"));
            } else if (choice.value) {
                selectableChoices.push(choice);
                const isSelected = selectableChoices.length - 1 === selectedIndex;
                const prefix = isSelected ? chalk.cyan('❯ ') : '  ';
                const name = isSelected ? chalk.cyan(choice.name) : choice.name;
                logger.info(prefix + name);
                
                // Map shortcuts
                if (choice.short) {
                    shortcutMap.set(choice.short.toLowerCase(), choice.value);
                }
            }
        });
        
        return new Promise((resolve) => {
            // Ensure stdin is resumed before setting raw mode
            process.stdin.resume();
            readline.emitKeypressEvents(process.stdin);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            
            const cleanup = () => {
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.removeAllListeners('keypress');
                process.stdin.pause();
            };
            
            process.stdin.on('keypress', (str, key) => {
                if (key.ctrl && key.name === 'c') {
                    cleanup();
                    process.exit(0);
                }
                
                // Check for direct shortcuts
                const shortcut = str?.toLowerCase();
                if (shortcut && shortcutMap.has(shortcut)) {
                    cleanup();
                    resolve(shortcutMap.get(shortcut) as DebugAction);
                    return;
                }
                
                // Handle arrow keys
                if (key.name === 'up') {
                    selectedIndex = Math.max(0, selectedIndex - 1);
                    this.redrawMenu(choices, selectedIndex, state);
                } else if (key.name === 'down') {
                    selectedIndex = Math.min(selectableChoices.length - 1, selectedIndex + 1);
                    this.redrawMenu(choices, selectedIndex, state);
                } else if (key.name === 'return') {
                    cleanup();
                    resolve(selectableChoices[selectedIndex].value as DebugAction);
                }
            });
        });
    }
    
    private showStateInfo(state: OrchestratorDebugState): void {
        logger.info(chalk.white("Current State:"));
        logger.info(chalk.gray(`  Phase: ${chalk.yellow(state.phase)}`));
        logger.info(chalk.gray(`  Routing History: ${chalk.yellow(state.routingHistory.length)} entries`));
        
        if (state.currentRouting) {
            const completed = state.currentRouting.completions.length;
            const expected = state.currentRouting.agents.length;
            logger.info(chalk.gray(`  Active Routing: ${chalk.yellow(state.currentRouting.agents.join(', '))} (${completed}/${expected} completed)`));
        } else {
            logger.info(chalk.gray(`  Active Routing: ${chalk.gray('none')}`));
        }
        
        if (state.userRequest) {
            const preview = state.userRequest.length > 50 
                ? state.userRequest.substring(0, 50) + "..." 
                : state.userRequest;
            logger.info(chalk.gray(`  User Message: "${chalk.cyan(preview)}"`));
        } else {
            logger.info(chalk.gray(`  User Message: ${chalk.gray('not set')}`));
        }
        
        logger.info("");
    }
    
    private redrawMenu(choices: any[], selectedIndex: number, state?: OrchestratorDebugState): void {
        console.clear();
        logger.info(chalk.cyan("🎭 Orchestrator Debug Tool\n"));
        
        if (state) {
            this.showStateInfo(state);
        }
        
        logger.info(chalk.gray("Use arrow keys to navigate, Enter to select, or press shortcut keys directly\n"));
        
        let selectableIndex = 0;
        choices.forEach((choice) => {
            if (choice.type === 'separator') {
                logger.info(chalk.gray(choice.line || "──────────"));
            } else if (choice.value) {
                const isSelected = selectableIndex === selectedIndex;
                const prefix = isSelected ? chalk.cyan('❯ ') : '  ';
                const name = isSelected ? chalk.cyan(choice.name) : choice.name;
                logger.info(prefix + name);
                selectableIndex++;
            }
        });
    }
    
    private buildDynamicMenu(state: OrchestratorDebugState, lastAction?: DebugAction): any[] {
        const choices: any[] = [];
        const hasUserMessage = !!state.userRequest;
        const hasRouting = state.routingHistory.length > 0 || state.currentRouting !== null;
        const hasActiveRouting = state.currentRouting !== null;
        const needsCompletion = hasActiveRouting && state.currentRouting && 
            state.currentRouting.completions.length < state.currentRouting.agents.length;
        
        // Priority 1: Most likely next action based on last action
        if (lastAction === 'run-orchestrator' && hasUserMessage) {
            // After running orchestrator, likely want to add completion
            choices.push({ 
                name: chalk.yellow("[A]") + " Simulate Agent Completion", 
                value: "add-completion",
                short: "A"
            });
        } else if (lastAction === 'add-completion' && needsCompletion) {
            // After adding completion, likely want to add another or run orchestrator
            choices.push({ 
                name: chalk.yellow("[A]") + " Add Another Completion", 
                value: "add-completion",
                short: "A"
            });
            choices.push({ 
                name: chalk.yellow("[R]") + " Run Orchestrator", 
                value: "run-orchestrator",
                short: "R"
            });
        } else if (!hasUserMessage) {
            // No user message yet - this should be first
            choices.push({ 
                name: chalk.yellow("[U]") + " Create User Message", 
                value: "user-message",
                short: "U"
            });
        } else if (needsCompletion) {
            // Has active routing that needs completions
            choices.push({ 
                name: chalk.yellow("[A]") + " Complete Pending Agents", 
                value: "add-completion",
                short: "A"
            });
        } else if (hasUserMessage && !hasActiveRouting) {
            // Has message but no active routing - run orchestrator
            choices.push({ 
                name: chalk.yellow("[R]") + " Run Orchestrator", 
                value: "run-orchestrator",
                short: "R"
            });
        }
        
        // Add separator if we added priority items
        if (choices.length > 0) {
            choices.push(new inquirer.Separator("── Other Actions ──"));
        }
        
        // Secondary actions based on state
        if (hasUserMessage) {
            if (!choices.find(c => c.value === 'run-orchestrator')) {
                choices.push({ 
                    name: "[R] Run Orchestrator", 
                    value: "run-orchestrator",
                    short: "R"
                });
            }
            
            // Add debug reasoning option after running orchestrator
            if (lastAction === 'run-orchestrator' || hasRouting) {
                choices.push({ 
                    name: chalk.cyan("[D]") + " Debug Reasoning (Ask why)", 
                    value: "debug-reasoning",
                    short: "D"
                });
            }
            
            if (!choices.find(c => c.value === 'add-completion')) {
                choices.push({ 
                    name: "[A] Simulate Agent Completion", 
                    value: "add-completion",
                    short: "A"
                });
            }
            choices.push({ 
                name: "[U] Edit User Message", 
                value: "user-message",
                short: "U"
            });
        }
        
        // Phase management
        choices.push({ 
            name: "[P] Change Phase (current: " + state.phase + ")", 
            value: "change-phase",
            short: "P"
        });
        
        // History management if there's history
        if (hasRouting) {
            choices.push({ 
                name: "[H] View/Edit Routing History (" + state.routingHistory.length + " entries)", 
                value: "edit-history",
                short: "H"
            });
        }
        
        // Advanced actions
        choices.push({ 
            name: "[I] Inject Orchestrator Turn", 
            value: "inject-turn",
            short: "I"
        });
        
        choices.push({ 
            name: "[L] Load from Conversation", 
            value: "load-conversation",
            short: "L"
        });
        
        // Utility actions
        choices.push(new inquirer.Separator("── Utilities ──"));
        
        choices.push({ 
            name: "[G] List Agents", 
            value: "list-agents",
            short: "G"
        });
        
        choices.push({ 
            name: "[S] Show Full Context", 
            value: "show-context",
            short: "S"
        });
        
        if (hasRouting || hasUserMessage) {
            choices.push({ 
                name: "[E] Export State", 
                value: "export-state",
                short: "E"
            });
        }
        
        choices.push({ 
            name: "[C] Clear All State", 
            value: "clear-state",
            short: "C"
        });
        
        choices.push(new inquirer.Separator());
        choices.push({ 
            name: "[X] Exit", 
            value: "exit",
            short: "X"
        });
        
        return choices;
    }

    async promptUserMessage(current: string): Promise<string> {
        logger.info(chalk.cyan("\n📝 Enter User Message"));
        if (current) {
            logger.info(chalk.gray(`Current: "${current}"`));
        }
        logger.info(chalk.gray("(Enter multiple lines, press Ctrl+D to finish)\n"));

        // Use readline for better control over input
        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '> '
        });

        const lines: string[] = [];
        
        return new Promise((resolve) => {
            // Show initial prompt
            rl.prompt();

            rl.on('line', (line) => {
                lines.push(line);
                rl.prompt();
            });

            rl.on('close', () => {
                // Ctrl+D was pressed
                const result = lines.join('\n').trim();
                rl.removeAllListeners();
                rl.pause();
                process.stdin.pause();
                resolve(result || current);
            });

            // Handle Ctrl+C
            rl.on('SIGINT', () => {
                rl.removeAllListeners();
                rl.close();
                rl.pause();
                process.stdin.pause();
                resolve(current); // Keep existing on cancel
            });
        });
    }

    async promptAgentCompletion(agents: AgentInstance[]): Promise<SimulatedCompletion> {
        const { agentSlug } = await inquirer.prompt([
            {
                type: "list",
                name: "agentSlug",
                message: "Select agent to simulate completion from:",
                choices: agents.map(a => ({
                    name: `${a.name} (${a.slug})`,
                    value: a.slug
                }))
            }
        ]);

        logger.info(chalk.cyan(`\n📝 Enter completion message for ${agentSlug}:`));
        logger.info(chalk.gray("(Enter multiple lines, press Ctrl+D to finish)\n"));

        // Use readline for multiline input
        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '> '
        });

        const responseLines: string[] = [];
        
        const response = await new Promise<string>((resolve) => {
            rl.prompt();

            rl.on('line', (line) => {
                responseLines.push(line);
                rl.prompt();
            });

            rl.on('close', () => {
                // Ctrl+D was pressed
                rl.removeAllListeners();
                rl.pause();
                process.stdin.pause();
                resolve(responseLines.join('\n').trim());
            });

            rl.on('SIGINT', () => {
                rl.removeAllListeners();
                rl.close();
                rl.pause();
                process.stdin.pause();
                resolve(''); // Return empty on cancel
            });
        });

        return {
            agentSlug,
            response,
            summary: undefined,
            timestamp: Date.now()
        };
    }

    async promptPhaseChange(currentPhase: Phase, validTransitions: readonly Phase[]): Promise<Phase | null> {
        if (validTransitions.length === 0) {
            logger.warn(chalk.yellow(`No valid transitions from ${currentPhase}`));
            return null;
        }

        const { newPhase } = await inquirer.prompt([
            {
                type: "list",
                name: "newPhase",
                message: `Select new phase (current: ${currentPhase}):`,
                choices: [
                    ...ALL_PHASES.map(phase => ({
                        name: `${phase} - ${PHASE_DESCRIPTIONS[phase]}${
                            validTransitions.includes(phase) ? "" : chalk.red(" (invalid transition)")
                        }`,
                        value: phase,
                        disabled: !validTransitions.includes(phase)
                    })),
                    new inquirer.Separator(),
                    { name: "Cancel", value: null }
                ]
            }
        ]);

        return newPhase;
    }

    async promptTransitionReason(): Promise<string> {
        const { reason } = await inquirer.prompt([
            {
                type: "input",
                name: "reason",
                message: "Enter transition reason (optional):"
            }
        ]);
        return reason;
    }

    async promptHistoryAction(history: RoutingEntry[]): Promise<{ type: 'edit' | 'delete' | 'cancel', index?: number }> {
        logger.info(chalk.cyan("\n📜 Routing History:\n"));
        
        history.forEach((entry, index) => {
            logger.info(chalk.white(`${index + 1}. [${entry.phase}] → ${entry.agents.join(', ')}`));
            if (entry.reason) {
                logger.info(chalk.gray(`   Reason: "${entry.reason}"`));
            }
            if (entry.completions.length > 0) {
                logger.info(chalk.gray(`   Completions:`));
                entry.completions.forEach(c => {
                    const preview = c.message.length > 60 
                        ? c.message.substring(0, 60) + "..." 
                        : c.message;
                    logger.info(chalk.gray(`     - ${c.agent}: "${preview}"`));
                });
            }
            logger.info("");
        });

        const { action } = await inquirer.prompt([
            {
                type: "list",
                name: "action",
                message: "Select action:",
                choices: [
                    ...history.map((_, index) => ({
                        name: `Edit entry ${index + 1}`,
                        value: `edit-${index}`
                    })),
                    ...history.map((_, index) => ({
                        name: `Delete entry ${index + 1}`,
                        value: `delete-${index}`
                    })),
                    new inquirer.Separator(),
                    { name: "Cancel", value: "cancel" }
                ]
            }
        ]);

        if (action === "cancel") {
            return { type: "cancel" };
        }

        const [type, indexStr] = action.split("-");
        return { 
            type: type as 'edit' | 'delete', 
            index: parseInt(indexStr) 
        };
    }

    async editRoutingEntry(entry: RoutingEntry): Promise<RoutingEntry> {
        logger.info(chalk.cyan("\n✏️ Edit Routing Entry\n"));
        
        const { field } = await inquirer.prompt([
            {
                type: "list",
                name: "field",
                message: "What would you like to edit?",
                choices: [
                    { name: "Phase", value: "phase" },
                    { name: "Agents", value: "agents" },
                    { name: "Reason", value: "reason" },
                    { name: "Completions", value: "completions" },
                    { name: "Cancel", value: "cancel" }
                ]
            }
        ]);

        if (field === "cancel") {
            return entry;
        }

        const edited = { ...entry };

        switch (field) {
            case "phase":
                const { newPhase } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "newPhase",
                        message: "Select phase:",
                        choices: ALL_PHASES,
                        default: entry.phase
                    }
                ]);
                edited.phase = newPhase;
                break;

            case "agents":
                const { newAgents } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "newAgents",
                        message: "Enter agents (comma-separated):",
                        default: entry.agents.join(", ")
                    }
                ]);
                edited.agents = newAgents.split(",").map((a: string) => a.trim()).filter(Boolean);
                break;

            case "reason":
                const { newReason } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "newReason",
                        message: "Enter reason:",
                        default: entry.reason
                    }
                ]);
                edited.reason = newReason;
                break;

            case "completions":
                // For now, just clear completions
                const { clearCompletions } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "clearCompletions",
                        message: "Clear all completions?",
                        default: false
                    }
                ]);
                if (clearCompletions) {
                    edited.completions = [];
                }
                break;
        }

        return edited;
    }

    async promptOrchestratorTurn(agents: AgentInstance[], currentPhase: Phase): Promise<OrchestratorTurn> {
        const { agentSlugs } = await inquirer.prompt([
            {
                type: "input",
                name: "agentSlugs",
                message: "Target agents (comma-separated slugs):"
            }
        ]);

        const targetAgents = agentSlugs.split(",").map((a: string) => a.trim()).filter(Boolean);

        const { reason } = await inquirer.prompt([
            {
                type: "input",
                name: "reason",
                message: "Routing reason:"
            }
        ]);

        const { useCustomPhase } = await inquirer.prompt([
            {
                type: "confirm",
                name: "useCustomPhase",
                message: `Use different phase? (current: ${currentPhase})`,
                default: false
            }
        ]);

        let phase = currentPhase;
        if (useCustomPhase) {
            const { newPhase } = await inquirer.prompt([
                {
                    type: "list",
                    name: "newPhase",
                    message: "Select phase:",
                    choices: ALL_PHASES
                }
            ]);
            phase = newPhase;
        }

        const { markCompleted } = await inquirer.prompt([
            {
                type: "confirm",
                name: "markCompleted",
                message: "Mark as completed?",
                default: false
            }
        ]);

        const completions: Completion[] = [];
        if (markCompleted) {
            // Ask for completions for each agent
            for (const agent of targetAgents) {
                const { hasCompletion } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "hasCompletion",
                        message: `Add completion for ${agent}?`,
                        default: true
                    }
                ]);

                if (hasCompletion) {
                    const { message } = await inquirer.prompt([
                        {
                            type: "input",
                            name: "message",
                            message: `Completion message for ${agent}:`
                        }
                    ]);

                    completions.push({
                        agent,
                        message,
                        timestamp: Date.now()
                    });
                }
            }
        }

        return {
            turnId: uuidv4(),
            timestamp: Date.now(),
            phase,
            agents: targetAgents,
            completions,
            reason,
            isCompleted: markCompleted
        };
    }

    async promptConversationId(): Promise<string> {
        const { id } = await inquirer.prompt([
            {
                type: "input",
                name: "id",
                message: "Enter conversation ID or nevent:"
            }
        ]);
        return id;
    }

    async promptExportFormat(): Promise<ExportFormat> {
        const { type } = await inquirer.prompt([
            {
                type: "list",
                name: "type",
                message: "Select export format:",
                choices: [
                    { name: "TypeScript test case", value: "typescript" },
                    { name: "JSON fixture", value: "json" },
                    { name: "Markdown documentation", value: "markdown" }
                ]
            }
        ]);

        const { filename } = await inquirer.prompt([
            {
                type: "input",
                name: "filename",
                message: "Filename (optional, press enter for default):"
            }
        ]);

        return {
            type: type as 'typescript' | 'json' | 'markdown',
            filename: filename || undefined
        };
    }

    async confirm(message: string): Promise<boolean> {
        const { confirmed } = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirmed",
                message,
                default: false
            }
        ]);
        return confirmed;
    }

    async promptToContinue(): Promise<void> {
        await inquirer.prompt({
            type: "input",
            name: "continue",
            message: "Press Enter to continue..."
        });
    }
    
    async promptDebugQuestion(): Promise<string> {
        logger.info(chalk.cyan("\n🔍 Debug Reasoning"));
        logger.info(chalk.gray("Ask the orchestrator why it made a decision (e.g., 'Why did you route to executor?')"));
        logger.info(chalk.gray("Press Ctrl+D to finish your question\n"));

        // Use readline for multiline input
        const readline = await import('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '> '
        });

        const lines: string[] = [];
        
        return new Promise((resolve) => {
            rl.prompt();

            rl.on('line', (line) => {
                lines.push(line);
                rl.prompt();
            });

            rl.on('close', () => {
                // Ctrl+D was pressed
                const result = lines.join('\n').trim();
                rl.removeAllListeners();
                rl.pause();
                process.stdin.pause();
                resolve(result || "Why did you make that routing decision?");
            });

            rl.on('SIGINT', () => {
                rl.removeAllListeners();
                rl.close();
                rl.pause();
                process.stdin.pause();
                resolve(""); // Return empty on cancel
            });
        });
    }
}