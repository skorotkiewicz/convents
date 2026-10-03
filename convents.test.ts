import { expect, spyOn, test } from "bun:test";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { parseConfig } from "./config";
import { runDebate, type DebateEvent } from "./debate";
import { mountTui } from "./tui";

const source = await Bun.file("config.toml").text();

type ChatRequest = { model: string; messages: { role: string; content: string }[]; max_tokens: number };
type DecisionRequest = { model: string; state: string; questions: Record<string, { type: string; criteria?: Record<string, string> }> };

function mockServers(options: { gate?: boolean; badJudge?: boolean; badChoice?: boolean; httpError?: boolean; empty?: boolean; truncateFinal?: boolean; delay?: number; ready?: number } = {}) {
  const chats: ChatRequest[] = [];
  const decisions: DecisionRequest[] = [];
  const starts = Promise.withResolvers<void>();
  const barrier = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/systemone") {
        const body = await request.json() as DecisionRequest;
        decisions.push(body);
        if (options.httpError) return new Response("unavailable", { status: 503 });
        if (body.questions.winner) {
          return Response.json({ answers: { winner: { type: "choice", choice: options.badChoice ? "99" : "2", confidence: 0.9, probabilities: { "0": 0.05, "1": 0.05, "2": 0.9 } } } });
        }
        return Response.json({ answers: {
          quality: { type: "score", score: 2.8 },
          ready: { type: "noul", noul: options.badJudge ? "not-a-number" : options.ready ?? 0.95 },
        } });
      }
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = await request.json() as ChatRequest;
      chats.push(body);
      starts.resolve();
      if (options.gate && chats.length <= 3) {
        if (chats.length === 3) barrier.resolve();
        await barrier.promise; // A sequential implementation deadlocks here and fails the test timeout.
      }
      if (options.delay) await Bun.sleep(options.delay);
      const prompt = body.messages.at(-1)!.content;
      const phase = prompt.includes("Write the final answer") ? "final" : prompt.includes("Previous round") ? "critique" : "proposal";
      const text = options.empty ? "" : `${body.model} ${phase}: use SQLite with verified backups.`;
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: text.slice(0, 12) }) + chunk({ content: text.slice(12) }) + chunk({}, options.truncateFinal && phase === "final" ? "length" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const config = parseConfig(source);
  config.llms.forEach(llm => { llm.base_url = `${server.url}v1`; llm.model = llm.name; });
  config.decision.url = `${server.url}v1/systemone`;
  config.debate.timeout_ms = 2000;
  return { server, config, chats, decisions, started: starts.promise };
}

function judgedCount(events: DebateEvent[]) { return events.filter(event => event.type === "judged").length; }

test("TOML validation rejects invalid boundaries and missing secrets", () => {
  expect(parseConfig(source).llms).toHaveLength(3);
  for (const [from, to] of [
    ['name = "Skeptic"', 'name = "Builder"'],
    ["max_rounds = 2", "max_rounds = 0"],
    ["max_rounds = 2", "max_rounds = 2.5"],
    ["readiness_threshold = 0.8", "readiness_threshold = 1.5"],
    ['base_url = "http://127.0.0.1:8888/v1"', 'base_url = "file:///tmp/provider"'],
    ['name = "Builder"', 'name = ""'],
    ['name = "Builder"', 'api_key_env = "CONVENTS_TEST_MISSING_KEY"\nname = "Builder"'],
  ]) expect(() => parseConfig(source.replace(from!, to!))).toThrow();
});

test("three seats start together, critique peers, and judge every response including the final", async () => {
  const mock = mockServers({ gate: true });
  const events: DebateEvent[] = [];
  try {
    mock.config.debate.max_rounds = 4;
    const reply = await runDebate(mock.config, "How should I store data?", event => events.push(event));
    expect(events.slice(0, 3).map(event => event.type)).toEqual(["start", "start", "start"]);
    expect(mock.chats).toHaveLength(7); // Three proposals, three critiques, one synthesis.
    expect(judgedCount(events)).toBe(7);
    expect(mock.decisions).toHaveLength(9); // Plus a candidate choice after each round.
    expect(mock.decisions.every(request => typeof request.state === "string" && request.model === mock.config.decision.model)).toBe(true);
    for (const chat of mock.chats.slice(3, 6)) {
      const prompt = chat.messages.at(-1)!.content;
      for (const name of ["Builder", "Skeptic", "Reviewer"]) expect(prompt).toContain(`${name} proposal`);
      expect(prompt).toContain("Laya preferred Reviewer");
    }
    expect(mock.chats.at(-1)!.model).toBe("Reviewer");
    expect(reply.name).toBe("Reviewer");
    expect(reply.phase).toBe("final");
    expect(reply.text).toContain("SQLite");
    expect(JSON.parse(mock.decisions.at(-1)!.state).response.phase).toBe("final");
  } finally { mock.server.stop(true); }
});

