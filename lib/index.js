/**
 * Host half of the Side Conversation plugin.
 *
 * A side conversation is deliberately not a Session. It never appends to the
 * main log, it is never persisted, and it disappears with its RPC channel
 * thread. The host keeps only an in-memory transcript per open thread.
 *
 * The browser reaches this file through a private Connection channel
 * (`/side-conversation`) rather than `/api`, so the channel inherits the same
 * Host/Origin/auth admission as the rest of the browser surface.
 */
import { exec as execCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

const CHANNEL = "/side-conversation";
const MAX_MAIN_CHARS = 80_000;
const MAX_TOOL_STEPS = 8;
const MAX_TOOL_OUTPUT_CHARS = 24_000;
const MAX_READ_LINES = 400;
const MAX_SCRIPT_BYTES = 200_000;
const execAsync = promisify(execCallback);

const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the project. Returns numbered lines. The project is read-only for this side conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root (or an absolute path inside it).",
        },
        offset: {
          type: "integer",
          description: "1-based first line to read. Default 1.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to read. Default 200, max 400.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description:
      "List one directory inside the project. The project is read-only for this side conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root. Default '.'.",
        },
      },
    },
  },
  {
    name: "write_script",
    description:
      "Create a NEW script in the side-conversation scratch directory. This is the only writable location; it never touches the project.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative path inside the scratch directory, e.g. 'check.mjs'.",
        },
        content: {
          type: "string",
          description: "Complete script text.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command. Use workdir 'project' to run tests or programs in the project, or 'scratch' to run a script created by write_script. Do not modify project source files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        workdir: {
          type: "string",
          enum: ["project", "scratch"],
          description: "Working directory: project root or the side scratch directory.",
        },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds. Default 30000, max 120000.",
        },
      },
      required: ["command"],
    },
  },
];

const SIDE_SYSTEM = [
  'You are the "side conversation" assistant for a DSH session.',
  "The first user message is a snapshot of the main conversation at side-thread start.",
  "Later <main_conversation_update> messages contain only what was added to the main conversation since the previous side turn; keep them in the order given.",
  "A <main_conversation_streaming> message is provisional and may be replaced by a completed message on a later turn.",
  "",
  "Your job is to answer side questions about the main conversation and, when useful, inspect the project.",
  "Hard rules:",
  "- Never modify the project source or any existing file. The project is read-only.",
  "- You may create new scripts only with write_script, which writes exclusively to the scratch directory.",
  "- You may run commands and tests with run_command. Prefer workdir 'project' only for read-only inspection or tests; do not run commands that edit source files.",
  "- Do not continue or advance the main task. Do not claim to have changed the main conversation.",
  "- If the transcript does not contain the answer and the tools cannot establish it, say so plainly.",
  "- Keep the final answer concise; tool use is for verification, not for producing a second main turn.",
].join("\n");

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

function ok(value) {
  return { ok: true, value };
}

function textOfContent(content) {
  const parts = [];
  for (const block of content ?? []) {
    if (block?.type === "text") {
      parts.push(block.text);
    } else if (block?.type === "image") {
      parts.push("[image omitted]");
    } else if (block?.type === "tool-call") {
      parts.push(`[tool call: ${block.name}${block.arguments ? `(${clip(block.arguments, 4000)})` : ""}]`);
    } else if (block?.type === "tool-result") {
      parts.push(`[tool result: ${clip(textOfContent(block.content), 4000)}]`);
    }
  }
  return parts.join("\n").trim();
}

function clip(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertInside(root, target) {
  const realRoot = await realpath(root).catch(() => root);
  const realTarget = await realpath(target).catch(() => target);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`Path is outside the project root: ${target}`);
  }
}

function safeScratchJoin(scratch, path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (isAbsolute(path)) throw new Error("path must be relative");
  const target = resolve(scratch, path);
  if (!isInside(scratch, target)) throw new Error("path escapes the scratch directory");
  return target;
}

