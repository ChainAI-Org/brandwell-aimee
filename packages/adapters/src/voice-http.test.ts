import { describe, expect, it, vi } from "vitest";
import { speechUploadName, voiceDeadline } from "./voice-http.js";

describe("voiceDeadline", () => {
  it("aborts when the client signal aborts", () => {
    const client = new AbortController();
    const combined = voiceDeadline(client.signal, 20_000);
    expect(combined.aborted).toBe(false);
    client.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the deadline elapses even if the client stays connected", async () => {
    const combined = voiceDeadline(new AbortController().signal, 1);
    // Subscribe like the HTTP consumer and verify the abort event itself,
    // rather than only polling the state of an unobserved signal.
    const onAbort = vi.fn();
    combined.addEventListener("abort", onAbort, { once: true });
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalledOnce());
    expect(combined.aborted).toBe(true);
  });
});

describe("speechUploadName", () => {
  it("keeps webm recordings as webm even when they name an opus codec", () => {
    expect(speechUploadName("audio/webm;codecs=opus")).toBe("speech.webm");
  });

  it("maps Firefox ogg capture to an ogg filename", () => {
    expect(speechUploadName("audio/ogg; codecs=opus")).toBe("speech.ogg");
  });
});
