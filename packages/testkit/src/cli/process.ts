import { spawn } from "node:child_process";

export function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    // Windows cannot execute pnpm.cmd with shell disabled. A harness launched by pnpm
    // already exposes the package manager entrypoint, so invoke that JavaScript file
    // with the current Node binary instead of opening a command shell.
    const executable = command === "pnpm" && env.npm_execpath ? process.execPath : command;
    const executableArgs =
      command === "pnpm" && env.npm_execpath ? [env.npm_execpath, ...args] : args;
    const child = spawn(executable, executableArgs, { stdio: "inherit", env, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}