function readLiveAssistantText(session) {
  const events = session.events ?? session.eventsSnapshot ?? session.log ?? [];
  const chunks = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
        chunks.push(chunk.text);
      }
      continue;
    }
    if (
      event.type === "step/start" ||
      event.type === "turn/start" ||
      event.type === "assistant/message" ||
      event.type === "step/end" ||
      event.type === "turn/end" ||
      event.type === "tool/call" ||
      event.type === "tool/result"
    ) {
      break;
    }
  }
  return chunks.reverse().join("");
}

function sessionEvents(session) {
  return session.events ?? session.eventsSnapshot ?? session.log ?? [];
}

function formatSessionMessage(message) {
  const source = message.source?.kind;
  if (message.role === "assistant") {
    const lines = [];
    const text = textOfContent(message.content);
    if (text !== "") lines.push(`Assistant:\n${text}`);
    for (const block of message.content ?? []) {
      if (block?.type === "tool-call") {
        lines.push(`[tool call: ${block.name}${block.arguments ? `(${clip(block.arguments, 2000)})` : ""}]`);
      }
    }
    return lines.join("\n");
  }
  if (source === "tool") {
    return `[tool result: ${clip(textOfContent(message.content), 2000)}]`;
  }
  const text = textOfContent(message.content);
  return text === "" ? "" : `User:\n${text}`;
}

function lastSurfaceSeq(events) {
  let last = 0;
  for (const event of events) {
    if (
      event.type === "user/message" ||
      event.type === "assistant/message" ||
      event.type === "tool/result"
    ) {
      last = event.seq;
    }
  }
  return last;
}

function capTranscript(text) {
  if (text.length <= MAX_MAIN_CHARS) return text;
  return "[Earlier main conversation was truncated for this side request]\n\n" + text.slice(text.length - MAX_MAIN_CHARS);
}

function buildSnapshot(session) {
  const messages = session.deriveMessages();
  const lines = [];
  for (const message of messages) {
    const line = formatSessionMessage(message);
    if (line !== "") lines.push(line);
  }
  return {
    transcript: capTranscript(lines.join("\n\n").trim()),
    count: messages.length,
    lastSeq: lastSurfaceSeq(sessionEvents(session)),
  };
}

function buildDelta(session, afterSeq, agent) {
  const events = sessionEvents(session);
  const lines = [];
  let lastSeq = Number.isFinite(afterSeq) ? afterSeq : 0;
  let count = 0;
  for (const event of events) {
    if (event.seq <= lastSeq) continue;
    let message;
    if (event.type === "user/message") message = event.data;
    else if (event.type === "assistant/message") message = event.data?.message;
    else if (event.type === "tool/result") message = event.data?.message;
    else continue;
    if (message === undefined) continue;
    const line = formatSessionMessage(message);
    if (line !== "") lines.push(line);
    count += 1;
    lastSeq = event.seq;
  }
  const provisional =
    agent?.status === "running" ? readLiveAssistantText(session) : "";
  return {
    transcript: capTranscript(lines.join("\n\n").trim()),
    count,
    lastSeq,
    provisional,
  };
}

