import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { runDebate } from "./debate";

const usage = `Convents: parallel proposals, peer critique, and a Laya-rated final answer.

  bun run start                           Open the terminal UI
  bun run start --config path.toml         Use another config
  bun run start --ask "Your question"      Run without the UI
  bun test                                Run offline checks

Edit config.toml to choose providers, models, credentials, and debate limits.`;

try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { config: { type: "string", default: "config.toml" }, ask: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(usage);
  } else {
    const config = await loadConfig(values.config);
    if (values.ask !== undefined) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
      try {
        const reply = await runDebate(config, values.ask, event => {
          if (event.type === "start") console.error(`[${event.phase} R${event.round}] ${event.name}`);
          if (event.type === "judged") console.error(`[Laya] ${event.reply.name}: quality ${event.reply.verdict.quality.toFixed(1)}/3, ready ${(event.reply.verdict.ready * 100).toFixed(0)}%${event.reply.truncated ? ", truncated" : ""}`);
          if (event.type === "selected") console.error(`[Laya R${event.round}] selected ${event.name}`);
        }, controller.signal);
        console.log(reply.text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
        if (reply.truncated || reply.verdict.ready < config.decision.readiness_threshold) console.error("Review advised: final answer was truncated or Laya readiness is below threshold.");
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode requires a terminal. Use --ask "Your question" instead.');
      const { createCliRenderer } = await import("@opentui/core");
      const { mountTui } = await import("./tui");
      const renderer = await createCliRenderer({ exitOnCtrlC: true, backgroundColor: "#171b19", consoleOptions: { startInDebugMode: false } });
      try {
        mountTui(renderer, config);
      } catch (error) {
        renderer.destroy();
        throw error;
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