test("low readiness continues debate until the configured round limit", async () => {
  const mock = mockServers({ ready: 0.1 });
  try {
    mock.config.debate.max_rounds = 3;
    const reply = await runDebate(mock.config, "A question");
    expect(mock.chats).toHaveLength(10);
    expect(reply.round).toBe(3);
    expect(reply.verdict.ready).toBe(0.1);
  } finally { mock.server.stop(true); }
});

for (const [name, options, message] of [
  ["malformed Laya rating", { badJudge: true }, "readiness probability"],
  ["invalid Laya candidate", { badChoice: true }, "winner choice"],
  ["Laya HTTP failure", { httpError: true }, "HTTP 503"],
  ["empty LLM response", { empty: true }, "no complete text"],
] as const) {
  test(`stops honestly on ${name}`, async () => {
    const mock = mockServers(options);
    try {
      await expect(runDebate(mock.config, "A question")).rejects.toThrow(message);
      expect(mock.chats.length).toBeLessThanOrEqual(3);
    } finally { mock.server.stop(true); }
  });
}

test("cancellation and timeout abort in-flight requests", async () => {
  for (const timeout of [false, true]) {
    const mock = mockServers({ delay: 150 });
    const controller = new AbortController();
    try {
      if (timeout) mock.config.debate.timeout_ms = 30;
      const outcome = runDebate(mock.config, "A question", undefined, controller.signal).then(reply => reply, error => error);
      await mock.started;
      if (!timeout) controller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(mock.decisions).toHaveLength(0);
    } finally { mock.server.stop(true); }
  }
});

test("token-limited final answers are still judged and flagged", async () => {
  const mock = mockServers({ truncateFinal: true });
  try {
    const reply = await runDebate(mock.config, "A question");
    expect(reply.truncated).toBe(true);
    expect(JSON.parse(mock.decisions.at(-1)!.state).response.truncated).toBe(true);
  } finally { mock.server.stop(true); }
});

test("OpenTUI streams complete text, supports keyboard input, and resizes", async () => {
  const mock = mockServers({ truncateFinal: true });
  const setup = await createTestRenderer({ width: 120, height: 36 });
  try {
    const app = mountTui(setup.renderer, mock.config);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("CONVENTS");
    await setup.mockInput.typeText("A question");
    expect(app.input.value).toBe("A question");
    await app.submit(app.input.value);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    for (const text of ["Builder", "Skeptic", "Reviewer", "Laya", "review advised", "Reviewer final: use SQLite"]) expect(frame).toContain(text);
    expect(frame).not.toContain("[object Object]");
    setup.mockInput.pressTab();
    expect(app.input.focused).toBe(false);
    setup.resize(60, 24);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("CONVENTS");
  } finally {
    setup.renderer.destroy();
    mock.server.stop(true);
  }
});

test("conversation context reaches every LLM and Laya, and /new clears it without a request", async () => {
  const mock = mockServers();
  const setup = await createTestRenderer({ width: 120, height: 36 });
  try {
    const app = mountTui(setup.renderer, mock.config);
    await app.submit("How should I store my data?");
    const first = { question: "How should I store my data?", answer: "Reviewer final: use SQLite with verified backups." };
    expect(mock.chats.every(chat => chat.messages.length === 2)).toBe(true);
    expect(mock.decisions.every(request => JSON.parse(request.state).conversation.length === 0)).toBe(true);

    await app.submit("Make that shorter.");
    expect(mock.chats).toHaveLength(14);
    expect(mock.decisions).toHaveLength(18);
    for (const chat of mock.chats.slice(7)) {
      expect(chat.messages.slice(1, -1)).toEqual([
        { role: "user", content: first.question },
        { role: "assistant", content: first.answer },
      ]);
      expect(chat.messages.at(-1)!.content).toContain("Make that shorter.");
    }
    for (const request of mock.decisions.slice(9)) expect(JSON.parse(request.state).conversation).toEqual([first]);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Turn 2 saved");
    expect(frame).toContain(first.question);
    expect(frame).toContain("Make that shorter.");

    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Previous context cleared");
    expect(setup.captureCharFrame()).not.toContain(first.question);
    expect(mock.chats).toHaveLength(14);
    expect(mock.decisions).toHaveLength(18);
    expect(app.input.value).toBe("");

    await app.submit("A different subject.");
    expect(mock.chats.slice(14).every(chat => chat.messages.length === 2)).toBe(true);
    expect(mock.decisions.slice(18).every(request => JSON.parse(request.state).conversation.length === 0)).toBe(true);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Turn 1 saved");
  } finally {
    setup.renderer.destroy();
    mock.server.stop(true);
  }
});

