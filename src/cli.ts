// CLI entry point for TENEX - Node.js compatible
import { main } from "./tenex.js";
import { handleCliError } from "./utils/cli-error.js";

main().catch((error) => {
  handleCliError(error, "Fatal error in TENEX CLI");
});
