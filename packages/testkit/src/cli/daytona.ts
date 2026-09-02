import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { verifyLiveDaytonaProvider } from "../daytona-canary.js";

loadRootEnv();

verifyLiveDaytonaProvider().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
