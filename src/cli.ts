// CLI entry point for TENEX - Node.js compatible
import { main } from "./tenex.js";

main().catch((error) => {
    console.error("Fatal error in TENEX CLI", error);
    process.exit(1);
});