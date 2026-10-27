const DEFAULTS = { autoDetect: true, countdown: 5, autoSubmit: true, maxChars: 60000, showButton: true };
const $ = (id) => document.getElementById(id);
const status = $("status");

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (typeof DEFAULTS[key] === "boolean") el.checked = s[key];
    else el.value = s[key];
    el.addEventListener("change", () => {
      const value = typeof DEFAULTS[key] === "boolean" ? el.checked : Math.max(Number(el.min) || 0, Number(el.value) || DEFAULTS[key]);
      if (typeof value === "number") el.value = value;
      chrome.storage.sync.set({ [key]: value });
    });
  }
  const { lastHandoff } = await chrome.storage.local.get("lastHandoff");
  if (lastHandoff) {
    const when = new Date(lastHandoff.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    status.textContent = `Last handoff at ${when}: ${lastHandoff.messages ?? 0} messages, ${lastHandoff.status}.`;
  }
}

$("switch").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/claude\.ai\//.test(tab.url || "")) {
    status.textContent = "Open a Claude chat in this tab first.";
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_HANDOFF" });
    window.close();
  } catch (_) {
    status.textContent = "Reload the Claude tab once, then try again.";
  }
});

init();
