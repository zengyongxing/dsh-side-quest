window.__ModuleLoader__.load({
  id: "dsh-plugin-side-conversation",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const NS = "side-conversation";
    const inject = ["slots", "locale", "connection"];
    const CHANNEL = "/side-conversation";

    const zh = {
      "title": "子对话",
      "subtitle": "基于主对话的临时只读对话",
      "hint": "发送到子对话",
      "placeholder": "输入子对话问题…",
      "send": "子对话",
      "stop": "停止",
      "close": "关闭子对话",
      "you": "你",
      "assistant": "子对话",
      "empty": "输入问题，基于主对话上下文进行只读查询。关闭后不保留。",
      "thinking": "正在思考…",
      "context": "主对话截至第 {seq} 条 · {count} 条消息",
      "tools": "工具调用（{count}）",
      "disabledNoSession": "请先选择或创建一个会话",
      "disabledEmpty": "先输入文字",
      "disabledAttachment": "子对话暂不支持图片",
      "disabledReference": "子对话暂不支持文件引用",
      "disabledCommand": "子对话不支持命令",
      "busy": "子对话正在生成",
      "error": "子对话失败：{message}",
      "model": "模型：{model}",
      "scratch": "脚本目录：{path}",
    };

    const en = {
      "title": "Side conversation",
      "subtitle": "Temporary read-only conversation over this session",
      "hint": "Send to side conversation",
      "placeholder": "Ask a side question…",
      "send": "Side",
      "stop": "Stop",
      "close": "Close side conversation",
      "you": "You",
      "assistant": "Side conversation",
      "empty": "Ask a question about the main conversation. Closed side conversations are discarded.",
      "thinking": "Thinking…",
      "context": "Main conversation through #{seq} · {count} messages",
      "tools": "Tool calls ({count})",
      "disabledNoSession": "Select or create a session first",
      "disabledEmpty": "Type some text first",
      "disabledAttachment": "Side conversation does not accept images",
      "disabledReference": "Side conversation does not accept file references",
      "disabledCommand": "Side conversation does not run commands",
      "busy": "Side conversation is generating",
      "error": "Side conversation failed: {message}",
      "model": "Model: {model}",
      "scratch": "Script directory: {path}",
    };

    const css = `
      .dshSideButton {
        box-sizing: border-box;
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #0f9f8f;
        color: #fff;
        cursor: pointer;
        flex: none;
        transition: background .15s var(--ds-ease-in-out), opacity .15s var(--ds-ease-in-out), transform .15s var(--ds-ease-in-out);
      }
      .dshSideButton:hover:not(:disabled) { background: #0b8578; }
      .dshSideButton:active:not(:disabled) { transform: scale(.96); }
      .dshSideButton:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: 2px;
      }
      .dshSideButton:disabled {
        background: var(--dsw-alias-button-ghost-active-fill);
        color: var(--dsw-alias-label-tertiary);
        cursor: default;
        opacity: .65;
      }
      .dshSideButton[data-modifier] {
        box-shadow: 0 0 0 3px color-mix(in srgb, #0f9f8f 30%, transparent);
      }
      /* The main send button is product-owned; this is the one visual affordance
         the requirement asks for while Command+Shift is held. */
      body[data-dsh-side-modifier="true"] button[aria-label="发送消息"],
      body[data-dsh-side-modifier="true"] button[aria-label="Send message"] {
        opacity: .42 !important;
      }

      .dshSideOverlay {
        position: fixed;
        inset: 0;
        z-index: 40;
        pointer-events: none;
      }
      .dshSideDrawer {
        pointer-events: auto;
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 420px;
        max-width: calc(100vw - 16px);
        display: flex;
        flex-direction: column;
        border-left: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-shadow-lv3);
        animation: dshSideIn .18s var(--ds-ease-in-out);
      }
      @keyframes dshSideIn { from { opacity: 0; transform: translateX(12px); } }
      @media (prefers-reduced-motion: reduce) {
        .dshSideDrawer { animation: none; }
        .dshSideButton { transition: none; }
      }
      .dshSideHeader {
        box-sizing: border-box;
        flex: none;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        min-height: 56px;
        padding: 10px 10px 10px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l2);
      }
      .dshSideHeaderText { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
      .dshSideTitle {
        font-size: 14px;
        font-weight: 600;
        line-height: 20px;
        color: var(--dsw-alias-label-primary);
      }
      .dshSideSubtitle, .dshSideMeta {
        font-size: 11px;
        line-height: 16px;
        color: var(--dsw-alias-label-tertiary);
      }
      .dshSideIconButton {
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        cursor: pointer;
        flex: none;
      }
      .dshSideIconButton:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
      .dshSideIconButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }

      .dshSideMessages {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px 14px 8px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scrollbar-width: thin;
      }
      .dshSideEmpty {
        margin: auto;
        max-width: 280px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        line-height: 19px;
        text-align: center;
      }
      .dshSideRow { display: flex; flex-direction: column; gap: 4px; }
      .dshSideRow[data-role="user"] { align-items: flex-end; }
      .dshSideLabel {
        font-size: 11px;
        line-height: 16px;
        color: var(--dsw-alias-label-caption);
        padding: 0 4px;
      }
      .dshSideBubble {
        max-width: 100%;
        box-sizing: border-box;
        padding: 9px 12px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .dshSideRow[data-role="assistant"] .dshSideBubble {
        background: var(--dsw-alias-interactive-bg-hover);
        border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-primary);
      }
      .dshSideRow[data-role="user"] .dshSideBubble {
        background: #0f9f8f;
        color: #fff;
        border: 1px solid #0b8578;
      }
      .dshSideTools {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        line-height: 17px;
        padding: 6px 8px;
      }
      .dshSideTools summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
      .dshSideTools pre {
        margin: 6px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: var(--dsh-font-mono, monospace);
        font-size: 11px;
        line-height: 16px;
        color: var(--dsw-alias-label-tertiary);
      }
      .dshSideError {
        margin: 0 14px 8px;
        padding: 8px 10px;
        border: 1px solid var(--dsw-alias-state-error-primary);
        border-radius: 8px;
        color: var(--dsw-alias-state-error-primary);
        background: var(--dsw-alias-interactive-bg-hover-danger, transparent);
        font-size: 12px;
        line-height: 18px;
        white-space: pre-wrap;
      }
      .dshSideBusy {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 14px 8px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
      }
      .dshSideDot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #0f9f8f;
        animation: dshSidePulse 1s ease-in-out infinite;
      }
      @keyframes dshSidePulse { 50% { opacity: .25; } }

      .dshSideComposer {
        flex: none;
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 10px 12px 12px;
        border-top: 1px solid var(--dsw-alias-border-l2);
      }
      .dshSideTextarea {
        box-sizing: border-box;
        flex: 1;
        min-width: 0;
        min-height: 40px;
        max-height: 160px;
        padding: 9px 11px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 12px;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 13px;
        line-height: 20px;
        resize: none;
      }
      .dshSideTextarea::placeholder { color: var(--dsw-alias-label-tertiary); }
      .dshSideTextarea:focus { outline: none; border-color: #0f9f8f; }
      .dshSideSend {
        box-sizing: border-box;
        width: 36px;
        height: 36px;
        padding: 0;
        border: none;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #0f9f8f;
        color: #fff;
        cursor: pointer;
        flex: none;
      }
      .dshSideSend:hover:not(:disabled) { background: #0b8578; }
      .dshSideSend:disabled { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-tertiary); cursor: default; opacity: .65; }
      .dshSideSend:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
    `;

    const styleTagId = "dsh-plugin-side-conversation/SideConversation.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-side-conversation";
      tag.dataset.pluginCss = styleTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const h = React.createElement;

    // ── shared ephemeral store ──────────────────────────────────────────────
    // One side conversation per page. Closing the drawer drops every message.
    const state = {
      open: false,
      threadId: null,
      sessionId: null,
      messages: [],
      busy: false,
      error: null,
      model: null,
      context: null,
      modifierHeld: false,
    };
    const listeners = new Set();

    function patch(update) {
      Object.assign(state, update);
      for (const listener of listeners) listener();
    }

    function useSideState() {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        listeners.add(force);
        return () => listeners.delete(force);
      }, []);
      return state;
    }

    // ── icons ───────────────────────────────────────────────────────────────
    function SideIcon({ size = 16 }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
        },
        h("path", {
          d: "M3 3.25h10v7.5H7.5L4.25 13v-2.25H3v-7.5Z",
          stroke: "currentColor",
          strokeWidth: 1.25,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M6 6.5h4M6 8.5h2.5",
          stroke: "currentColor",
          strokeWidth: 1.25,
          strokeLinecap: "round",
        }),
      );
    }

    function ArrowIcon({ size = 16 }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
        },
        h("path", {
          d: "M3.5 8h8.5M9 4.75 12.25 8 9 11.25",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    function CloseIcon({ size = 14 }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
        },
        h("path", {
          d: "M4.5 4.5l7 7M11.5 4.5l-7 7",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
        }),
      );
    }

    // ── main composer button ────────────────────────────────────────────────
    function SideButton(props) {
      const { useInput, useSessions, inputActions, openSide, t } = props;
      const liveInput = useInput === undefined ? props.input : useInput((state) => state);
      const currentSession = useSessions === undefined ? props.sessionId : useSessions((state) => state.current);
      const sessionId = props.sessionId ?? currentSession;
      const input = liveInput ?? props.input;
      const side = useSideState();
      const latest = React.useRef(null);
      const draft = input?.draft ?? "";
      const hasSession = typeof sessionId === "string" && sessionId !== "";
      const hasImages = (input?.imageIds?.length ?? 0) > 0;
      const hasReferences = (input?.occurrences?.length ?? 0) > 0;
      const isCommand = draft.trimStart().startsWith("/");
      const disabled =
        !hasSession ||
        draft.trim() === "" ||
        hasImages ||
        hasReferences ||
        isCommand ||
        side.busy;

      const reason = !hasSession
        ? t("disabledNoSession")
        : hasImages
          ? t("disabledAttachment")
        : hasReferences
          ? t("disabledReference")
          : isCommand
            ? t("disabledCommand")
            : side.busy
              ? t("busy")
              : draft.trim() === ""
                ? t("disabledEmpty")
                : t("hint");

      const submit = React.useCallback(() => {
        const current = latest.current;
        if (current === null || current.disabled) return;
        const text = current.draft;
        if (text.trim() === "") return;
        current.inputActions.setDraft("");
        current.openSide(current.sessionId, text).then((opened) => {
          if (opened) return;
          const after = latest.current;
          if (after !== null && after.draft === "") after.inputActions.setDraft(text);
        });
      }, []);

      latest.current = {
        sessionId,
        input,
        inputActions,
        disabled,
        draft,
        openSide,
        hasSession,
      };

      useSideShortcut(submit, latest);

      return h(
        "button",
        {
          type: "button",
          className: "dshSideButton",
          "data-side-conversation-trigger": "",
          "data-modifier": side.modifierHeld || undefined,
          "aria-label": t("hint"),
          "aria-disabled": disabled,
          title: `${reason}${disabled ? "" : " (⌘⇧↵)"}`,
          disabled,
          onClick: submit,
        },
        h(ArrowIcon, { size: 16 }),
      );
    }

    function useSideShortcut(submit, latest) {
      React.useEffect(() => {
        const isMainTextInput = (element) => {
          if (element === null || element === undefined) return false;
          if (typeof element.matches !== "function") return false;
          if (element.closest("#dsh-side-conversation-panel") !== null) return false;
          return element.matches('textarea, [contenteditable="true"], [role="textbox"]');
        };

        const setModifier = (value) => {
          if (state.modifierHeld === value) {
            if (typeof document !== "undefined") {
              if (value) document.body.dataset.dshSideModifier = "true";
              else delete document.body.dataset.dshSideModifier;
            }
            return;
          }
          patch({ modifierHeld: value });
          if (typeof document !== "undefined") {
            if (value) document.body.dataset.dshSideModifier = "true";
            else delete document.body.dataset.dshSideModifier;
          }
        };

        const onKeyDown = (event) => {
          const accelerated = event.metaKey || event.ctrlKey;
          if (
            accelerated &&
            event.shiftKey &&
            event.key === "Enter"
          ) {
            if (event.isComposing || event.keyCode === 229) return;
            if (!isMainTextInput(document.activeElement)) return;
            if (latest.current?.disabled) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            setModifier(false);
            submit();
            return;
          }

          if (event.key === "Meta" || event.key === "Shift" || event.key === "Control") {
            if (accelerated && event.shiftKey && isMainTextInput(document.activeElement)) {
              setModifier(true);
            }
            return;
          }

          // Any other key means the user is not simply previewing the chord.
          setModifier(false);
        };

        const onKeyUp = (event) => {
          if (event.key === "Meta" || event.key === "Shift" || event.key === "Control") {
            setModifier(false);
          }
        };

        const onBlur = () => setModifier(false);

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        return () => {
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("keyup", onKeyUp, true);
          window.removeEventListener("blur", onBlur);
          setModifier(false);
        };
      }, [submit, latest]);
    }

    // ── drawer ──────────────────────────────────────────────────────────────
    function SideDrawer({ useSessions, closeSide, sendSide, cancelSide, t }) {
      const side = useSideState();
      const current = useSessions((snapshot) => snapshot.current);
      const [text, setText] = React.useState("");
      const textareaRef = React.useRef(null);
      const listRef = React.useRef(null);

      React.useEffect(() => {
        if (
          side.open &&
          side.sessionId !== null &&
          typeof current === "string" &&
          current !== side.sessionId
        ) {
          closeSide();
        }
      }, [current, side.open, side.sessionId, closeSide]);

      React.useEffect(() => {
        if (side.open) {
          const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
          return () => window.clearTimeout(timer);
        }
        return undefined;
      }, [side.open]);

      React.useEffect(() => {
        if (listRef.current !== null) {
          listRef.current.scrollTop = listRef.current.scrollHeight;
        }
      }, [side.messages, side.busy]);

      if (!side.open) return null;

      const send = () => {
        const value = text.trim();
        if (value === "" || side.busy) return;
        setText("");
        sendSide(value);
      };

      const onComposerKeyDown = (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        send();
      };

      const onDrawerKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        closeSide();
      };

      return h(
        "div",
        { className: "dshSideOverlay" },
        h(
          "aside",
          {
            id: "dsh-side-conversation-panel",
            className: "dshSideDrawer",
            role: "complementary",
            "aria-label": t("title"),
            onKeyDown: onDrawerKeyDown,
          },
          h(
            "header",
            { className: "dshSideHeader" },
            h(
              "div",
              { className: "dshSideHeaderText" },
              h("span", { className: "dshSideTitle" }, t("title")),
              h(
                "span",
                { className: "dshSideSubtitle" },
                side.context
                  ? t("context", { seq: side.context.seq, count: side.context.count })
                  : t("subtitle"),
              ),
              side.model
                ? h("span", { className: "dshSideMeta" }, t("model", { model: side.model }))
                : null,
            ),
            h(
              "button",
              {
                type: "button",
                className: "dshSideIconButton",
                "aria-label": t("close"),
                title: t("close"),
                onClick: closeSide,
              },
              h(CloseIcon, { size: 14 }),
            ),
          ),
          h(
            "div",
            { className: "dshSideMessages", ref: listRef },
            side.messages.length === 0
              ? h("div", { className: "dshSideEmpty" }, t("empty"))
              : side.messages.map((message) =>
                  h(
                    "div",
                    {
                      key: message.id,
                      className: "dshSideRow",
                      "data-role": message.role,
                    },
                    h(
                      "span",
                      { className: "dshSideLabel" },
                      message.role === "user" ? t("you") : t("assistant"),
                    ),
                    h("div", { className: "dshSideBubble" }, message.text),
                    message.tools !== undefined && message.tools.length > 0
                      ? h(
                          "details",
                          { className: "dshSideTools" },
                          h("summary", null, t("tools", { count: message.tools.length })),
                          message.tools.map((tool, index) =>
                            h(
                              "pre",
                              { key: `${message.id}-tool-${index}` },
                              `${tool.name}(${tool.arguments})\n${tool.result}`,
                            ),
                          ),
                        )
                      : null,
                  ),
                ),
          ),
          side.error !== null
            ? h("div", { className: "dshSideError", role: "alert" }, t("error", { message: side.error }))
            : null,
          side.busy
            ? h(
                "div",
                { className: "dshSideBusy" },
                h("span", { className: "dshSideDot", "aria-hidden": "true" }),
                h("span", null, t("thinking")),
                h(
                  "button",
                  {
                    type: "button",
                    className: "dshSideIconButton",
                    onClick: cancelSide,
                    title: t("stop"),
                    "aria-label": t("stop"),
                  },
                  h("span", { "aria-hidden": "true" }, "■"),
                ),
              )
            : null,
          h(
            "footer",
            { className: "dshSideComposer" },
            h("textarea", {
              ref: textareaRef,
              className: "dshSideTextarea",
              value: text,
              placeholder: t("placeholder"),
              "aria-label": t("placeholder"),
              rows: 1,
              onChange: (event) => setText(event.target.value),
              onKeyDown: onComposerKeyDown,
            }),
            h(
              "button",
              {
                type: "button",
                className: "dshSideSend",
                disabled: text.trim() === "" || side.busy,
                title: t("hint"),
                "aria-label": t("hint"),
                onClick: send,
              },
              h(ArrowIcon, { size: 16 }),
            ),
          ),
        ),
      );
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    function apply(ctx) {
      const connection = ctx.connection;
      if (connection === undefined || connection.rpc === undefined) return;

      const rpc = async (endpoint, payload, signal) => {
        const result = await connection.rpc.call(CHANNEL, endpoint, payload, signal);
        if (result === null || result === undefined || result.ok !== true) {
          throw new Error(result?.error?.message ?? "Side conversation request failed.");
        }
        return result.value;
      };

      let activeController = null;

      const ask = async (threadId, sessionId, text) => {
        if (threadId === null || threadId === undefined) return false;
        const user = {
          id: `side-user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: "user",
          text,
          tools: [],
        };
        patch({
          messages: [...state.messages, user],
          busy: true,
          error: null,
        });
        const controller = new AbortController();
        activeController = controller;
        try {
          const result = await rpc("ask", { threadId, text }, controller.signal);
          if (state.threadId !== threadId) return false;
          patch({
            messages: [
              ...state.messages,
              {
                id: `side-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant",
                text: result.text,
                tools: Array.isArray(result.toolLog) ? result.toolLog : [],
              },
            ],
            busy: false,
            error: null,
            model: result.model ?? state.model,
            context: {
              seq: result.mainSeq,
              count: result.mainMessageCount,
            },
          });
          return true;
        } catch (error) {
          if (controller.signal.aborted) {
            if (state.threadId === threadId) patch({ busy: false });
            return false;
          }
          if (state.threadId === threadId) {
            patch({
              busy: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return false;
        } finally {
          if (activeController === controller) activeController = null;
        }
      };

      const sendSide = async (text) => {
        if (!state.open || state.threadId === null || state.busy) return false;
        return ask(state.threadId, state.sessionId, text);
      };

      const openSide = async (sessionId, text) => {
        if (typeof sessionId !== "string" || sessionId === "") {
          patch({ error: "No main session is selected." });
          return false;
        }
        const initial = text.trim();
        if (state.open && state.sessionId === sessionId && state.threadId !== null) {
          if (initial !== "") await sendSide(initial);
          return true;
        }

        if (state.open) closeSide();
        patch({
          open: true,
          threadId: null,
          sessionId,
          messages: [],
          busy: true,
          error: null,
          model: null,
          context: null,
        });

        try {
          const info = await rpc("open", { sessionId });
          patch({
            threadId: info.threadId,
            model: info.model,
            context: { seq: info.mainSeq, count: 0 },
          });
          if (initial !== "") {
            await ask(info.threadId, sessionId, initial);
          } else {
            patch({ busy: false });
          }
          return true;
        } catch (error) {
          patch({
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      };

      const cancelSide = () => {
        activeController?.abort();
        if (state.threadId !== null) {
          rpc("cancel", { threadId: state.threadId }).catch(() => {});
        }
        patch({ busy: false });
      };

      const closeSide = () => {
        const threadId = state.threadId;
        activeController?.abort();
        activeController = null;
        if (threadId !== null) {
          rpc("close", { threadId }).catch(() => {});
        }
        patch({
          open: false,
          threadId: null,
          sessionId: null,
          messages: [],
          busy: false,
          error: null,
          model: null,
          context: null,
        });
      };

      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "side-conversation: dictionaries",
      );

      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "side-conversation-button",
            order: 10,
            locale: NS,
            inject: () => ({ openSide }),
          },
          SideButton,
        ),
      );

      ctx.slots.inject("shell.overlay", () => {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "side-conversation-drawer",
            order: 60,
            locale: NS,
            inject: () => ({ closeSide, sendSide, cancelSide }),
          },
          SideDrawer,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
