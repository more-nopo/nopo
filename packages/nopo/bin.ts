import main from "./src/index.ts";
import { realIO } from "./src/io.ts";
import { withProcessKeepAlive } from "./src/keep-alive.ts";

try {
  await withProcessKeepAlive(async () => {
    await main(realIO);
  });
} catch (error) {
  console.error("Fatal error:", error);
  realIO.exit(1);
}
