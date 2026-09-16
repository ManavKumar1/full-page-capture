/**
 * background.js
 * Service worker that drives the capture process:
 *   1. Ask the page for its true scrollable size, and detect whether the
 *      page actually scrolls in an inner container (common in SPAs like
 *      chat apps) rather than the window itself (getPageMetricsFn).
 *   2. Capture frame 0 completely untouched — fixed navbar/sidebar and all —
 *      so that chrome is never lost.
 *   3. Hide fixed/sticky elements for the *remaining* frames only, so they
 *      don't get duplicated down the page (prepareForCaptureFn).
 *   4. Walk down the page (or the detected scroll container) in step-sized
 *      increments, screenshotting each position with
 *      chrome.tabs.captureVisibleTab.
 *   5. Put the page back the way it was (restoreAfterCaptureFn).
 *   6. Store the raw slices and open results.html, which does the actual
 *      canvas stitching (service workers have no DOM/canvas of their own).
 */

const DEFAULT_SETTINGS = {
  captureDelay: 450,     // ms to wait after each scroll before shooting
  imageFormat: "png",    // 'png' | 'jpeg'
  jpegQuality: 92,
  maxCaptures: 30        // how many past captures to keep in history
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (details.reason === "install") {
    await chrome.storage.local.set({ captures_index: [] });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// chrome.tabs.captureVisibleTab is rate-limited (roughly 2 calls/sec). On
// long pages with a short frame delay we can outrun that limit, so retry
// with backoff instead of failing the whole capture.
async function captureVisibleTabWithRetry(windowId, options, attempt = 0) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, options);
  } catch (err) {
    const msg = (err && err.message) || "";
    if (attempt < 4 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(msg)) {
      await sleep(400 + attempt * 200);
      return captureVisibleTabWithRetry(windowId, options, attempt + 1);
    }
    throw err;
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// Same clamped-step algorithm used for both window scrolling and
// container scrolling: walk in viewport-sized steps, and snap the final
// step to the bottom so there's never a blank gap.
function computeScrollPositions(viewport, total) {
  const positions = [0];
  if (total > viewport) {
    let y = 0;
    while (y + viewport < total) {
      y += viewport;
      positions.push(Math.min(y, total - viewport));
    }
  }
  return positions;
}

/* ---------------------------------------------------------------------- *
 *  Functions injected into the page. Each must be fully self-contained
 *  (no closures over outer variables) because chrome.scripting serializes
 *  them and runs them in the page's isolated world.
 * ---------------------------------------------------------------------- */

function getPageMetricsFn() {
  const de = document.documentElement;
  const body = document.body || de;
  const totalHeight = Math.max(
    body.scrollHeight, de.scrollHeight,
    body.offsetHeight, de.offsetHeight,
    de.clientHeight
  );
  const totalWidth = Math.max(
    body.scrollWidth, de.scrollWidth,
    body.offsetWidth, de.offsetWidth,
    de.clientWidth
  );
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // Many modern web apps (chat apps, mail clients, dashboards) don't scroll
  // the document at all — the <html>/<body> is pinned to 100% height and an
  // inner div does the actual scrolling, while a sidebar/nav sits fixed
  // beside it. If we only ever scroll the window, we capture exactly one
  // frame and everything below the fold is silently lost. So: look for the
  // real scrolling element and, if the document itself isn't the one doing
  // the work, scroll that instead.
  const docDelta = totalHeight - viewportHeight;
  const minDelta = Math.max(120, viewportHeight * 0.15);
  let container = null;
  let containerDelta = 0;

  const candidates = document.querySelectorAll("body *");
  for (const el of candidates) {
    const delta = el.scrollHeight - el.clientHeight;
    if (delta < minDelta) continue;
    const cs = window.getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < viewportHeight * 0.4) continue; // not a major content pane
    if (rect.width < viewportWidth * 0.25) continue;   // too narrow (e.g. a nav list)
    if (delta > containerDelta) {
      containerDelta = delta;
      container = el;
    }
  }

  // Only switch to container mode if the document genuinely isn't
  // scrollable, or the inner container clearly has much more content —
  // this avoids hijacking normal pages that happen to also have some small
  // scrollable widget on them.
  const usesContainer = !!container && (docDelta < minDelta || containerDelta > docDelta * 1.5);
  window.__gfp_scroll_target__ = usesContainer ? container : null;
  const rect = usesContainer ? container.getBoundingClientRect() : null;

  return {
    totalHeight,
    totalWidth,
    viewportHeight,
    viewportWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    title: document.title,
    usesContainer,
    containerTop: rect ? rect.top : 0,
    containerClientHeight: usesContainer ? container.clientHeight : 0,
    containerScrollHeight: usesContainer ? container.scrollHeight : 0,
    containerOriginalScrollTop: usesContainer ? container.scrollTop : 0
  };
}

