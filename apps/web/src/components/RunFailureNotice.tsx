import type { Run } from "@rakazo/contracts";
import { AlertCircle } from "lucide-react";
import { BuiCard } from "./beautiful-ui/primitives";

export function RunFailureNotice({ run }: { run: Pick<Run, "status" | "error"> | null }) {
  if (run?.status !== "failed") return null;
  const managedCredentialMissing =
    run.error === "BrandWell managed run is unavailable: credential_missing";

  return (
    <BuiCard
      role="status"
      aria-label="Task failed"
      className="mx-3 mt-3 flex max-h-[30vh] shrink-0 gap-3 overflow-y-auto border border-[#5b2b38] p-4 md:mx-6"
    >
      <AlertCircle aria-hidden size={18} className="mt-0.5 shrink-0 text-[#ff9cab]" />
      <div className="min-w-0 text-[13px] leading-5">
        <p className="font-medium text-[#ff9cab]">This task could not be completed</p>
        <p className="mt-1 text-[#c9c9ce]">
          {managedCredentialMissing
            ? "AIMEE's managed AI connection is unavailable. Contact your workspace administrator before retrying."
            : "Review the failure details before retrying this task."}
        </p>
        <details className="mt-2 text-[#a6a7b1]">
          <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b786ff]">
            Failure details
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {run.error?.trim() || "No additional details were reported."}
          </p>
        </details>
      </div>
    </BuiCard>
  );
}
