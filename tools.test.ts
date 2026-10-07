import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { parseConfig } from "./config";
import { createTools, parseSearchResults, runSandbox } from "./tools";

const signal = () => new AbortController().signal;
const options = { toolCallId: "test", messages: [], abortSignal: signal(), context: {} };
async function execute(tools: ToolSet, name: string, input: unknown) {
  return tools[name]!.execute!(input as never, options);
}
const sandboxTest = process.platform === "linux" && Bun.which("bwrap") ? test : test.skip;

const configSource = `
[decision]
url = "http://localhost/v1/systemone"
model = "judge"
[[llms]]
name = "Builder"
base_url = "http://localhost/v1"
model = "test"
`;

test("tool allowlists default to none and reject unknown or duplicate tools", () => {
  expect(parseConfig(configSource).llms[0]!.tools).toEqual([]);
  expect(parseConfig(configSource + 'tools = ["edit", "read", "websearch"]\n').llms[0]!.tools).toEqual(["edit", "read", "websearch"]);
  for (const value of ['["read", "read"]', '["delete"]', '"bash"', '[123]']) {
    expect(() => parseConfig(configSource + `tools = ${value}\n`)).toThrow("tools must be");
  }
  expect(Object.keys(createTools([], process.cwd(), signal()))).toEqual([]);
  expect(Object.keys(createTools(["websearch"], process.cwd(), signal()))).toEqual(["websearch"]);
});

sandboxTest("filesystem and bash tools cannot access host paths, symlink targets, credentials, or the host network", async () => {
  const parent = await mkdtemp(join(tmpdir(), "convents-tools-"));
  const root = join(parent, "project");
  await mkdir(root);
  await Bun.write(join(root, "shared.txt"), "alpha beta");
  await Promise.all([
    runSandbox(root, ["/bin/bash", "-c", 'text=$(cat shared.txt); sleep 0.05; printf "%s" "${text/alpha/A}" > shared.txt'], signal()),
    runSandbox(root, ["/bin/bash", "-c", 'text=$(cat shared.txt); sleep 0.05; printf "%s" "${text/beta/B}" > shared.txt'], signal()),
  ]);
  expect(await Bun.file(join(root, "shared.txt")).text()).toBe("A B");
  const outside = join(parent, "private.txt");
  await Bun.write(outside, "outside secret");
  await symlink(outside, join(root, "escape"));
  await symlink(parent, join(root, "escape-directory"));
  await symlink("/usr", join(root, "runtime-link"));
  const tools = createTools(["read", "write", "edit", "bash"], root, signal());
  await expect(execute(tools, "write", { path: "nested/note.txt", content: "hello café" })).resolves.toContain("Written");
  expect(await execute(tools, "read", { path: "nested/note.txt" })).toBe("hello café");
  await expect(execute(tools, "edit", { path: "nested/note.txt", old_text: "café", new_text: "$& tea" })).resolves.toContain("Edited");
  expect(await execute(tools, "read", { path: "nested/note.txt" })).toBe("hello $& tea");
  await expect(execute(tools, "edit", { path: "nested/note.txt", old_text: "missing", new_text: "no" })).rejects.toThrow("exactly once");
  await execute(tools, "write", { path: "ambiguous.txt", content: "aaa" });
  await expect(execute(tools, "edit", { path: "ambiguous.txt", old_text: "aa", new_text: "b" })).rejects.toThrow("exactly once");
  expect(await execute(tools, "read", { path: "ambiguous.txt" })).toBe("aaa");
  expect(await execute(tools, "read", { path: "." })).toContain("nested");
  for (const path of ["../private.txt", outside, "escape", "escape-directory/private.txt", "runtime-link/bin/bash"]) {
    await expect(execute(tools, "read", { path })).rejects.toThrow();
    await expect(execute(tools, "write", { path, content: "not allowed" })).rejects.toThrow();
    await expect(execute(tools, "edit", { path, old_text: "secret", new_text: "not allowed" })).rejects.toThrow();
  }
  expect(await Bun.file(outside).text()).toBe("outside secret");
  const probe = await runSandbox(root, ["/bin/bash", "-c", `test ! -e ${JSON.stringify(outside)} && test ! -e /etc/passwd && test ! -e /home && ! touch /outside && echo confined`], signal());
  expect(probe.exit_code).toBe(0);
  expect(probe.stdout).toContain("confined");
  process.env.CONVENTS_SANDBOX_TEST_KEY = "host-secret";
  try {
    const env = await runSandbox(root, ["/bin/bash", "-c", "env; cat /proc/1/environ"], signal());
    expect(env.stdout).not.toContain("CONVENTS_SANDBOX_TEST_KEY");
    expect(env.stdout).not.toContain("host-secret");
  } finally { delete process.env.CONVENTS_SANDBOX_TEST_KEY; }
  const server = Bun.serve({ port: 0, fetch: () => new Response("host network") });
  try {
    const network = await runSandbox(root, ["/runtime/bun", "--no-env-file", "-e", `try { await fetch("http://127.0.0.1:${server.port}", {signal: AbortSignal.timeout(200)}); console.log("escaped"); } catch { console.log("network isolated"); }`], signal());
    expect(network.stdout).toContain("network isolated");
    expect(network.stdout).not.toContain("escaped");
  } finally { server.stop(true); }
  const socket = join(root, "host.sock");
  const unix = Bun.listen({ unix: socket, socket: { data() {}, open(socket) { socket.write("host service"); } } });
  try {
    const blocked = await runSandbox(root, ["/runtime/bun", "--no-env-file", "-e", 'try { await Bun.connect({ unix: "/workspace/host.sock", socket: { data() {}, open() {} } }); console.log("escaped"); } catch { console.log("socket isolated"); }'], signal());
    expect(blocked.stdout).toContain("socket isolated");
    expect(blocked.stdout).not.toContain("escaped");
  } finally { unix.stop(true); }
});

