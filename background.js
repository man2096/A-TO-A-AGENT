// Service worker: opens ChatGPT and hands the payload to the right tab.
const TTL_MS = 10 * 60 * 1000;
const key = (tabId) => `handoff:${tabId}`;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "HANDOFF": {
        const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
        await chrome.storage.session.set({ [key(tab.id)]: { ...msg.payload, createdAt: Date.now() } });
        await chrome.storage.local.set({
          lastHandoff: { ts: Date.now(), messages: msg.payload.count, status: "opened" }
        });
        sendResponse({ ok: true, tabId: tab.id });
        break;
      }
      case "GET_HANDOFF": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) return sendResponse(null);
        const stored = await chrome.storage.session.get(key(tabId));
        const payload = stored[key(tabId)];
        sendResponse(payload && Date.now() - payload.createdAt < TTL_MS ? payload : null);
        break;
      }
      case "HANDOFF_DONE": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId != null) await chrome.storage.session.remove(key(tabId));
        const { lastHandoff } = await chrome.storage.local.get("lastHandoff");
        await chrome.storage.local.set({ lastHandoff: { ...(lastHandoff || {}), status: msg.status } });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse(null);
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));
