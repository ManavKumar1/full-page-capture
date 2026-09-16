const DEFAULTS = {
  captureDelay: 450,
  imageFormat: "png",
  jpegQuality: 92,
  maxCaptures: 30
};

const captureDelayEl = document.getElementById("captureDelay");
const jpegQualityEl = document.getElementById("jpegQuality");
const maxCapturesEl = document.getElementById("maxCaptures");
const formatToggle = document.getElementById("formatToggle");
const qualityField = document.getElementById("qualityField");
const saveBtn = document.getElementById("saveBtn");
const savedNote = document.getElementById("savedNote");

let current = { ...DEFAULTS };

function reflectFormat() {
  [...formatToggle.children].forEach((b) =>
    b.classList.toggle("is-active", b.dataset.value === current.imageFormat)
  );
  qualityField.style.display = current.imageFormat === "jpeg" ? "flex" : "none";
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  current = { ...DEFAULTS, ...(settings || {}) };
  captureDelayEl.value = current.captureDelay;
  jpegQualityEl.value = current.jpegQuality;
  maxCapturesEl.value = current.maxCaptures;
  reflectFormat();
}

formatToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  current.imageFormat = btn.dataset.value;
  reflectFormat();
});

saveBtn.addEventListener("click", async () => {
  current.captureDelay = Math.max(200, Math.min(3000, Number(captureDelayEl.value) || DEFAULTS.captureDelay));
  current.jpegQuality = Math.max(40, Math.min(100, Number(jpegQualityEl.value) || DEFAULTS.jpegQuality));
  current.maxCaptures = Math.max(5, Math.min(200, Number(maxCapturesEl.value) || DEFAULTS.maxCaptures));
  await chrome.storage.local.set({ settings: current });
  savedNote.classList.add("is-visible");
  setTimeout(() => savedNote.classList.remove("is-visible"), 1800);
});

load();