sandboxTest("sandbox timeouts, cancellation, and output limits stop commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "convents-limits-"));
  await expect(runSandbox(root, ["/bin/bash", "-c", "sleep 10"], signal(), 50)).rejects.toThrow();
  await expect(runSandbox(root, ["/bin/bash", "-c", "yes"], signal())).rejects.toThrow("output exceeds");
  const controller = new AbortController();
  const outcome = runSandbox(root, ["/bin/bash", "-c", "sleep 10"], controller.signal).then(value => value, error => error);
  controller.abort();
  expect(await outcome).toBeInstanceOf(Error);
});

test("filesystem tools fail closed when bubblewrap is unavailable", async () => {
  const which = spyOn(Bun, "which").mockReturnValue(null);
  try {
    await expect(runSandbox(process.cwd(), ["/bin/true"], signal())).rejects.toThrow("No unsandboxed fallback");
  } finally { which.mockRestore(); }
});

test("DuckDuckGo parsing decodes snippets, unwraps links, and rejects CAPTCHA responses", async () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F&amp;rut=abc">Bun &amp; TypeScript</a><a class="result__snippet">Read <b>docs</b> &#x26; examples.</a></div>
  <div class="result"><a class="result__a" href="javascript:alert(1)">Bad link</a></div>`;
  expect(await parseSearchResults(html)).toEqual([{ title: "Bun & TypeScript", url: "https://bun.sh/", snippet: "Read docs & examples." }]);
  await expect(parseSearchResults('<form id="challenge-form"></form>')).rejects.toThrow("CAPTCHA");
});

test("websearch only requests the fixed DDG endpoint and returns bounded results", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    Array.from({ length: 8 }, (_, i) => `<div class="result"><a class="result__a" href="https://example.com/${i}">Result ${i}</a><a class="result__snippet">Snippet</a></div>`).join(""),
  ));
  try {
    const tools = createTools(["websearch"], process.cwd(), signal());
    const result = await execute(tools, "websearch", { query: "bun & typescript" });
    expect(result).toHaveLength(5);
    expect(request.mock.calls[0]![0]).toBe("https://html.duckduckgo.com/html/?q=bun%20%26%20typescript");
    expect(request.mock.calls[0]![1]!.redirect).toBe("error");
  } finally { request.mockRestore(); }
});