function prepareForCaptureFn() {
  const style = document.createElement("style");
  style.id = "__gfp_capture_style__";
  style.textContent = `
    html, body { scroll-behavior: auto !important; }
    *::-webkit-scrollbar { display: none !important; }
  `;
  document.documentElement.appendChild(style);

  const hidden = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    const cs = window.getComputedStyle(el);
    if (
      (cs.position === "fixed" || cs.position === "sticky") &&
      cs.visibility !== "hidden" &&
      cs.display !== "none"
    ) {
      hidden.push(el);
      el.dataset.__gfpPrevVisibility = el.style.visibility || "";
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
  window.__gfp_hidden_elements__ = hidden;
  return hidden.length;
}

function restoreAfterCaptureFn(scrollX, scrollY, containerScrollTop) {
  const hidden = window.__gfp_hidden_elements__ || [];
  for (const el of hidden) {
    const prev = el.dataset.__gfpPrevVisibility || "";
    if (prev) el.style.visibility = prev;
    else el.style.removeProperty("visibility");
    delete el.dataset.__gfpPrevVisibility;
  }
  window.__gfp_hidden_elements__ = null;
  const style = document.getElementById("__gfp_capture_style__");
  if (style) style.remove();

  const target = window.__gfp_scroll_target__;
  if (target && containerScrollTop != null) target.scrollTop = containerScrollTop;
  window.__gfp_scroll_target__ = null;
  window.scrollTo(scrollX, scrollY);
}

function scrollToYFn(y) {
  const target = window.__gfp_scroll_target__;
  if (target) {
    target.scrollTop = y;
    return target.scrollTop;
  }
  window.scrollTo(0, y);
  return window.scrollY;
}

/* ---------------------------------------------------------------------- */

async function addToIndex(entry) {
  const { captures_index = [] } = await chrome.storage.local.get("captures_index");
  const settings = await getSettings();
  captures_index.unshift(entry);
  const overflow = captures_index.splice(settings.maxCaptures);
  await chrome.storage.local.set({ captures_index });
  // Clean up storage for anything that fell off the end of history.
  if (overflow.length) {
    await chrome.storage.local.remove(overflow.map((c) => c.id));
  }
}

async function captureFullPage(tab) {
  const tabId = tab.id;
  const windowId = tab.windowId;
  const settings = await getSettings();
  const frameDelay = Math.max(settings.captureDelay, 500);
  const captureOpts = {
    format: settings.imageFormat,
    quality: settings.imageFormat === "jpeg" ? settings.jpegQuality : undefined
  };

  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getPageMetricsFn
  });

  const restoreArgs = [
    metrics.originalScrollX,
    metrics.originalScrollY,
    metrics.usesContainer ? metrics.containerOriginalScrollTop : null
  ];

  try {
    const viewport = metrics.usesContainer ? metrics.containerClientHeight : metrics.viewportHeight;
    const total = metrics.usesContainer ? metrics.containerScrollHeight : metrics.totalHeight;
    const positions = computeScrollPositions(viewport, total);

    // Frame 0: scroll to the very top and capture the page exactly as a
    // person sees it — fixed navbar, sidebar, everything — before we hide
    // anything. This is the only frame where that chrome is guaranteed to
    // be visible, so it's also the only frame that needs it.
    await chrome.scripting.executeScript({ target: { tabId }, func: scrollToYFn, args: [0] });
    await sleep(frameDelay);
    let dataUrl = await captureVisibleTabWithRetry(windowId, captureOpts);
    const slices = [{ dataUrl, y: positions[0] }];

    if (positions.length > 1) {
      // From here on, hide fixed/sticky chrome so it doesn't get baked
      // into every remaining frame further down the page.
      await chrome.scripting.executeScript({ target: { tabId }, func: prepareForCaptureFn });

      for (let i = 1; i < positions.length; i++) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollToYFn,
          args: [positions[i]]
        });
        await sleep(frameDelay);
        dataUrl = await captureVisibleTabWithRetry(windowId, captureOpts);
        slices.push({ dataUrl, y: positions[i] });

        chrome.runtime.sendMessage({
          type: "CAPTURE_PROGRESS",
          current: i + 1,
          total: positions.length
        }).catch(() => {});
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreAfterCaptureFn,
      args: restoreArgs
    });

    const id = "capture_" + Date.now();
    const record = {
      id,
      type: "full",
      slices,
      metrics,
      url: tab.url,
      title: metrics.title || tab.title || "Untitled page",
      createdAt: Date.now()
    };
    await chrome.storage.local.set({ [id]: record });
    await addToIndex({
      id,
      title: record.title,
      url: record.url,
      createdAt: record.createdAt,
      thumb: slices[0].dataUrl,
      type: "full"
    });

    await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") + "?id=" + id });
    return { ok: true, id };
  } catch (err) {
    // Always try to restore the page even if capture failed partway through.
    await chrome.scripting
      .executeScript({ target: { tabId }, func: restoreAfterCaptureFn, args: restoreArgs })
      .catch(() => {});
    throw err;
  }
}

async function captureVisibleArea(tab) {
  const settings = await getSettings();
  const dataUrl = await captureVisibleTabWithRetry(tab.windowId, {
    format: settings.imageFormat,
    quality: settings.imageFormat === "jpeg" ? settings.jpegQuality : undefined
  });
  const id = "capture_" + Date.now();
  const record = {
    id,
    type: "visible",
    slices: [{ dataUrl, y: 0 }],
    metrics: null,
    url: tab.url,
    title: tab.title || "Untitled page",
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [id]: record });
  await addToIndex({
    id,
    title: record.title,
    url: record.url,
    createdAt: record.createdAt,
    thumb: dataUrl,
    type: "visible"
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") + "?id=" + id });
  return { ok: true, id };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");
  if (!/^https?:|^file:/.test(tab.url || "")) {
    throw new Error("This page can't be captured. Try a regular http(s) page.");
  }
  return tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "CAPTURE_FULL_PAGE") {
        const tab = message.tab || (await getActiveTab());
        const res = await captureFullPage(tab);
        sendResponse(res);
      } else if (message.type === "CAPTURE_VISIBLE") {
        const tab = message.tab || (await getActiveTab());
        const res = await captureVisibleArea(tab);
        sendResponse(res);
      } else if (message.type === "DELETE_CAPTURE") {
        await chrome.storage.local.remove(message.id);
        const { captures_index = [] } = await chrome.storage.local.get("captures_index");
        const next = captures_index.filter((c) => c.id !== message.id);
        await chrome.storage.local.set({ captures_index: next });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
