// claude.ai: detect limits, scrape the conversation, show the manual button, trigger the handoff.
(() => {
  "use strict";
  if (window.__cgHandoffLoaded) return;
  window.__cgHandoffLoaded = true;

  /* ------------------------------ settings ------------------------------ */
  const DEFAULTS = { autoDetect: true, countdown: 5, autoSubmit: true, maxChars: 60000, showButton: true };
  let settings = { ...DEFAULTS };
  chrome.storage.sync.get(DEFAULTS).then((s) => { settings = { ...DEFAULTS, ...s }; applySettings(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) settings[k] = changes[k].newValue;
    applySettings();
  });

  /* --------------------------- selectors (tweak here) --------------------------- */
  const USER_SEL = '[data-testid="user-message"]';
  const AI_SEL = '.font-claude-response, [data-testid="assistant-message"]';
  const COMPOSER_SEL =
    'div[contenteditable="true"].ProseMirror, [data-testid="chat-input"], fieldset [contenteditable="true"], textarea';
  // Never treat text inside these as a limit banner (chat content, code, the input box).
  const IGNORE_SEL = `${USER_SEL}, ${AI_SEL}, pre, code, [contenteditable="true"], #cg-handoff-host`;

  const LIMIT_PATTERNS = [
    /you(?:'|\u2019)ve (?:hit|reached)(?: your| the)? .{0,40}limit/i,
    /(?:usage|message|rate|conversation|daily) limit (?:reached|exceeded|hit)/i,
    /limit (?:will )?resets?\b/i,
    /you(?:'|\u2019)re out of (?:free )?messages/i,
    /out of (?:free )?messages/i,
    /too many requests/i,
    /rate[- ]limit(?:ed)?\b/i,
    /free messages? until/i,
    /claude(?:\.ai)? will be back/i
  ];

  /* ------------------------------ UI (shadow DOM) ------------------------------ */
  const host = document.createElement("div");
  host.id = "cg-handoff-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      button { cursor: pointer; font: inherit; }
      button:focus-visible { outline: 2px solid #0b7a6b; outline-offset: 2px; }
      #fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
        padding: 9px 14px; border-radius: 999px; border: 1px solid #16201e;
        background: #fff; color: #16201e; font-size: 13px; font-weight: 600;
        box-shadow: 0 2px 8px rgba(0,0,0,.15);
      }
      #fab:hover { background: #16201e; color: #fff; }
      #toast {
        position: fixed; right: 18px; bottom: 66px; z-index: 2147483647;
        width: min(340px, calc(100vw - 36px)); padding: 12px 14px; border-radius: 10px;
        background: #16201e; color: #f4f6f5; font-size: 13px; line-height: 1.45;
        box-shadow: 0 6px 24px rgba(0,0,0,.3);
      }
      #toast[hidden], #fab[hidden] { display: none; }
      #actions { display: flex; gap: 8px; margin-top: 10px; }
      #actions button { padding: 6px 12px; border-radius: 6px; border: 1px solid #5d6d69; background: transparent; color: inherit; font-size: 12px; }
      #actions button.primary { background: #3fd0b8; border-color: #3fd0b8; color: #08211d; font-weight: 600; }
    </style>
    <button id="fab" type="button" title="Copy this chat to ChatGPT and continue there">Continue in ChatGPT</button>
    <div id="toast" role="status" aria-live="polite" hidden><div id="msg"></div><div id="actions"></div></div>`;
  (document.documentElement || document.body).appendChild(host);

  const fab = root.getElementById("fab");
  const toast = root.getElementById("toast");
  const toastMsg = root.getElementById("msg");
  const toastActions = root.getElementById("actions");
  let hideTimer = null;

  function showToast(text, actions = [], autoHideMs = 0) {
    clearTimeout(hideTimer);
    toastMsg.textContent = text;
    toastActions.replaceChildren(
      ...actions.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        if (a.primary) b.className = "primary";
        b.addEventListener("click", a.onClick);
        return b;
      })
    );
    toast.hidden = false;
    if (autoHideMs) hideTimer = setTimeout(hideToast, autoHideMs);
  }
  function hideToast() { toast.hidden = true; clearTimeout(hideTimer); }
  function applySettings() { fab.hidden = !settings.showButton; }
  applySettings();

  fab.addEventListener("click", () => doHandoff("manual"));

  /* ------------------------------ scraping ------------------------------ */
  const SKIP_TAGS = new Set(["SVG", "BUTTON", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

  function toMarkdown(el) {
    const walk = (n) => {
      if (n.nodeType === 3) {
        const ws = n.parentElement ? getComputedStyle(n.parentElement).whiteSpace : "normal";
        return ws.startsWith("pre") ? n.nodeValue : n.nodeValue.replace(/\s+/g, " ");
      }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName.toUpperCase())) return "";
      const kids = () => Array.from(n.childNodes).map(walk).join("");
      const tag = n.tagName.toUpperCase();
      switch (tag) {
        case "PRE": {
          const code = n.querySelector("code");
          const lang = ((code && code.className.match(/language-([\w+#-]+)/)) || [])[1] || "";
          return `\n\`\`\`${lang}\n${(code || n).textContent.replace(/\n$/, "")}\n\`\`\`\n`;
        }
        case "CODE": return "`" + n.textContent + "`";
        case "STRONG": case "B": return "**" + kids() + "**";
        case "EM": case "I": return "*" + kids() + "*";
        case "BR": return "\n";
        case "P": return kids().trim() + "\n\n";
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          return "#".repeat(Number(tag[1])) + " " + kids().trim() + "\n\n";
        case "UL": case "OL": {
          let i = 0;
          const out = Array.from(n.children)
            .filter((c) => c.tagName === "LI")
            .map((li) => {
              i++;
              return (tag === "OL" ? `${i}. ` : "- ") + walk(li).trim().replace(/\n/g, "\n  ");
            })
            .join("\n");
          return "\n" + out + "\n\n";
        }
        case "LI": return kids();
        case "A": {
          const t = kids().trim();
          const href = n.href;
          return href && t && t !== href && !n.getAttribute("href").startsWith("#") ? `[${t}](${href})` : t;
        }
        case "TABLE": {
          const rows = Array.from(n.querySelectorAll("tr")).map(
            (tr) => "| " + Array.from(tr.children).map((c) => walk(c).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")).join(" | ") + " |"
          );
          if (rows.length > 1) rows.splice(1, 0, "|" + " --- |".repeat(rows[0].split("|").length - 2));
          return "\n" + rows.join("\n") + "\n\n";
        }
        case "DIV": case "SECTION": case "BLOCKQUOTE": {
          const s = kids();
          const prefix = tag === "BLOCKQUOTE" ? s.trim().replace(/^/gm, "> ") : s;
          return prefix && !prefix.endsWith("\n") ? prefix + "\n" : prefix;
        }
        default: return kids();
      }
    };
    return walk(el).replace(/\n{3,}/g, "\n\n").trim();
  }

  const normalize = (s) => s.replace(/\s+/g, " ").trim();

  function getComposerText() {
    const c = document.querySelector(COMPOSER_SEL);
    return c ? (c.innerText ?? c.value ?? "").trim() : "";
  }

  function scrape() {
    const matched = Array.from(document.querySelectorAll(`${USER_SEL}, ${AI_SEL}`));
    const top = matched.filter((el) => !matched.some((o) => o !== el && o.contains(el)));
    const msgs = top
      .map((el) => ({ role: el.matches(USER_SEL) ? "user" : "assistant", text: toMarkdown(el) }))
      .filter((m) => m.text);

    // Pending prompt = what's in the composer, or the last user message that never got a reply.
    const draft = getComposerText();
    const last = msgs[msgs.length - 1];
    const unanswered = last && last.role === "user" ? last : null;
    let pending = "";
    if (draft && (!unanswered || normalize(unanswered.text) !== normalize(draft))) {
      pending = draft;
    } else if (unanswered) {
      pending = unanswered.text;
      msgs.pop();
    }

    const preamble =
      "I hit a usage limit on Claude (Anthropic) in the middle of a conversation and I'm continuing it here. " +
      "Below is the conversation so far, followed by my pending message. Treat the transcript as prior context " +
      "(the \"Claude\" turns were written by Claude, not by you), keep code and decisions consistent with it, " +
      "and then respond to my pending message.";

    const budget = Math.max(2000, settings.maxChars - pending.length - preamble.length - 300);
    const blocks = msgs.map((m) => `[${m.role === "user" ? "User" : "Claude"}]\n${m.text}`);
    const kept = [];
    let used = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (used + blocks[i].length > budget) {
        if (!kept.length) kept.unshift("\u2026" + blocks[i].slice(-budget));
        break;
      }
      kept.unshift(blocks[i]);
      used += blocks[i].length;
    }
    const truncated = kept.length < blocks.length;
    const history =
      (truncated ? "[Earlier messages omitted for length]\n\n" : "") + kept.join("\n\n---\n\n");

    const text = [
      preamble,
      "",
      "<conversation_history>",
      history || "(no earlier messages found)",
      "</conversation_history>",
      "",
      "<pending_message>",
      pending || "(none \u2014 briefly summarize where we left off and suggest the next step)",
      "</pending_message>"
    ].join("\n");

    return { text, count: kept.length, truncated, hasContent: kept.length > 0 || !!pending };
  }

  /* ------------------------------ handoff ------------------------------ */
  let cooldownUntil = 0;
  let countdownTimer = null;

  function stopCountdown() { clearInterval(countdownTimer); countdownTimer = null; }

  async function doHandoff(origin) {
    stopCountdown();
    const data = scrape();
    if (!data.hasContent) {
      showToast("No conversation found on this page. Open a chat and try again.", [{ label: "Dismiss", onClick: hideToast }], 6000);
      return;
    }
    cooldownUntil = Date.now() + 30000;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "HANDOFF",
        payload: {
          text: data.text,
          count: data.count,
          truncated: data.truncated,
          autoSubmit: settings.autoSubmit,
          sourceUrl: location.href,
          origin
        }
      });
      if (!res || !res.ok) throw new Error((res && res.error) || "No response from extension");
      showToast(
        `Opened ChatGPT with ${data.count} message${data.count === 1 ? "" : "s"}${data.truncated ? " (older ones trimmed)" : ""}.`,
        [],
        5000
      );
    } catch (err) {
      showToast("Could not open ChatGPT: " + err.message, [{ label: "Dismiss", onClick: hideToast }]);
    }
  }

  function onLimitDetected() {
    if (!settings.autoDetect || countdownTimer || Date.now() < cooldownUntil) return;
    let left = Number(settings.countdown) || 0;
    if (left <= 0) return doHandoff("auto");
    const cancel = () => { stopCountdown(); cooldownUntil = Date.now() + 60000; hideToast(); };
    const render = () =>
      showToast(`Rate limit detected. Opening ChatGPT in ${left}s\u2026`, [
        { label: "Switch now", primary: true, onClick: () => doHandoff("auto") },
        { label: "Cancel", onClick: cancel }
      ]);
    render();
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) doHandoff("auto");
      else render();
    }, 1000);
  }

  /* ------------------------------ detection ------------------------------ */
  const looksLikeLimit = (t) => t.length > 0 && t.length <= 600 && LIMIT_PATTERNS.some((r) => r.test(t));

  function inspect(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || (el.closest && el.closest(IGNORE_SEL))) return false;
    const text = (node.textContent || "").trim();
    if (looksLikeLimit(text)) return true;
    if (node.nodeType === 1 && text.length > 600 && text.length < 20000) {
      const inner = node.querySelectorAll('p, span, div, [role="alert"], [role="status"]');
      for (let i = 0; i < Math.min(inner.length, 300); i++) {
        if (inner[i].closest(IGNORE_SEL)) continue;
        if (looksLikeLimit((inner[i].textContent || "").trim())) return true;
      }
    }
    return false;
  }

  new MutationObserver((mutations) => {
    if (!settings.autoDetect) return;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (inspect(n)) return onLimitDetected();
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Signals from page_hook.js (HTTP 429 / limit events in the response stream)
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "cg-handoff" && e.data.type === "RATE_LIMIT") {
      onLimitDetected();
    }
  });

  // Popup "Switch now" button
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "MANUAL_HANDOFF") {
      doHandoff("manual");
      sendResponse({ ok: true });
    }
  });
})();
