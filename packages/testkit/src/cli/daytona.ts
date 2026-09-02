import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { verifyLiveDaytonaProvider } from "../daytona-canary.js";

loadRootEnv();

verifyLiveDaytonaProvider().catch((error) => {
  console.error(formatErrorChain(error));
  process.exitCode = 1;
});

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      messages.push(String(current));
      break;
    }
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\nCaused by: ");
}
