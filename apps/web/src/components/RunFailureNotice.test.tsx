import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunFailureNotice } from "./RunFailureNotice";

describe("task failure notice", () => {
  it("explains a managed connection failure without asking the customer for an API key", () => {
    const html = renderToString(
      <RunFailureNotice
        run={{
          status: "failed",
          error: "BrandWell managed run is unavailable: credential_missing",
        }}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Task failed"');
    expect(html).toContain("Contact your workspace administrator before retrying");
    expect(html).toContain("Failure details");
    expect(html).not.toContain("API key");
  });

  it("safely displays failure details as text", () => {
    const html = renderToString(
      <RunFailureNotice run={{ status: "failed", error: '<script>alert("test")</script>' }} />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("handles failures without an error reason", () => {
    expect(renderToString(<RunFailureNotice run={{ status: "failed", error: null }} />)).toContain(
      "No additional details were reported",
    );
  });

  it.each(["queued", "running", "completed", "cancelled", "waiting_input"] as const)(
    "does not show a stale failure for %s work",
    (status) => {
      expect(renderToString(<RunFailureNotice run={{ status, error: "Old failure" }} />)).toBe("");
    },
  );
  it("does not display a failure in a new chat", () => {
    expect(renderToString(<RunFailureNotice run={null} />)).toBe("");
  });
});
