import { OrchestratorDebugger } from "./OrchestratorDebugger";
import { logger } from "@/utils/logger";
import chalk from "chalk";

export async function runDebugOrchestrator(): Promise<void> {
    try {
        const orchestratorDebugger = new OrchestratorDebugger();
        await orchestratorDebugger.run();
    } catch (error) {
        logger.error(chalk.red(`Failed to run orchestrator debugger: ${error}`));
        process.exit(1);
    }
}