const tabFavicon = document.getElementById("tabFavicon");
const tabTitle = document.getElementById("tabTitle");
const tabUrl = document.getElementById("tabUrl");
const captureFullBtn = document.getElementById("captureFullBtn");
const captureVisibleBtn = document.getElementById("captureVisibleBtn");
const statusRow = document.getElementById("statusRow");
const statusTxt = document.getElementById("statusTxt");
const strip = document.getElementById("strip");
const settingsBtn = document.getElementById("settingsBtn");
const viewAllLink = document.getElementById("viewAllLink");

let activeTab = null;

function setStatus(text, isError = false) {
  statusRow.classList.toggle("is-visible", !!text);
  statusRow.classList.toggle("is-error", isError);
  statusTxt.textContent = text || "";
}

function setBusy(busy) {
  captureFullBtn.disabled = busy;
  captureVisibleBtn.disabled = busy;
  captureFullBtn.classList.toggle("is-busy", busy);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  if (tab) {
    tabTitle.textContent = tab.title || "Untitled page";
    tabUrl.textContent = tab.url || "";
    if (tab.favIconUrl) tabFavicon.src = tab.favIconUrl;
  }
  await renderRecent();
}

async function renderRecent() {
  const { captures_index = [] } = await chrome.storage.local.get("captures_index");
  strip.innerHTML = "";
  if (!captures_index.length) {
    strip.innerHTML = `<p class="empty-strip">Nothing captured yet — your first shot will show up here.</p>`;
    return;
  }
  for (const cap of captures_index.slice(0, 12)) {
    const btn = document.createElement("button");
    btn.className = "film-frame";
    btn.title = cap.title || cap.url || "Capture";
    btn.innerHTML = `
      <span class="sprockets">${"<span></span>".repeat(5)}</span>
      <span class="frame-window"><img src="${cap.thumb}" alt="" /></span>
      <span class="sprockets">${"<span></span>".repeat(5)}</span>
    `;
    btn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("results.html") + "?id=" + cap.id });
    });
    strip.appendChild(btn);
  }
}

captureFullBtn.addEventListener("click", async () => {
  if (!activeTab) return;
  setBusy(true);
  setStatus("Scrolling and capturing…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_FULL_PAGE", tab: activeTab });
    if (!res || !res.ok) throw new Error((res && res.error) || "Capture failed.");
    setStatus("Done — opened in a new tab.");
    setTimeout(() => window.close(), 500);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
    setBusy(false);
  }
});

captureVisibleBtn.addEventListener("click", async () => {
  if (!activeTab) return;
  setBusy(true);
  setStatus("Capturing visible area…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE", tab: activeTab });
    if (!res || !res.ok) throw new Error((res && res.error) || "Capture failed.");
    setStatus("Done — opened in a new tab.");
    setTimeout(() => window.close(), 400);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
    setBusy(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_PROGRESS") {
    setStatus(`Capturing frame ${message.current} of ${message.total}…`);
  }
});

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
viewAllLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});

init();
