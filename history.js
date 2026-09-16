const grid = document.getElementById("grid");
const emptyState = document.getElementById("emptyState");
const countEl = document.getElementById("count");
const searchEl = document.getElementById("search");

let allCaptures = [];

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url || ""; }
}

function render(list) {
  grid.innerHTML = "";
  countEl.textContent = list.length ? `${list.length} saved` : "";
  emptyState.style.display = list.length ? "none" : "block";

  for (const cap of list) {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `
      <div class="film-frame">
        <span class="sprockets">${"<span></span>".repeat(7)}</span>
        <span class="frame-window"><img src="${cap.thumb}" alt="" loading="lazy" /></span>
        <span class="sprockets">${"<span></span>".repeat(7)}</span>
      </div>
      <div class="card-info">
        <button class="card-delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="ct">${escapeHtml(cap.title || "Untitled page")}</div>
        <div class="cd">
          <span class="badge">${cap.type === "full" ? "Full page" : "Visible"}</span>
          <span>${hostname(cap.url)}</span>
          <span>·</span>
          <span>${fmtDate(cap.createdAt)}</span>
        </div>
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-delete")) return;
      chrome.tabs.create({ url: chrome.runtime.getURL("results.html") + "?id=" + cap.id });
    });
    card.querySelector(".card-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this capture?")) return;
      await chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", id: cap.id });
      allCaptures = allCaptures.filter((c) => c.id !== cap.id);
      applyFilter();
    });
    grid.appendChild(card);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return render(allCaptures);
  render(
    allCaptures.filter(
      (c) => (c.title || "").toLowerCase().includes(q) || (c.url || "").toLowerCase().includes(q)
    )
  );
}

searchEl.addEventListener("input", applyFilter);

async function init() {
  const { captures_index = [] } = await chrome.storage.local.get("captures_index");
  allCaptures = captures_index;
  render(allCaptures);
}

init();
