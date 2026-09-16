const params = new URLSearchParams(location.search);
const captureId = params.get("id");

const stage = document.getElementById("stage");
const stateMsg = document.getElementById("stateMsg");
const stateText = document.getElementById("stateText");
const pageTitle = document.getElementById("pageTitle");
const pageDims = document.getElementById("pageDims");
const zoombar = document.getElementById("zoombar");
const zoomPct = document.getElementById("zoomPct");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const toast = document.getElementById("toast");
const toastText = document.getElementById("toastText");

const editBtn = document.getElementById("editBtn");
const editBar = document.getElementById("editBar");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");
const undoBtn = document.getElementById("undoBtn");
const clearBtn = document.getElementById("clearBtn");
const swatchesEl = document.getElementById("swatches");
const toolButtons = [...document.querySelectorAll("#editBar [data-tool]")];

const copyBtn = document.getElementById("copyBtn");
const downloadPngBtn = document.getElementById("downloadPngBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const deleteBtn = document.getElementById("deleteBtn");
const historyBtn = document.getElementById("historyBtn");
const settingsBtn = document.getElementById("settingsBtn");

let record = null;
let mainCanvas = null;
let mainCtx = null;
let overlayCanvas = null;
let overlayCtx = null;
let wrap = null;
let currentScale = 1;
let isEditing = false;

const COLORS = ["#ff5a36", "#3ddc97", "#ffd23f", "#3f8cff", "#14161c", "#ffffff"];
let currentColor = COLORS[0];
let currentTool = "pen";
let actions = [];
let drawingAction = null;
let toastTimer = null;

function showToast(text, isError = false) {
  toastText.textContent = text;
  toast.querySelector(".dot").style.background = isError ? "#ff7a5c" : "var(--signal)";
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function slug(text) {
  return (text || "capture")
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "capture";
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ---------------------------------------------------------------------- *
 *  Stitching
 * ---------------------------------------------------------------------- */

async function buildStitchedCanvas(rec) {
  // If the user already saved annotations, reuse that flattened image.
  if (rec.finalImage) {
    const img = await loadImage(rec.finalImage);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return {
      canvas,
      cssWidth: rec.metrics ? rec.metrics.totalWidth : img.naturalWidth,
      cssHeight: rec.metrics ? rec.metrics.totalHeight : img.naturalHeight
    };
  }

  if (rec.type === "visible" || rec.slices.length === 1) {
    const img = await loadImage(rec.slices[0].dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return { canvas, cssWidth: img.naturalWidth, cssHeight: img.naturalHeight };
  }

  stateText.textContent = `Stitching ${rec.slices.length} frames together…`;
  const images = await Promise.all(rec.slices.map((s) => loadImage(s.dataUrl)));
  const first = images[0];
  // captureVisibleTab always shoots the full browser viewport, so this
  // scale (device px per css px) holds true for every slice regardless of
  // whether we were scrolling the window or an inner container.
  const trueScale = first.naturalHeight / rec.metrics.viewportHeight;
  const canvasWidth = first.naturalWidth;

  if (rec.metrics.usesContainer) {
    // The page scrolls an inner container (common in chat/mail/dashboard
    // apps) rather than the document. Frame 0 is a normal full-viewport
    // shot — draw it as-is, chrome and all. Every later frame only
    // contributes the container's own on-screen band; the rest of that
    // screenshot is the same static chrome already captured in frame 0,
    // so pasting the whole thing again would just repeat it down the page.
    const cTop = Math.max(0, Math.round(rec.metrics.containerTop * trueScale));
    const cH = Math.round(rec.metrics.containerClientHeight * trueScale);
    const bottomChrome = Math.max(0, first.naturalHeight - cTop - cH);
    const contentHeight = Math.round(rec.metrics.containerScrollHeight * trueScale);
    const canvasHeight = cTop + contentHeight + bottomChrome;

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(first, 0, 0);
    for (let i = 1; i < images.length; i++) {
      const y = cTop + Math.round(rec.slices[i].y * trueScale);
      ctx.drawImage(images[i], 0, cTop, canvasWidth, cH, 0, y, canvasWidth, cH);
    }
    return {
      canvas,
      cssWidth: rec.metrics.totalWidth,
      cssHeight: Math.round(canvasHeight / trueScale)
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = Math.round(rec.metrics.totalHeight * trueScale);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < images.length; i++) {
    const y = Math.round(rec.slices[i].y * trueScale);
    ctx.drawImage(images[i], 0, y);
  }
  return { canvas, cssWidth: rec.metrics.totalWidth, cssHeight: rec.metrics.totalHeight };
}

/* ---------------------------------------------------------------------- *
 *  Zoom
 * ---------------------------------------------------------------------- */

function computeFitScale() {
  const rect = stage.getBoundingClientRect();
  const availW = rect.width - 64;
  return Math.max(0.05, Math.min(1, availW / mainCanvas.width));
}

function applyZoom(scale) {
  currentScale = Math.max(0.1, Math.min(3, scale));
  const w = Math.round(mainCanvas.width * currentScale);
  const h = Math.round(mainCanvas.height * currentScale);
  wrap.style.width = w + "px";
  wrap.style.height = h + "px";
  mainCanvas.style.width = w + "px";
  mainCanvas.style.height = h + "px";
  overlayCanvas.style.width = w + "px";
  overlayCanvas.style.height = h + "px";
  zoomPct.textContent = Math.round(currentScale * 100) + "%";
}

/* ---------------------------------------------------------------------- *
 *  Annotation
 * ---------------------------------------------------------------------- */

function lineWidthFor() {
  return Math.max(4, mainCanvas.width * 0.0025);
}
function fontSizeFor() {
  return Math.max(22, mainCanvas.width * 0.014);
}

function drawArrowHead(ctx, x0, y0, x1, y1, size) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(angle - Math.PI / 7), y1 - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x1 - size * Math.cos(angle + Math.PI / 7), y1 - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

function drawAction(ctx, action) {
  ctx.strokeStyle = action.color;
  ctx.fillStyle = action.color;
  ctx.lineWidth = lineWidthFor();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (action.tool === "pen") {
    if (action.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(action.points[0].x, action.points[0].y);
    for (const p of action.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (action.tool === "rect") {
    ctx.strokeRect(
      Math.min(action.x0, action.x1),
      Math.min(action.y0, action.y1),
      Math.abs(action.x1 - action.x0),
      Math.abs(action.y1 - action.y0)
    );
  } else if (action.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(action.x0, action.y0);
    ctx.lineTo(action.x1, action.y1);
    ctx.stroke();
    drawArrowHead(ctx, action.x0, action.y0, action.x1, action.y1, lineWidthFor() * 3.5);
  } else if (action.tool === "text") {
    ctx.font = `700 ${fontSizeFor()}px Inter, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(action.text, action.x, action.y);
  }
}

function redrawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  for (const a of actions) drawAction(overlayCtx, a);
  if (drawingAction) drawAction(overlayCtx, drawingAction);
}

function canvasPointFromEvent(evt) {
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
}

function setTool(tool) {
  currentTool = tool;
  for (const b of toolButtons) b.classList.toggle("is-active", b.dataset.tool === tool);
}

function buildSwatches() {
  swatchesEl.innerHTML = "";
  for (const c of COLORS) {
    const el = document.createElement("button");
    el.className = "swatch" + (c === currentColor ? " is-active" : "");
    el.style.background = c;
    el.title = c;
    el.addEventListener("click", () => {
      currentColor = c;
      [...swatchesEl.children].forEach((s) => s.classList.remove("is-active"));
      el.classList.add("is-active");
    });
    swatchesEl.appendChild(el);
  }
}

function enterEditMode() {
  isEditing = true;
  editBar.classList.add("is-visible");
  overlayCanvas.style.pointerEvents = "auto";
}

function exitEditMode() {
  isEditing = false;
  editBar.classList.remove("is-visible");
  overlayCanvas.style.pointerEvents = "none";
  actions = [];
  drawingAction = null;
  redrawOverlay();
}

function attachOverlayEvents() {
  let isDown = false;

  overlayCanvas.addEventListener("mousedown", (evt) => {
    if (!isEditing) return;
    const pt = canvasPointFromEvent(evt);
    isDown = true;

    if (currentTool === "pen") {
      drawingAction = { tool: "pen", color: currentColor, points: [pt] };
    } else if (currentTool === "rect" || currentTool === "arrow") {
      drawingAction = { tool: currentTool, color: currentColor, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    } else if (currentTool === "text") {
      const text = window.prompt("Annotation text:");
      if (text && text.trim()) {
        actions.push({ tool: "text", color: currentColor, x: pt.x, y: pt.y, text: text.trim() });
        redrawOverlay();
      }
      isDown = false;
    }
  });

  overlayCanvas.addEventListener("mousemove", (evt) => {
    if (!isEditing || !isDown || !drawingAction) return;
    const pt = canvasPointFromEvent(evt);
    if (drawingAction.tool === "pen") {
      drawingAction.points.push(pt);
    } else {
      drawingAction.x1 = pt.x;
      drawingAction.y1 = pt.y;
    }
    redrawOverlay();
  });

  window.addEventListener("mouseup", () => {
    if (!isEditing || !isDown) return;
    isDown = false;
    if (drawingAction) {
      actions.push(drawingAction);
      drawingAction = null;
      redrawOverlay();
    }
  });
}

/* ---------------------------------------------------------------------- *
 *  Export
 * ---------------------------------------------------------------------- */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadPng() {
  mainCanvas.toBlob((blob) => {
    downloadBlob(blob, `${slug(record.title)}.png`);
    showToast("PNG downloaded");
  }, "image/png");
}

async function downloadPdf() {
  showToast("Building PDF…");
  const { jsPDF } = window.jspdf;
  const PAGE_W = 612;
  const PAGE_H = 792;
  const pxPerPt = mainCanvas.width / PAGE_W;
  const pageContentPx = PAGE_H * pxPerPt;
  const totalPages = Math.max(1, Math.ceil(mainCanvas.height / pageContentPx));

  const pdf = new jsPDF({ unit: "pt", format: [PAGE_W, PAGE_H] });
  const tmp = document.createElement("canvas");
  tmp.width = mainCanvas.width;
  const tctx = tmp.getContext("2d");

  for (let i = 0; i < totalPages; i++) {
    const sy = i * pageContentPx;
    const sh = Math.min(pageContentPx, mainCanvas.height - sy);
    tmp.height = sh;
    tctx.clearRect(0, 0, tmp.width, tmp.height);
    tctx.fillStyle = "#ffffff";
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(mainCanvas, 0, sy, mainCanvas.width, sh, 0, 0, mainCanvas.width, sh);
    const imgData = tmp.toDataURL("image/jpeg", 0.92);
    const renderHeightPt = sh / pxPerPt;
    if (i > 0) pdf.addPage([PAGE_W, PAGE_H]);
    pdf.addImage(imgData, "JPEG", 0, 0, PAGE_W, renderHeightPt);
  }
  pdf.save(`${slug(record.title)}.pdf`);
  showToast(`PDF downloaded — ${totalPages} page${totalPages > 1 ? "s" : ""}`);
}

async function copyImage() {
  mainCanvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showToast("Copied to clipboard");
    } catch (err) {
      showToast("Couldn't copy — try downloading instead", true);
    }
  }, "image/png");
}

/* ---------------------------------------------------------------------- *
 *  Boot
 * ---------------------------------------------------------------------- */

async function main() {
  if (!captureId) {
    stateText.textContent = "No capture specified.";
    return;
  }

  const data = await chrome.storage.local.get(captureId);
  record = data[captureId];
  if (!record) {
    stateText.textContent = "This capture no longer exists.";
    return;
  }

  pageTitle.textContent = record.title || "Untitled page";
  document.title = record.title ? `${record.title} — Full Page Capture` : "Full Page Capture";

  const { canvas, cssWidth, cssHeight } = await buildStitchedCanvas(record);
  mainCanvas = canvas;
  mainCtx = mainCanvas.getContext("2d");

  overlayCanvas = document.createElement("canvas");
  overlayCanvas.id = "overlayCanvas";
  overlayCanvas.width = mainCanvas.width;
  overlayCanvas.height = mainCanvas.height;
  overlayCanvas.style.pointerEvents = "none";
  overlayCtx = overlayCanvas.getContext("2d");

  wrap = document.createElement("div");
  wrap.className = "canvas-wrap";
  wrap.appendChild(mainCanvas);
  wrap.appendChild(overlayCanvas);

  stage.innerHTML = "";
  stage.appendChild(wrap);

  pageDims.textContent = `${Math.round(cssWidth)} × ${Math.round(cssHeight)} px  ·  ${record.slices.length} frame${record.slices.length > 1 ? "s" : ""}`;

  applyZoom(computeFitScale());
  zoombar.style.display = "flex";

  attachOverlayEvents();
  buildSwatches();
}

/* ---------------------------------------------------------------------- *
 *  Toolbar wiring
 * ---------------------------------------------------------------------- */

editBtn.addEventListener("click", () => {
  if (!mainCanvas) return;
  enterEditMode();
});
cancelEditBtn.addEventListener("click", exitEditMode);
saveEditBtn.addEventListener("click", async () => {
  mainCtx.drawImage(overlayCanvas, 0, 0);
  exitEditMode();
  record.finalImage = mainCanvas.toDataURL("image/png");
  await chrome.storage.local.set({ [captureId]: record });
  showToast("Annotations saved");
});
undoBtn.addEventListener("click", () => {
  actions.pop();
  redrawOverlay();
});
clearBtn.addEventListener("click", () => {
  actions = [];
  redrawOverlay();
});
for (const b of toolButtons) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}

copyBtn.addEventListener("click", copyImage);
downloadPngBtn.addEventListener("click", downloadPng);
downloadPdfBtn.addEventListener("click", downloadPdf);

deleteBtn.addEventListener("click", async () => {
  if (!confirm("Delete this capture? This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", id: captureId });
  location.href = "history.html";
});

historyBtn.addEventListener("click", () => (location.href = "history.html"));
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

zoomInBtn.addEventListener("click", () => applyZoom(currentScale * 1.25));
zoomOutBtn.addEventListener("click", () => applyZoom(currentScale / 1.25));
zoomPct.addEventListener("click", () => applyZoom(computeFitScale()));

window.addEventListener("resize", () => {
  if (mainCanvas && !isEditing) applyZoom(computeFitScale());
});

main().catch((err) => {
  console.error(err);
  stateText.textContent = "Something went wrong building the preview: " + err.message;
});
