import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const root = await mkdtemp(join(tmpdir(), "dsh-side-conversation-"));
await mkdir(join(root, "src"), { recursive: true });
await writeFile(join(root, "src", "example.txt"), "line one\nline two\nline three\n", "utf8");

const mainMessages = [
  {
    id: "main-user-1",
    role: "user",
    content: [{ type: "text", text: "Please inspect the example file." }],
    source: { kind: "user" },
  },
  {
    id: "main-assistant-1",
    role: "assistant",
    content: [{ type: "text", text: "I will read it." }],
    source: { kind: "model", provider: "fake", model: "fake-model" },
  },
];

const events = [
  { type: "user/message", seq: 1, data: mainMessages[0] },
  { type: "assistant/message", seq: 2, data: { message: mainMessages[1] } },
];
const session = {
  id: "main-session",
  seq: 7,
  header: { cwd: root },
  events: events,
  log: events,
  deriveMessages: () => mainMessages,
  append: () => {
    throw new Error("the side conversation must never append to the main session");
  },
};

const agent = { options: { provider: "fake", model: "fake-model" } };
const modelCalls = [];

function streamFor(callIndex) {
  const chunks = [];
  if (callIndex === 0) {
    chunks.push({ type: "block-start", index: 0, blockType: "text" });
    chunks.push({ type: "text-delta", index: 0, text: "I will read the file." });
    chunks.push({ type: "block-end", index: 0, block: { type: "text", text: "I will read the file." } });
    chunks.push({ type: "block-start", index: 1, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index: 1,
      id: "call-1",
      name: "read_file",
      argumentsDelta: '{"path":"src/example.txt","limit":2}',
    });
    chunks.push({
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: "call-1",
        name: "read_file",
        arguments: '{"path":"src/example.txt","limit":2}',
      },
    });
    chunks.push({ type: "finish", reason: { kind: "tool-calls" } });
  } else {
    chunks.push({ type: "block-start", index: 0, blockType: "text" });
    chunks.push({ type: "text-delta", index: 0, text: "The file starts with line one and line two." });
    chunks.push({
      type: "block-end",
      index: 0,
      block: { type: "text", text: "The file starts with line one and line two." },
    });
    chunks.push({ type: "finish", reason: { kind: "stop" } });
  }
  return chunks;
}

const ctx = {
  connection: {
    requestRejection: () => undefined,
  },
  webServer: {
    register(route) {
      assert.equal(route.kind, "prefix");
      assert.equal(route.path, "/side-conversation");
      ctx.route = route.handler;
      return () => {};
    },
  },
  sessions: { get: (id) => (id === session.id ? session : undefined) },
  llm: {
    stream(options) {
      modelCalls.push(options);
      return (async function* () {
        for (const chunk of streamFor(modelCalls.length - 1)) yield chunk;
      })();
    },
  },
  shell: {
    resolve: (request) => request,
    run: async () => ({ exitCode: 0, timedOut: false, aborted: false, stdout: { text: "ok" }, stderr: { text: "" } }),
  },
  get(name) {
    if (name === "agents") return { get: () => agent };
    if (name === "shell") return this.shell;
    if (name === "sessions") return this.sessions;
    if (name === "llm") return this.llm;
    if (name === "connection") return this.connection;
    if (name === "webServer") return this.webServer;
    return undefined;
  },
  on() {
    return () => {};
  },
  effect(fn) {
    fn();
    return () => {};
  },
};

apply(ctx);
assert.equal(typeof ctx.route, "function");

async function rpc(endpoint, payload) {
  const body = JSON.stringify({
    type: "client-request",
    rpcId: "rpc-test",
    method: endpoint,
    payload,
  });
  const req = (async function* () {
    yield Buffer.from(body);
  })();
  req.method = "POST";
  req.url = `/side-conversation/${endpoint}`;
  req.headers = { "content-type": "application/json" };
  req.on = () => {};
  let responseBody = "";
  const res = {
    writeHead() {},
    end(bodyText) {
      responseBody = bodyText;
    },
  };
  await ctx.route(req, res);
  const envelope = JSON.parse(responseBody);
  assert.equal(envelope.type, "server-response");
  assert.equal(envelope.rpcId, "rpc-test");
  return envelope.result;
}

const opened = await rpc("open", { sessionId: session.id });
assert.equal(opened.ok, true);
assert.equal(opened.value.provider, "fake");
assert.equal(opened.value.model, "fake-model");

const asked = await rpc("ask", { threadId: opened.value.threadId, text: "What does the file say?" });
assert.equal(asked.ok, true);
assert.match(asked.value.text, /line one and line two/);
assert.equal(asked.value.toolLog.length, 1);
assert.equal(asked.value.toolLog[0].name, "read_file");
assert.match(asked.value.toolLog[0].result, /line one/);

// The first model call must carry the transcript and the tool schema; the
// second must carry the tool result and no transcript duplication beyond the
// fixed snapshot.
assert.equal(modelCalls.length, 2);
assert.equal(modelCalls[0].tools.length, 4);
assert.match(modelCalls[0].messages[0].content[0].text, /main_conversation_snapshot/);
const toolMessage = modelCalls[1].messages.find((message) => message.source?.kind === "tool");
assert.ok(toolMessage);
assert.match(toolMessage.content[0].content[0].text, /line one/);

// A main-conversation addition after the side thread opened must arrive as a
// delta, not as a second full snapshot.
mainMessages.push({
  id: "main-user-2",
  role: "user",
  content: [{ type: "text", text: "A new main message." }],
  source: { kind: "user" },
});
events.push({ type: "user/message", seq: 3, data: mainMessages[2] });
const askedAgain = await rpc("ask", { threadId: opened.value.threadId, text: "Any update?" });
assert.equal(askedAgain.ok, true);
const secondAskMessages = modelCalls[2].messages;
assert.equal(
  secondAskMessages.filter((message) => String(message.content?.[0]?.text ?? "").includes("main_conversation_snapshot")).length,
  1,
);
const update = secondAskMessages.find((message) => String(message.content?.[0]?.text ?? "").includes("main_conversation_update"));
assert.ok(update);
assert.match(update.content[0].text, /A new main message/);

// Closing drops the thread and a second ask is refused.
const closed = await rpc("close", { threadId: opened.value.threadId });
assert.equal(closed.ok, true);
const afterClose = await rpc("ask", { threadId: opened.value.threadId, text: "again" });
assert.equal(afterClose.ok, false);
assert.equal(afterClose.error.code, "thread-not-found");

console.log("side-conversation host test: ok");
console.log(`  model calls: ${modelCalls.length}`);
console.log(`  tool log: ${asked.value.toolLog[0].name}`);