function userMessage(text) {
  return {
    id: `side-user-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function assistantMessage(blocks, provider, model) {
  return {
    id: `side-assistant-${randomUUID()}`,
    role: "assistant",
    content: blocks,
    source: { kind: "model", provider, model },
  };
}

function toolResultMessage(callId, text, isError) {
  const block = {
    type: "tool-result",
    toolCallId: callId,
    content: [{ type: "text", text: clip(text, MAX_TOOL_OUTPUT_CHARS) }],
  };
  if (isError) block.isError = true;
  return {
    id: `side-tool-${randomUUID()}`,
    role: "user",
    content: [block],
    source: { kind: "tool", callId },
  };
}

function assembleStream(chunks) {
  const blocks = new Map();
  let finish;
  for (const chunk of chunks) {
    if (chunk.type === "block-start") {
      if (chunk.blockType === "tool-call") {
        blocks.set(chunk.index, {
          type: "tool-call",
          id: "",
          name: "",
          arguments: "",
        });
      } else {
        blocks.set(chunk.index, { type: chunk.blockType, text: "" });
      }
      continue;
    }
    if (chunk.type === "text-delta") {
      const entry = blocks.get(chunk.index);
      if (entry) entry.text = (entry.text ?? "") + chunk.text;
      continue;
    }
    if (chunk.type === "reasoning-delta") {
      const entry = blocks.get(chunk.index);
      if (entry) entry.text = (entry.text ?? "") + chunk.text;
      continue;
    }
    if (chunk.type === "tool-call-delta") {
      let entry = blocks.get(chunk.index);
      if (entry === undefined || entry.type !== "tool-call") {
        entry = { type: "tool-call", id: "", name: "", arguments: "" };
        blocks.set(chunk.index, entry);
      }
      if (chunk.id) entry.id = String(chunk.id);
      if (chunk.name) entry.name = chunk.name;
      entry.arguments = (entry.arguments ?? "") + (chunk.argumentsDelta ?? "");
      continue;
    }
    if (chunk.type === "block-end") {
      blocks.set(chunk.index, chunk.block);
      continue;
    }
    if (chunk.type === "finish") {
      finish = chunk;
    }
  }
  return { blocks: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block), finish };
}

async function collectModel(ctx, options) {
  const llm = ctx.get("llm");
  if (llm === undefined) throw new Error("The LLM service is not available in this deployment.");
  const chunks = [];
  for await (const chunk of llm.stream(options)) {
    chunks.push(chunk);
  }
  const { blocks, finish } = assembleStream(chunks);
  if (finish === undefined) throw new Error("The model stream ended without a finish chunk.");
  if (finish.reason?.kind === "error") {
    throw new Error(finish.reason.failure?.message ?? "Model request failed.");
  }
  if (finish.reason?.kind === "aborted") {
    throw new Error("Side conversation was stopped.");
  }
  return { blocks, finish };
}

function textOfBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function cleanBlocks(blocks) {
  return blocks.filter((block) => {
    if (block?.type === "text") return block.text !== "";
    if (block?.type === "reasoning") return block.text !== "";
    if (block?.type === "tool-call") return block.id !== "" && block.name !== "";
    return false;
  });
}

async function readProjectFile(root, args) {
  const path = String(args.path ?? "");
  if (path === "") throw new Error("path is required");
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new Error("path is outside the project root");
  await assertInside(root, target);
  const text = await readFile(target, "utf8");
  const lines = text.split("\n");
  const offset = Math.max(1, Number.isFinite(args.offset) ? Math.trunc(args.offset) : 1);
  const limit = Math.min(
    MAX_READ_LINES,
    Math.max(1, Number.isFinite(args.limit) ? Math.trunc(args.limit) : 200),
  );
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = selected.map((line, index) => `${String(offset + index).padStart(4, " ")} | ${line}`);
  const footer =
    offset - 1 + selected.length < lines.length
      ? `\n…[${lines.length - (offset - 1 + selected.length)} more lines]`
      : "";
  return numbered.join("\n") + footer;
}

async function listProjectDir(root, args) {
  const path = String(args.path ?? ".");
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new Error("path is outside the project root");
  await assertInside(root, target);
  const entries = await readdir(target, { withFileTypes: true });
  const rows = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300)
    .map((entry) => `${entry.isDirectory() ? "dir " : entry.isFile() ? "file" : "other"}  ${entry.name}${entry.isDirectory() ? "/" : ""}`);
  return rows.join("\n") || "(empty directory)";
}

async function writeScratchScript(scratch, args) {
  const path = safeScratchJoin(scratch, args.path);
  const content = String(args.content ?? "");
  if (Buffer.byteLength(content, "utf8") > MAX_SCRIPT_BYTES) {
    throw new Error(`script is too large (max ${MAX_SCRIPT_BYTES} bytes)`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return `Wrote ${path}\nRun it with workdir "scratch", for example: node ${JSON.stringify(relative(scratch, path))}`;
}

async function runCommand(thread, args, signal) {
  const command = String(args.command ?? "").trim();
  if (command === "") throw new Error("command is required");
  const workdir = args.workdir === "scratch" ? thread.scratchDir : thread.cwd;
  if (args.workdir === "scratch") await mkdir(workdir, { recursive: true });
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, Number.isFinite(args.timeoutMs) ? Math.trunc(args.timeoutMs) : 30_000),
  );
  let result;
  try {
    result = await execAsync(command, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      signal,
      windowsHide: true,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const code = error?.code ?? error?.signal ?? "failed";
    const parts = [
      `exit=${code}${error?.killed ? " killed" : ""}${error?.signal ? ` signal=${error.signal}` : ""}`,
    ];
    if (stdout) parts.push(`stdout:\n${clip(stdout, MAX_TOOL_OUTPUT_CHARS)}`);
    if (stderr) parts.push(`stderr:\n${clip(stderr, MAX_TOOL_OUTPUT_CHARS)}`);
    if (!stdout && !stderr) parts.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    return parts.join("\n");
  }
  const parts = [`exit=${result.child?.exitCode ?? 0}`];
  if (result.stdout) parts.push(`stdout:\n${clip(result.stdout, MAX_TOOL_OUTPUT_CHARS)}`);
  if (result.stderr) parts.push(`stderr:\n${clip(result.stderr, MAX_TOOL_OUTPUT_CHARS)}`);
  return parts.join("\n");
}

async function executeTool(ctx, thread, call, signal) {
  let args;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { text: `Invalid JSON arguments for ${call.name}: ${clip(call.arguments, 1000)}`, isError: true };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { text: `Arguments for ${call.name} must be a JSON object.`, isError: true };
  }
  try {
    switch (call.name) {
      case "read_file":
        return { text: await readProjectFile(thread.cwd, args), isError: false };
      case "list_dir":
        return { text: await listProjectDir(thread.cwd, args), isError: false };
      case "write_script":
        return { text: await writeScratchScript(thread.scratchDir, args), isError: false };
      case "run_command":
        return { text: await runCommand(thread, args, signal), isError: false };
      default:
        return { text: `Unknown side-conversation tool: ${call.name}`, isError: true };
    }
  } catch (error) {
    return { text: `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

async function runSideTurn(ctx, thread, agent, messages, signal) {
  const provider = agent?.options?.provider;
  const model = agent?.options?.model;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw new Error("The main conversation has no active model route yet.");
  }

  const scratch = thread.scratchDir;
  const system = `${SIDE_SYSTEM}\n\nProject root: ${thread.cwd}\nScratch directory: ${scratch}`;
  const toolLog = [];
  let finalText = "";

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const options = {
      provider,
      model,
      system,
      messages,
      tools: TOOL_SCHEMAS,
      maxTokens: 8192,
      signal,
    };
    if (agent?.options?.reasoningEffort !== undefined) {
      options.reasoningEffort = agent.options.reasoningEffort;
    }

    const { blocks, finish } = await collectModel(ctx, options);
    const clean = cleanBlocks(blocks);
    messages.push(assistantMessage(clean, provider, model));

    const calls = clean.filter((block) => block.type === "tool-call");
    if (calls.length === 0) {
      finalText = textOfBlocks(clean);
      if (finalText === "") {
        if (finish.reason?.kind === "max-tokens") {
          finalText = "(The side answer reached the output limit before producing text.)";
        } else {
          finalText = "(The side conversation returned no text.)";
        }
      }
      break;
    }

    for (const call of calls) {
      const result = await executeTool(ctx, thread, call, signal);
      toolLog.push({
        name: call.name,
        arguments: clip(call.arguments, 2000),
        result: clip(result.text, 4000),
        isError: result.isError,
      });
      messages.push(toolResultMessage(call.id, result.text, result.isError));
      // Some provider routes drop tool-result history after a hand-built
      // assistant message; keep a plain user-visible copy so the side model
      // always sees what the tool returned.
      messages.push(
        userMessage(
          `<tool_result tool="${call.name}">\n${clip(result.text, 8000)}\n</tool_result>`,
        ),
      );
    }

    if (step === MAX_TOOL_STEPS - 1) {
      finalText = "(The side conversation reached its tool-call limit without a final answer.)";
    }
  }

  return {
    text: finalText,
    messages,
    toolLog,
    provider,
    model,
  };
}

