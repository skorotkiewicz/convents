# Convents

A Bun terminal app where configured LLMs propose solutions concurrently, critique each other's answers, and let Laya select a candidate to synthesize a final response.

```sh
bun install
bun run start
bun run start --ask "How should I back up a small SQLite database?"
bun run start --config config.toml
bun test
bun run typecheck
```

## Configuration

`config.toml` includes three runnable seats at `http://192.168.0.124:8888/v1` and the Laya decision endpoint at `http://192.168.0.124:8889/v1/systemone`. The demo uses the **same local model with different roles**, not three independent models. Replace each seat's `base_url` and `model` to use different providers or models. Check model IDs with `GET /v1/models` on your servers.

```toml
[[llms]]
name = "Engineer"
base_url = "https://your-provider.example/v1"
model = "your-model-id"
api_key_env = "ENGINEER_API_KEY"
role = "Check feasibility and propose a practical implementation."
```

Store credentials in environment variables or `.env`, which Bun loads automatically. `api_key_env` is optional for both LLM seats and `[decision]`; if configured, its environment variable must exist. Never put credentials in committed TOML.

`extra_body` optionally adds provider-specific request fields. The included llama.cpp demo uses `chat_template_kwargs.enable_thinking = false` to avoid spending its output budget on hidden reasoning. Remove that field for providers that do not support it. The UI displays public proposals and critiques, not private reasoning traces.

`decision.url` is the **exact POST endpoint**. Convents uses the typed `score`, `noul`, and `choice` requests from `example.md`, not a chat completion request. It validates Laya's response types and numeric ranges.

## Flow and controls

1. All seats start independent proposals together. Each completed response goes to Laya for quality (0 to 3) and readiness (0 to 1) ratings.
2. Laya chooses the strongest candidate. Every seat receives the previous round's responses and ratings and critiques them concurrently.
3. After at least one peer-critique round, the chosen candidate's readiness can end the debate early. `max_rounds` (2 to 8) always bounds it. At the limit, synthesis proceeds even if readiness is low.
4. The selected model synthesizes the final answer, which also goes to Laya. Low readiness or token truncation is visibly flagged. Ratings are model estimates, not proof of correctness or guaranteed consensus.

Enter submits a question. Tab or Shift+Tab focuses panels for keyboard scrolling. Page Up/Down scroll the focused panel, or the final answer while the input is focused. Mouse scrolling and text selection work in panels. Escape cancels active requests; Ctrl+C exits and restores the terminal. A new question starts a fresh debate; previous questions are not conversation memory.

Each generation and decision request has a configurable `timeout_ms`. An LLM or Laya failure stops the run and cancels outstanding requests, rather than silently omitting a participant or inventing a judgment. One seat is supported, though peer debate needs at least two. Only the previous round is shared, so very long debates or large outputs may require smaller budgets or a future rolling summary.

Tests use local mock HTTP servers and OpenTUI's in-memory renderer. They do not require access to the demo servers.
