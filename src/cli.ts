import { startServer } from "./mcp.js";
import { init } from "./init.js";

const command = process.argv[2];

if (!command) {
  startServer();
} else if (command === "init") {
  await init();
} else {
  console.error(`[agentic-react] Unknown command: ${command}`);
  process.exit(1);
}