export function apply(ctx) {
  const threads = new Map();
  const closeThread = (thread) => {
    thread.controller?.abort();
    threads.delete(thread.id);
    if (typeof thread.scratchDir === "string") {
      void rm(thread.scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const closeSessionThreads = (sessionId) => {
    for (const thread of [...threads.values()]) {
      if (thread.sessionId === sessionId) closeThread(thread);
    }
  };

  ctx.on("session/disposed", (session) => {
    if (session === undefined) return;
    closeSessionThreads(session.id);
  });

  const handler = async (endpoint, payload, signal) => {
    try {
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return fail("bad-request", "payload must be an object");
      }

      if (endpoint === "open") {
        const sessionId = payload.sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          return fail("bad-request", "sessionId is required");
        }
        const sessions = ctx.get("sessions");
        if (sessions === undefined) return fail("sessions-unavailable", "The session service is not available.");
        const session = sessions.get(sessionId);
        if (session === undefined) return fail("session-not-found", "The main session is not live.");
        const agent = ctx.get("agents")?.get(sessionId);
        if (agent === undefined) return fail("agent-not-found", "The main session has no active agent.");
        if (typeof agent.options?.provider !== "string" || typeof agent.options?.model !== "string") {
          return fail("model-not-ready", "The main conversation has no active model route yet.");
        }
        closeSessionThreads(sessionId);
        const snapshot = buildSnapshot(session);
        const threadId = randomUUID();
        const cwd = session.header?.cwd ?? process.cwd();
        const thread = {
          id: threadId,
          sessionId,
          cwd,
          scratchDir: join(homedir(), ".dsh", "side-conversation", threadId),
          messages: [
            userMessage(
              `<main_conversation_snapshot at_seq="${snapshot.lastSeq}">\n${snapshot.transcript || "(the main conversation is empty)"}\n</main_conversation_snapshot>`,
            ),
          ],
          lastMainSeq: snapshot.lastSeq,
          mainMessageCount: snapshot.count,
          controller: null,
          createdAt: Date.now(),
        };
        threads.set(threadId, thread);
        return ok({
          threadId,
          provider: agent.options.provider,
          model: agent.options.model,
          cwd,
          scratchDir: thread.scratchDir,
          mainSeq: snapshot.lastSeq,
          mainMessageCount: snapshot.count,
        });
      }

      if (endpoint === "ask") {
        const threadId = payload.threadId;
        const text = payload.text;
        if (typeof threadId !== "string" || typeof text !== "string" || text.trim() === "") {
          return fail("bad-request", "threadId and a non-empty text are required");
        }
        const thread = threads.get(threadId);
        if (thread === undefined) return fail("thread-not-found", "The side conversation is closed.");
        if (thread.controller !== null) return fail("busy", "The side conversation is already generating.");
        const sessions = ctx.get("sessions");
        if (sessions === undefined) return fail("sessions-unavailable", "The session service is not available.");
        const session = sessions.get(thread.sessionId);
        if (session === undefined) {
          closeThread(thread);
          return fail("session-not-found", "The main session is no longer live.");
        }
        const agent = ctx.get("agents")?.get(thread.sessionId);
        if (agent === undefined) {
          closeThread(thread);
          return fail("agent-not-found", "The main session has no active agent.");
        }

        const controller = new AbortController();
        thread.controller = controller;
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const delta = buildDelta(session, thread.lastMainSeq, agent);
          const deltaMessages = delta.transcript === ""
            ? []
            : [
                userMessage(
                  `<main_conversation_update since_seq="${thread.lastMainSeq}">\n${delta.transcript}\n</main_conversation_update>`,
                ),
              ];
          const provisionalMessages = delta.provisional === ""
            ? []
            : [
                userMessage(
                  `<main_conversation_streaming>\n${clip(delta.provisional, 20_000)}\n</main_conversation_streaming>`,
                ),
              ];
          const history = [...thread.messages, ...deltaMessages];
          const requestMessages = [...history, ...provisionalMessages, userMessage(text.trim())];
          const result = await runSideTurn(ctx, thread, agent, requestMessages, controller.signal);
          const savedStart = history.length + provisionalMessages.length;
          thread.messages = [...history, ...result.messages.slice(savedStart)];
          thread.lastMainSeq = delta.lastSeq;
          thread.mainMessageCount += delta.count;
          return ok({
            text: result.text,
            toolLog: result.toolLog,
            mainSeq: thread.lastMainSeq,
            mainMessageCount: thread.mainMessageCount,
            provider: result.provider,
            model: result.model,
          });
        } finally {
          if (thread.controller === controller) thread.controller = null;
          signal?.removeEventListener("abort", onAbort);
        }
      }

      if (endpoint === "cancel") {
        const threadId = payload.threadId;
        if (typeof threadId !== "string") return fail("bad-request", "threadId is required");
        const thread = threads.get(threadId);
        if (thread !== undefined) thread.controller?.abort();
        return ok({ cancelled: true });
      }

      if (endpoint === "close") {
        const threadId = payload.threadId;
        if (typeof threadId !== "string") return fail("bad-request", "threadId is required");
        const thread = threads.get(threadId);
        if (thread !== undefined) closeThread(thread);
        return ok({ closed: true });
      }

      return fail("unknown-endpoint", `Unknown side-conversation endpoint: ${endpoint}`);
    } catch (error) {
      if (signal?.aborted) return fail("aborted", "The side conversation was stopped.");
      return fail(
        "side-conversation-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error("request body is too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };

  const routeHandler = async (req, res) => {
    const connection = ctx.get("connection");
    if (connection === undefined || typeof connection.requestRejection !== "function") {
      res.writeHead(503);
      res.end("side conversation requires the DSH connection service");
      return;
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      res.writeHead(rejection);
      res.end(rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    const endpoint = url.pathname.startsWith(`${CHANNEL}/`)
      ? url.pathname.slice(CHANNEL.length + 1)
      : undefined;
    if (req.method !== "POST" || endpoint === undefined) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if ((req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      res.writeHead(415);
      res.end("content type must be application/json");
      return;
    }

    let message;
    try {
      message = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end("body is not JSON");
      return;
    }
    if (message?.type !== "client-request" || typeof message.rpcId !== "string" || message.method !== endpoint) {
      res.writeHead(400);
      res.end("invalid client-request");
      return;
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());
    try {
      const result = await handler(message.method, message.payload, controller.signal);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ type: "server-response", rpcId: message.rpcId, result }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        type: "server-response",
        rpcId: message.rpcId,
        result: fail("side-conversation-failed", error instanceof Error ? error.message : String(error)),
      }));
    }
  };

  let stopped = false;
  let retry = null;
  let disposeRoute = null;
  const mount = () => {
    if (stopped) return;
    const server = ctx.get("webServer");
    if (server === undefined) {
      retry = setTimeout(mount, 50);
      return;
    }
    disposeRoute = server.register({ kind: "prefix", path: CHANNEL, handler: routeHandler });
  };
  mount();

  ctx.effect(
    () => () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      if (disposeRoute !== null) Promise.resolve(disposeRoute()).catch(() => {});
      for (const thread of [...threads.values()]) {
        thread.controller?.abort();
        if (typeof thread.scratchDir === "string") {
          void rm(thread.scratchDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      threads.clear();
    },
    "side-conversation: route and memory cleanup",
  );
}
