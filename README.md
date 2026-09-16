# Full Page Capture

A Chrome extension (Manifest V3) that captures an entire webpage — not just what's
visible on screen — and saves it as a PNG or a paginated PDF. Built from scratch:
no external screenshot service, no bundlers, just the Chrome extension APIs.

## How it works

1. **Measure** — a script is injected into the page to read its true scrollable
   height/width, viewport size, and device pixel ratio. It also checks whether
   the *document* actually scrolls, or whether — as with most chat/mail/dashboard
   apps (ChatGPT, Claude.ai, Gmail, etc.) — the page is a fixed-height app shell
   with an inner `overflow: auto` div doing the real scrolling. If it finds a
   clearly-dominant inner scroll container, it scrolls *that* instead of the window.
2. **Shoot frame 0 untouched** — before hiding anything, the very first frame is
   captured exactly as a person would see it: fixed navbar, sidebar, everything.
   This is the only frame where that chrome is guaranteed visible, so it's the
   only one that needs it.
3. **Prepare** — *from frame 2 onward*, fixed and sticky elements (sticky headers,
   cookie banners, chat widgets) are temporarily hidden so they don't get baked
   into every remaining slice, and smooth-scrolling is disabled so each scroll
   step is instant.
4. **Capture** — the page (or the detected scroll container) is scrolled in
   step-sized increments; after each scroll, `chrome.tabs.captureVisibleTab`
   grabs that slice. The last step is aligned to the bottom so there's never a
   blank gap. Calls are throttled/retried to respect Chrome's capture rate limit.
5. **Restore** — hidden elements and scroll position (window and/or container)
   are put back exactly as they were.
6. **Stitch** — a new tab (`results.html`) loads all the slices onto a `<canvas>`.
   For ordinary document-scrolled pages, each slice is drawn at its true offset.
   For inner-container pages, frame 0 is drawn in full (so fixed chrome like a
   sidebar shows correctly at the top), and every later frame contributes only
   the container's own on-screen band — the surrounding static chrome from that
   shot is discarded rather than pasted again, so it never repeats down the page.
   (Service workers have no DOM, so stitching happens in a normal extension
   page, not the background script.)

Both the plain scroll math and the container-crop math were verified
independently with synthetic test pages (including a simulated fixed-sidebar
chat-app layout) — reconstructed output matched the source exactly, with no
gaps, seams, or duplicated chrome.

## Features

- **Full-page or visible-area capture** from the toolbar popup
- **Results viewer** with pinch-to-fit zoom and a floating zoom control
- **Annotate** — pen, rectangle, arrow, and text tools with an undo stack, baked
  into the image on save
- **Export** as PNG (via the browser's native download) or a paginated **PDF**
  (built with a locally-bundled copy of jsPDF — no network calls)
- **Copy to clipboard** for pasting straight into docs or chat
- **History** — a searchable contact-sheet of every past capture, stored locally
- **Settings** — frame delay, PNG/JPEG format, JPEG quality, history size

Everything is stored in `chrome.storage.local` on-device. Nothing is uploaded
anywhere.

## Install (load unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder
5. Pin the extension and click it on any page to try it

## Project layout

```
manifest.json      Extension manifest (MV3)
background.js       Service worker — scroll/capture orchestration
popup.html / .js    Toolbar popup — capture buttons + recent captures
results.html / .js  Stitching, preview, annotate, export
history.html / .js  Full capture history / contact sheet
settings.html / .js Capture delay, format, history size
styles.css           Shared design system (used by every page)
lib/jspdf.umd.min.js Vendored PDF export library
fonts/               Self-hosted Inter + JetBrains Mono (no external requests)
icons/               Toolbar/store icons
```

## Known limitations

- On chat-app-style layouts, a fixed sidebar/navbar is shown correctly for the
  top section of the capture (matching what it actually looked like on screen)
  but isn't artificially repeated down the whole image, since it was never
  really "part of" the scrolling document — extending it further would mean
  fabricating pixels that were never on screen at the same time as that content.
- Pages that lazy-load content on scroll may need a longer **frame delay**
  (Settings) so new content finishes loading before each slice is captured.
- Horizontal scrolling isn't captured — only vertical, which covers the vast
  majority of pages.
- Content inside cross-origin iframes or closed shadow DOM can't be inspected
  for scroll containers, so those areas capture whatever is on screen in
  frame 0 without special handling.
- `chrome.tabs.captureVisibleTab` can't capture `chrome://` pages, the Chrome
  Web Store, or other browser-internal pages — this is a Chrome restriction,
  not something an extension can work around.
