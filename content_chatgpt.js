// chatgpt.com: claim the payload for this tab, paste it into the composer, and submit.
(async () => {
  "use strict";
  if (window.__cgChatgptLoaded) return;
  window.__cgChatgptLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 20000, step = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // The background worker may still be saving the payload when this script starts; retry briefly.
  async function getHandoff() {
    for (let i = 0; i < 6; i++) {
      try {
        const p = await chrome.runtime.sendMessage({ type: "GET_HANDOFF" });
        if (p && p.text) return p;
      } catch (_) {}
      await sleep(400);
    }
    return null;
  }

  const handoff = await getHandoff();
  if (!handoff) return; // normal ChatGPT tab, nothing to do

  /* ------------------------------ tiny toast ------------------------------ */
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      #t { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: min(340px, calc(100vw - 36px));
        padding: 12px 14px; border-radius: 10px; background: #16201e; color: #f4f6f5; font: 13px/1.45 system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.3); }
      #a { display: flex; gap: 8px; margin-top: 10px; }
      button { font: 12px system-ui, sans-serif; padding: 6px 12px; border-radius: 6px; border: 1px solid #3fd0b8;
        background: #3fd0b8; color: #08211d; font-weight: 600; cursor: pointer; }
      button.ghost { background: transparent; color: inherit; border-color: #5d6d69; font-weight: 400; }
    </style>
    <div id="t" role="status"><div id="m"></div><div id="a"></div></div>`;
  document.documentElement.appendChild(host);
  const msgEl = root.getElementById("m");
  const actEl = root.getElementById("a");
  function say(text, actions = []) {
    msgEl.textContent = text;
    actEl.replaceChildren(
      ...actions.map((a) => {
        const b = document.createElement("button");
        b.textContent = a.label;
        if (a.ghost) b.className = "ghost";
        b.onclick = a.onClick;
        return b;
      })
    );
  }
  const finish = (status) => chrome.runtime.sendMessage({ type: "HANDOFF_DONE", status }).catch(() => {});

  /* ------------------------------ composer helpers ------------------------------ */
  const findComposer = () =>
    document.querySelector("#prompt-textarea") ||
    document.querySelector('div.ProseMirror[contenteditable="true"]') ||
    document.querySelector("textarea");

  const composerText = (el) => (el.tagName === "TEXTAREA" ? el.value : el.innerText || "").trim();

  // ChatGPT may turn very long pastes into an attachment chip instead of inline text.
  const attachmentPresent = (el) => {
    const scope = el.closest("form") || document;
    return !!scope.querySelector(
      '[data-testid*="attachment" i], [data-testid*="file" i], [aria-label*="Remove file" i], [aria-label*="Remove attachment" i]'
    );
  };

  async function insertText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // ProseMirror: a synthetic paste is fast and keeps newlines intact
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(600);
    if (composerText(el).length < Math.min(text.length, 20) && !attachmentPresent(el)) {
      el.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
      await sleep(400);
    }
  }

  async function clickSend(el) {
    const scope = el.closest("form") || document;
    const btn = await waitFor(() => {
      const b = scope.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label^="Send" i]');
      return b && !b.disabled ? b : null;
    }, 30000);
    if (btn) { btn.click(); return true; }
    el.focus();
    ["keydown", "keypress", "keyup"].forEach((type) =>
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }))
    );
    return false;
  }

  /* ------------------------------ run ------------------------------ */
  say(`Loading your Claude conversation (${handoff.count} messages)\u2026`);

  const composer = await waitFor(findComposer, 25000);
  const copyAction = {
    label: "Copy transcript",
    onClick: async () => {
      try { await navigator.clipboard.writeText(handoff.text); say("Copied. Paste it into ChatGPT's message box."); }
      catch (_) { say("Clipboard blocked. Click the page once, then press Copy again.", [copyAction]); }
    }
  };

  if (!composer) {
    say("Couldn't find the ChatGPT message box. Log in if needed, then paste the transcript yourself.", [copyAction]);
    return finish("failed");
  }

  await sleep(800); // let the app finish hydrating
  await insertText(composer, handoff.text);

  if (!composerText(composer) && !attachmentPresent(composer)) {
    say("Couldn't insert the text automatically.", [copyAction]);
    return finish("failed");
  }

  if (!handoff.autoSubmit) {
    say("Conversation loaded. Review it, then press Send.");
    return finish("inserted");
  }

  await sleep(900);
  say("Submitting\u2026");
  const clicked = await clickSend(composer);
  say(clicked ? "Submitted. ChatGPT is picking up where Claude left off." : "Tried to submit with Enter. Press Send if nothing happened.");
  setTimeout(() => host.remove(), 6000);
  finish("submitted");
})();