test("failed and cancelled turns do not pollute conversation context", async () => {
  const options = { badJudge: false, delay: 0 };
  const mock = mockServers(options);
  const setup = await createTestRenderer({ width: 120, height: 36 });
  try {
    const app = mountTui(setup.renderer, mock.config);
    await app.submit("The completed question.");
    options.badJudge = true;
    await app.submit("The failed question.");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Not saved to conversation");
    options.badJudge = false;
    options.delay = 150;
    const cancelled = app.submit("The cancelled question.");
    setup.mockInput.pressEscape();
    await cancelled;
    options.delay = 0;
    const startChats = mock.chats.length;
    const startDecisions = mock.decisions.length;
    await app.submit("Continue the completed question.");
    for (const chat of mock.chats.slice(startChats)) {
      expect(chat.messages.slice(1, -1)).toEqual([
        { role: "user", content: "The completed question." },
        { role: "assistant", content: "Reviewer final: use SQLite with verified backups." },
      ]);
    }
    for (const request of mock.decisions.slice(startDecisions)) {
      expect(JSON.parse(request.state).conversation).toEqual([
        { question: "The completed question.", answer: "Reviewer final: use SQLite with verified backups." },
      ]);
    }
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Turn 2 saved");
  } finally {
    setup.renderer.destroy();
    mock.server.stop(true);
  }
});

test("final header and Enter copy the latest completed answer without changing body selection", async () => {
  const mock = mockServers();
  const setup = await createTestRenderer({ width: 120, height: 36 });
  // Use the remote terminal path so this test never writes the real host clipboard.
  setRendererCapabilities(setup.renderer, { remote: true, osc52_support: "supported" });
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
  async function clickHeader(button: 0 | 2 = 0) {
    await setup.renderOnce();
    const y = setup.captureCharFrame().split("\n").findIndex(line => line.includes("┌") && line.includes("Final answer"));
    expect(y).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(5, y, button);
    await Bun.sleep(0);
    await setup.renderOnce();
    return y;
  }
  try {
    const app = mountTui(setup.renderer, mock.config);
    await clickHeader();
    expect(copy).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).toContain("No completed final answer");

    await app.submit("How should I store data?");
    const y = await clickHeader();
    const answer = "Reviewer final: use SQLite with verified backups.";
    expect(copy.mock.calls.map(call => call[0])).toEqual([answer]);
    expect(setup.captureCharFrame()).toContain("Final answer sent to terminal clipboard");
    await clickHeader(2);
    expect(copy).toHaveBeenCalledTimes(1);

    await setup.mockMouse.drag(2, y + 2, 10, y + 2);
    const selection = setup.renderer.getSelection()?.getSelectedText();
    expect(selection).toBeTruthy();
    expect(copy).toHaveBeenCalledTimes(1);
    await clickHeader();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe(selection);
    setup.mockInput.pressEnter();
    await Bun.sleep(0);
    expect(copy).toHaveBeenCalledTimes(3);
    expect(copy.mock.calls.at(-1)![0]).toBe(answer);

    mock.config.llms[2]!.model = "LatestReviewer";
    await app.submit("Make that shorter.");
    await clickHeader();
    expect(copy.mock.calls.at(-1)![0]).toBe("LatestReviewer final: use SQLite with verified backups.");
    copy.mockReturnValue(false);
    await clickHeader();
    expect(setup.captureCharFrame()).toContain("Clipboard unavailable");
    copy.mockImplementation(() => { throw new Error("clipboard test failure"); });
    await clickHeader();
    expect(setup.captureCharFrame()).toContain("Copy failed: clipboard test failure");

    await app.submit("/new");
    const count = copy.mock.calls.length;
    await clickHeader();
    expect(copy).toHaveBeenCalledTimes(count);
    expect(setup.captureCharFrame()).toContain("No completed final answer");
  } finally {
    setup.renderer.destroy();
    copy.mockRestore();
    mock.server.stop(true);
  }
});
