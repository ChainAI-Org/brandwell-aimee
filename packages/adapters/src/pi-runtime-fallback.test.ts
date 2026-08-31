import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { managedStreamFunction, streamWithFallbackModels } from "./pi-runtime.js";

function testModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function assistantMessage(
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  text = "",
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: text ? 1 : 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: text ? 2 : 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
    timestamp: Date.now(),
  };
}

function eventStream(events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
  });
  return stream;
}

describe("managed model fallbacks", () => {
  it("uses the next model when the primary fails before output", async () => {
    const primary = testModel("vendor/primary");
    const fallback = testModel("vendor/fallback");
    const primaryError = assistantMessage(primary, "error");
    const fallbackDone = assistantMessage(fallback, "stop", "ok");
    const streamSimple = vi.fn((model: Model<Api>) =>
      model.id === primary.id
        ? eventStream([
            { type: "start", partial: assistantMessage(primary, "pending") },
            { type: "error", reason: "error", error: primaryError },
          ])
        : eventStream([
            { type: "start", partial: assistantMessage(fallback, "pending") },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "ok",
              partial: fallbackDone,
            },
            { type: "done", reason: "stop", message: fallbackDone },
          ]),
    );
    const selected = vi.fn();
    const events: AssistantMessageEvent[] = [];

    for await (const event of streamWithFallbackModels(
      { streamSimple } as never,
      primary,
      [fallback],
      { messages: [] },
      undefined,
      selected,
    )) {
      events.push(event);
    }

    expect(streamSimple).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "done")).toMatchObject({
      message: { model: fallback.id },
    });
    expect(selected).toHaveBeenCalledWith(fallback);
  });

  it("does not retry after text has been exposed", async () => {
    const primary = testModel("vendor/primary");
    const fallback = testModel("vendor/fallback");
    const partial = assistantMessage(primary, "pending", "partial");
    const failed = assistantMessage(primary, "error", "partial");
    const streamSimple = vi.fn(() =>
      eventStream([
        { type: "start", partial: assistantMessage(primary, "pending") },
        { type: "text_delta", contentIndex: 0, delta: "partial", partial },
        { type: "error", reason: "error", error: failed },
      ]),
    );
    const events: AssistantMessageEvent[] = [];

    for await (const event of streamWithFallbackModels(
      { streamSimple } as never,
      primary,
      [fallback],
      { messages: [] },
    )) {
      events.push(event);
    }

    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
  });

  it("does not retry after a provider throws once text is exposed", async () => {
    const primary = testModel("vendor/primary");
    const fallback = testModel("vendor/fallback");
    const partial = assistantMessage(primary, "pending", "partial");
    const streamSimple = vi.fn(() =>
      (async function* () {
        yield { type: "start", partial: assistantMessage(primary, "pending") } as const;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial,
        } as const;
        throw new Error("socket reset");
      })(),
    );
    const events: AssistantMessageEvent[] = [];

    for await (const event of streamWithFallbackModels(
      { streamSimple } as never,
      primary,
      [fallback],
      { messages: [] },
    )) {
      events.push(event);
    }

    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { model: primary.id, errorMessage: "socket reset" },
    });
  });

  it("does not retry when a provider stream closes after exposing text", async () => {
    const primary = testModel("vendor/primary");
    const fallback = testModel("vendor/fallback");
    const partial = assistantMessage(primary, "pending", "partial");
    const streamSimple = vi.fn(() =>
      (async function* () {
        yield { type: "start", partial: assistantMessage(primary, "pending") } as const;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial,
        } as const;
      })(),
    );
    const events: AssistantMessageEvent[] = [];

    for await (const event of streamWithFallbackModels(
      { streamSimple } as never,
      primary,
      [fallback],
      { messages: [] },
    )) {
      events.push(event);
    }

    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        model: primary.id,
        errorMessage: "The model stream ended before completion.",
      },
    });
  });

  it("keeps the configured fallback ahead of the computer model for ordinary chat", async () => {
    const primary = testModel("vendor/general");
    const fallback = testModel("vendor/fallback");
    const computer: Model<"openai-completions"> = {
      ...testModel("vendor/computer"),
      input: ["text", "image"],
    };
    const primaryError = assistantMessage(primary, "error");
    const streamSimple = vi.fn((model: Model<Api>) => {
      if (model.id === primary.id) {
        return eventStream([
          { type: "start", partial: assistantMessage(primary, "pending") },
          { type: "error", reason: "error", error: primaryError },
        ]);
      }
      const done = assistantMessage(model, "stop", "ok");
      return eventStream([
        { type: "start", partial: assistantMessage(model, "pending") },
        { type: "done", reason: "stop", message: done },
      ]);
    });
    const workloadSelected = vi.fn();
    const stream = managedStreamFunction(
      { streamSimple } as never,
      primary,
      [fallback],
      computer,
      undefined,
      "reasoning",
      workloadSelected,
    );

    for await (const _event of stream(primary, { messages: [] })) {
      // Exhaust the selected model stream.
    }

    expect(streamSimple.mock.calls.map(([model]) => model.id)).toEqual([primary.id, fallback.id]);
    expect(workloadSelected).toHaveBeenCalledWith("reasoning");
  });

  it("recalculates reasoning options for every fallback candidate", async () => {
    const primary: Model<"openai-completions"> = {
      ...testModel("vendor/reasoning-primary"),
      reasoning: true,
    };
    const fallback: Model<"openai-completions"> = {
      ...testModel("vendor/reasoning-fallback"),
      reasoning: true,
    };
    const primaryError = assistantMessage(primary, "error");
    const streamSimple = vi.fn((model: Model<Api>) => {
      if (model.id === primary.id) {
        return eventStream([
          { type: "start", partial: assistantMessage(primary, "pending") },
          { type: "error", reason: "error", error: primaryError },
        ]);
      }
      const done = assistantMessage(model, "stop", "ok");
      return eventStream([
        { type: "start", partial: assistantMessage(model, "pending") },
        { type: "done", reason: "stop", message: done },
      ]);
    });

    for await (const _event of streamWithFallbackModels(
      { streamSimple } as never,
      primary,
      [fallback],
      { messages: [] },
      undefined,
      undefined,
      "high",
    )) {
      // Exhaust both attempts.
    }

    expect(streamSimple).toHaveBeenCalledTimes(2);
    expect(
      streamSimple.mock.calls.map(
        (call) =>
          ((call as unknown as unknown[])[2] as { reasoning?: string } | undefined)?.reasoning,
      ),
    ).toEqual(["high", "high"]);
  });

  it("switches to the managed computer model after image tool context", async () => {
    const primary = testModel("vendor/general");
    const computer: Model<"openai-completions"> = {
      ...testModel("vendor/computer"),
      input: ["text", "image"],
    };
    const streamSimple = vi.fn((model: Model<Api>) => {
      const done = assistantMessage(model, "stop", "ok");
      return eventStream([
        { type: "start", partial: assistantMessage(model, "pending") },
        { type: "done", reason: "stop", message: done },
      ]);
    });
    const workloadSelected = vi.fn();
    const stream = managedStreamFunction(
      { streamSimple } as never,
      primary,
      [],
      computer,
      undefined,
      "reasoning",
      workloadSelected,
    );

    for await (const _event of stream(primary, {
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
          timestamp: Date.now(),
        },
      ],
    })) {
      // Exhaust the selected model stream.
    }

    expect(streamSimple).toHaveBeenCalledWith(computer, expect.anything(), undefined);
    expect(workloadSelected).toHaveBeenCalledWith("computer");
  });
});
