import { BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import type { Config } from "./config";
import { runDebate, type DebateEvent, type Reply } from "./debate";

const colors = { bg: "#171b19", panel: "#202622", text: "#e8e5d9", muted: "#a6b1a8", border: "#4a594f", accent: "#dbb66f", good: "#88baa0", error: "#e49982" };
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const rating = (reply: Reply) => `quality ${reply.verdict.quality.toFixed(1)}/3 | ready ${(reply.verdict.ready * 100).toFixed(0)}%${reply.truncated ? " | token limit reached" : ""}`;

export function mountTui(renderer: CliRenderer, config: Config) {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.bg });
  renderer.root.add(root);
  root.add(new TextRenderable(renderer, { content: " CONVENTS  /  many perspectives, one answer", fg: colors.accent, attributes: TextAttributes.BOLD, height: 1 }));
  const status = new TextRenderable(renderer, { content: "Ready. Proposals start together, then peers critique each other.", fg: colors.muted, height: 1 });
  root.add(status);
  const overview = new TextRenderable(renderer, { content: config.llms.map(llm => `${llm.name}: idle`).join("  |  "), fg: colors.good, height: 1 });
  root.add(overview);
  const prompt = new BoxRenderable(renderer, { title: " Question ", border: true, borderColor: colors.border, height: 3, flexShrink: 0 });
  const input = new InputRenderable(renderer, {
    width: "100%", placeholder: "Ask a question and press Enter...", maxLength: 12000,
    textColor: colors.text, cursorColor: colors.accent, focusedBackgroundColor: colors.panel,
  });
  prompt.add(input);
  root.add(prompt);
  const board = new ScrollBoxRenderable(renderer, {
    flexGrow: 2, flexBasis: 0, minHeight: 5, contentOptions: { flexDirection: "row", flexWrap: "wrap" },
  });
  root.add(board);
  const seats = new Map(config.llms.map(llm => {
    const box = new BoxRenderable(renderer, { title: ` ${clean(llm.name)} `, border: true, borderColor: colors.border, backgroundColor: colors.panel, flexShrink: 0 });
    const label = new TextRenderable(renderer, { content: `idle | ${clean(llm.model)}`, fg: colors.muted, height: 1, flexShrink: 0 });
    box.add(label);
    const history = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 0, stickyScroll: true, stickyStart: "bottom" });
    box.add(history);
    board.add(box);
    return [llm.name, { box, label, history, current: undefined as TextRenderable | undefined, buffer: "", state: "idle" }] as const;
  }));
  const jury = new ScrollBoxRenderable(renderer, { title: " Laya / decision log ", border: true, borderColor: colors.border, height: 4, flexShrink: 0, stickyScroll: true, stickyStart: "bottom" });
  root.add(jury);
  const final = new ScrollBoxRenderable(renderer, { title: " Final answer ", border: true, borderColor: colors.good, flexGrow: 1, flexBasis: 0, minHeight: 4, stickyScroll: true, stickyStart: "bottom" });
  const finalText = new TextRenderable(renderer, { content: "The strongest candidate will synthesize the debate here.", fg: colors.text, flexShrink: 0 });
  final.add(finalText);
  root.add(final);
  root.add(new TextRenderable(renderer, { content: " Enter ask | Tab focus panel | PgUp/PgDn scroll | Esc cancel | Ctrl+C quit", fg: colors.muted, height: 1, flexShrink: 0 }));
  const resize = () => {
    const columns = Math.min(config.llms.length, Math.max(1, Math.floor(renderer.width / 34)));
    for (const seat of seats.values()) {
      seat.box.width = `${100 / columns}%`;
      seat.box.height = Math.max(7, Math.floor((renderer.height - 15) * 0.66));
    }
  };
  resize();
  renderer.on("resize", resize);
  let active: AbortController | undefined;
  let closed = false;
  const log = (content: string, fg = colors.muted) => jury.add(new TextRenderable(renderer, { content: clean(content), fg, flexShrink: 0 }));
  const refreshOverview = () => { overview.content = [...seats].map(([name, seat]) => `${clean(name)}: ${seat.state}`).join(" | "); };
  const update = (event: DebateEvent) => {
    if (closed || active?.signal.aborted) return;
    if (event.type === "selected") {
      log(`R${event.round}: ${event.name} leads (${(event.confidence * 100).toFixed(0)}% confidence). ${event.round < 2 ? "Peer critique next." : event.ready ? "Ready to synthesize." : event.lastRound ? "Round limit: synthesizing with uncertainty." : "Debate continues."}`, colors.accent);
      return;
    }
    if (event.type === "judged") {
      const { reply } = event;
      const seat = seats.get(reply.name)!;
      seat.state = "judged";
      seat.label.content = `${reply.phase} | ${rating(reply)}`;
      log(`${reply.name} / ${reply.phase} R${reply.round}: ${rating(reply)}`, colors.good);
      refreshOverview();
      return;
    }
    const seat = seats.get(event.name)!;
    if (event.type === "start") {
      seat.state = event.phase;
      seat.buffer = "";
      status.fg = colors.muted;
      seat.label.content = `R${event.round} / ${event.phase} / streaming`;
      status.content = event.phase === "final" ? `${event.name} is synthesizing the final answer...` : `Round ${event.round}/${config.debate.max_rounds}: ${event.phase === "proposal" ? "independent proposals" : "peer critique"}`;
      if (event.phase === "final") {
        finalText.content = "";
        final.title = ` Final answer / ${clean(event.name)} / streaming `;
        seat.current = finalText;
      } else {
        seat.history.add(new TextRenderable(renderer, { content: `Round ${event.round} / ${event.phase}`, fg: colors.accent, flexShrink: 0 }));
        seat.current = new TextRenderable(renderer, { content: "", fg: colors.text, flexShrink: 0 });
        seat.history.add(seat.current);
      }
      refreshOverview();
    } else if (event.type === "delta" && seat.current) {
      seat.buffer += clean(event.text);
      seat.current.content = seat.buffer;
    }
  };
  async function submit(question: string) {
    if (!question.trim() || active || closed) return;
    const controller = new AbortController();
    active = controller;
    prompt.title = ` Question / ${clean(question).slice(0, 80)} `;
    input.value = "";
    input.placeholder = "Debating... Esc cancels. Your next question can wait here.";
    finalText.content = "Waiting for proposals and peer critique...";
    final.title = " Final answer / pending ";
    for (const seat of seats.values()) {
      for (const child of seat.history.getChildren()) child.destroyRecursively();
      seat.current = undefined;
      seat.state = "waiting";
      seat.label.content = "waiting";
    }
    for (const child of jury.getChildren()) child.destroyRecursively();
    refreshOverview();
    try {
      const reply = await runDebate(config, question, update, controller.signal);
      if (closed) return;
      const approved = !reply.truncated && reply.verdict.ready >= config.decision.readiness_threshold;
      final.title = approved ? " Final answer / Laya rated ready " : " Final answer / review advised ";
      status.content = approved ? "Done. Laya rated the answer ready, not independently verified." : "Done. Laya readiness is low or output was truncated. Review the answer.";
      status.fg = approved ? colors.good : colors.accent;
    } catch (error) {
      if (closed) return;
      const message = controller.signal.aborted ? "Cancelled. Ask another question." : `Error: ${clean(error instanceof Error ? error.message : String(error))}`;
      status.content = message;
      status.fg = colors.error;
      final.title = " Final answer / incomplete ";
      log(message, colors.error);
    } finally {
      active = undefined;
      if (!closed) {
        for (const seat of seats.values()) if (seat.state !== "judged") seat.state = "stopped";
        refreshOverview();
        input.placeholder = "Ask another question and press Enter...";
        input.focus();
      }
    }
  }
  input.on(InputRenderableEvents.ENTER, (question: string) => { void submit(question); });
  const focusTargets = [input, board, ...[...seats.values()].map(seat => seat.history), jury, final];
  renderer.keyInput.on("keypress", key => {
    if (key.name === "escape") active?.abort();
    if (key.name === "tab") {
      key.preventDefault();
      const index = focusTargets.findIndex(target => target.focused);
      focusTargets[(index + (key.shift ? -1 : 1) + focusTargets.length) % focusTargets.length]!.focus();
    }
    if ((key.name === "pageup" || key.name === "pagedown") && input.focused) final.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
  });
  renderer.on("destroy", () => {
    closed = true;
    active?.abort();
    renderer.off("resize", resize);
  });
  input.focus();
  return { submit, input };
}
