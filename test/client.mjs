import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = readFileSync(join(root, "lib/client.js"), "utf8");

let captured = null;
const document = {
  body: { dataset: {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} },
};
const window = {
  __ModuleLoader__: {
    load(record) {
      captured = record;
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => {
    fn();
    return 1;
  },
  clearTimeout: () => {},
};

const React = {
  Fragment: "Fragment",
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useCallback: (fn) => fn,
  useReducer: (reducer, initial) => [initial, () => {}],
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
};

const require = (id) => {
  if (id === "react") return React;
  throw new Error(`unexpected require: ${id}`);
};

vm.runInNewContext(bundle, {
  window,
  document,
  require,
  console,
  setTimeout,
  clearTimeout,
  Symbol,
  JSON,
  AbortController,
  HTMLTextAreaElement: function HTMLTextAreaElement() {},
});

assert.equal(captured?.id, "dsh-plugin-side-conversation");
assert.equal(typeof captured.factory, "function");

const exports = captured.factory(require);
assert.equal(typeof exports.apply, "function");
assert.deepEqual([...exports.inject], ["slots", "locale", "connection"]);

const rpcCalls = [];
const registered = [];
const localeCalls = [];
const ctx = {
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, payload });
        if (endpoint === "open") {
          return {
            ok: true,
            value: { threadId: "thread-1", provider: "fake", model: "fake-model", mainSeq: 3 },
          };
        }
        if (endpoint === "ask") {
          return {
            ok: true,
            value: {
              text: "The answer.",
              toolLog: [],
              mainSeq: 4,
              mainMessageCount: 2,
              model: "fake-model",
            },
          };
        }
        return { ok: true, value: {} };
      },
    },
  },
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register(ns, dictionaries) {
      localeCalls.push({ ns, dictionaries });
      return () => {};
    },
  },
  slots: {
    inject(name, callback) {
      assert.ok(name === "conversation.input.right" || name === "shell.overlay");
      return callback();
    },
    register(options, component) {
      registered.push({ options, component, injected: options.inject?.() ?? {} });
      return () => {};
    },
  },
};

exports.apply(ctx);

assert.equal(localeCalls.length, 1);
assert.equal(localeCalls[0].ns, "side-conversation");
assert.equal(registered.length, 2);
const buttonEntry = registered.find((entry) => entry.options.name === "conversation.input.right");
const drawerEntry = registered.find((entry) => entry.options.name === "shell.overlay");
assert.ok(buttonEntry);
assert.ok(drawerEntry);
assert.equal(buttonEntry.options.id, "side-conversation-button");
assert.equal(drawerEntry.options.id, "side-conversation-drawer");

// The main composer button is additive, enabled by text, and sends the draft
// through the injected openSide closure.
let draft = "What changed?";
const inputActions = {
  setDraft(value) {
    draft = value;
  },
};
const input = { draft, imageIds: [], occurrences: [] };
const inputButton = buttonEntry.component({
  sessionId: "main-session",
  input,
  inputActions,
  openSide: buttonEntry.injected.openSide,
  t: (key) => key,
});
assert.equal(inputButton.type, "button");
assert.equal(inputButton.props.disabled, false);
assert.equal(inputButton.props["data-side-conversation-trigger"], "");
assert.equal(inputButton.props["aria-label"], "hint");
await inputButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(draft, "");
assert.deepEqual(
  rpcCalls.map((call) => call.endpoint),
  ["open", "ask"],
);
assert.equal(rpcCalls[0].channel, "/side-conversation");
assert.equal(rpcCalls[1].payload.text, "What changed?");

// It refuses image, reference, and command drafts rather than silently
// dropping part of the main draft.
for (const blocked of [
  { draft: "text", imageIds: [{}], occurrences: [] },
  { draft: "text", imageIds: [], occurrences: [{}] },
  { draft: "/compact", imageIds: [], occurrences: [] },
]) {
  const button = buttonEntry.component({
    sessionId: "main-session",
    input: blocked,
    inputActions,
    openSide: buttonEntry.injected.openSide,
    t: (key) => key,
  });
  assert.equal(button.props.disabled, true);
}

// The drawer renders the ephemeral message history and its own send button.
const drawer = drawerEntry.component({
  useSessions: (selector) => selector({ current: "main-session" }),
  ...drawerEntry.injected,
  t: (key) => key,
});
assert.equal(drawer.type, "div");
assert.equal(drawer.props.className, "dshSideOverlay");
const aside = drawer.children[0];
assert.equal(aside.props.id, "dsh-side-conversation-panel");
assert.equal(aside.props.role, "complementary");
const header = aside.children[0];
assert.equal(header.type, "header");
const body = aside.children[1];
assert.equal(body.props.className, "dshSideMessages");
const rows = Array.isArray(body.children[0]) ? body.children[0] : [body.children[0]];
assert.equal(rows.length, 2);
assert.equal(rows[0].props["data-role"], "user");
assert.equal(rows[0].children[1].children[0], "What changed?");
assert.equal(rows[1].props["data-role"], "assistant");
assert.equal(rows[1].children[1].children[0], "The answer.");

console.log("side-conversation client test: ok");
console.log(`  rpc endpoints: ${rpcCalls.map((call) => call.endpoint).join(", ")}`);
console.log(`  registrations: ${registered.map((entry) => entry.options.name).join(", ")}`);
