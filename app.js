/* Stitch — combine overlapping mobile screenshots into one tall image.
 *
 * Pipeline (mirrors prototype.py):
 *   1. detectChrome(images, tol):    median per-pair top/bottom chrome height
 *   2. findOverlap(A, B, top, bot):  best d (row in A) where B[top..top+strip] aligns
 *   3. stitch(images):               concat full A0 + new rows from each subsequent image
 */

const $ = (sel) => document.querySelector(sel);

// ----- State -----

const state = {
  // Each entry: { file, name, bitmap (ImageBitmap), w, h, imageData (lazy) }
  images: [],
  // Manual mask boxes in image coordinates, applied to all images
  manualMasks: [],
  // Last successful stitch canvas — used for on-the-fly format re-encoding
  lastCanvas: null,
};

// Format profiles: dropdown value → { mime, encoder } where encoder is
// "native" (always canvas.toBlob), "wasm-mozjpeg" (always WASM), or "auto"
// (native preferred, WASM fallback if browser silently returned wrong mime).
const FORMAT_PROFILES = {
  "png":          { mime: "image/png",  encoder: "native" },
  "jpeg-fast":    { mime: "image/jpeg", encoder: "native" },
  "jpeg-quality": { mime: "image/jpeg", encoder: "wasm-mozjpeg" },
  "webp":         { mime: "image/webp", encoder: "auto" },
  "avif":         { mime: "image/avif", encoder: "auto" },
};

// ----- UI wiring -----

const drop = $("#drop");
const fileInput = $("#file");
const thumbs = $("#thumbs");
const controls = $("#controls");
const status = $("#status");
const result = $("#result");
const output = $("#output");
const downloadBtn = $("#download");
const stitchBtn = $("#stitch");
const clearBtn = $("#clear");
const countLabel = $("#count");
const overrideChromeBox = $("#override-chrome");

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => addFiles(e.target.files));
clearBtn.addEventListener("click", () => { state.images = []; renderThumbs(); renderResult(null); setStatus(""); });
stitchBtn.addEventListener("click", runStitch);
$("#define-masks").addEventListener("click", openMaskModal);
$("#mask-done").addEventListener("click", () => $("#mask-modal").hidden = true);
updateMaskCount();

// Output format controls — AVIF stays in the list even if native encoding is missing;
// we lazy-load a WASM encoder fallback when needed.
$("#format").addEventListener("change", reencodeOutput);
$("#quality").addEventListener("input", () => {
  $("#quality-val").textContent = Math.round(parseFloat($("#quality").value) * 100) + "%";
});
$("#quality").addEventListener("change", reencodeOutput);
updateQualityRowVisibility();

overrideChromeBox.addEventListener("change", (e) => {
  document.querySelectorAll(".controls label.manual").forEach((l) => l.style.display = e.target.checked ? "inline-flex" : "none");
  $("#top-chrome").disabled = !e.target.checked;
  $("#bot-chrome").disabled = !e.target.checked;
});

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /^image\/(png|jpeg)/.test(f.type));
  if (!files.length) return;
  setStatus(`Loading ${files.length} image(s)…`);
  for (const f of files) {
    try {
      const bitmap = await createImageBitmap(f);
      state.images.push({
        file: f,
        name: f.name,
        bitmap,
        w: bitmap.width,
        h: bitmap.height,
      });
    } catch (err) {
      setStatus(`Failed to read ${f.name}: ${err.message}`, true);
      return;
    }
  }
  // Stable sort by filename
  state.images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  renderThumbs();
  setStatus(`${state.images.length} image(s) loaded.`);
}

function renderThumbs() {
  thumbs.innerHTML = "";
  if (!state.images.length) {
    thumbs.hidden = true;
    controls.hidden = true;
    countLabel.textContent = "";
    return;
  }
  thumbs.hidden = false;
  controls.hidden = false;
  countLabel.textContent = `(${state.images.length})`;

  state.images.forEach((img, idx) => {
    const el = document.createElement("div");
    el.className = "thumb";
    el.draggable = true;
    el.dataset.idx = idx;

    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = Math.round((img.h / img.w) * 240);
    canvas.getContext("2d").drawImage(img.bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL();

    el.innerHTML = `
      <div class="idx">${idx + 1}</div>
      <button class="remove" title="remove" aria-label="remove">×</button>
      <img src="${dataUrl}" alt="${img.name}" />
      <div class="meta"><span title="${img.name}">${img.name.length > 14 ? img.name.slice(0, 12) + "…" : img.name}</span><span>${img.w}×${img.h}</span></div>
    `;
    el.querySelector(".remove").addEventListener("click", (e) => {
      e.stopPropagation();
      state.images.splice(idx, 1);
      renderThumbs();
    });

    // Reorder via drag
    el.addEventListener("dragstart", (e) => { el.classList.add("dragging"); e.dataTransfer.setData("text/plain", idx); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const toIdx = parseInt(el.dataset.idx, 10);
      if (Number.isNaN(fromIdx) || fromIdx === toIdx) return;
      const [moved] = state.images.splice(fromIdx, 1);
      state.images.splice(toIdx, 0, moved);
      renderThumbs();
    });

    thumbs.appendChild(el);
  });
}

function setStatus(msg, isError = false) {
  status.innerHTML = "";
  if (msg) {
    const span = document.createElement("span");
    if (isError) span.className = "err";
    span.textContent = msg;
    status.appendChild(span);
  }
}

function renderResult(blobUrl, meta) {
  if (!blobUrl) {
    result.hidden = true;
    output.src = "";
    if (downloadBtn.href.startsWith("blob:")) URL.revokeObjectURL(downloadBtn.href);
    downloadBtn.removeAttribute("href");
    return;
  }
  result.hidden = false;
  output.src = blobUrl;
  downloadBtn.href = blobUrl;
  document.querySelector(".result-meta").textContent = meta || "";
}

function extensionFor(mime) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" }[mime] || "png";
}
function isLossy(mime) { return mime !== "image/png"; }

function profileMime(key) { return (FORMAT_PROFILES[key] || FORMAT_PROFILES.png).mime; }

function updateQualityRowVisibility() {
  const mime = profileMime($("#format").value);
  $("#quality-row").style.display = isLossy(mime) ? "inline-flex" : "none";
}

// Lazy-loaded WASM encoders (loaded on first use).
const wasmEncoders = {
  "image/webp": null,
  "image/avif": null,
  "image/jpeg": null, // mozjpeg
};

// (Moved FORMAT_PROFILES definition higher up — see top of file.)

async function loadWasmEncoder(mime) {
  if (wasmEncoders[mime]) return wasmEncoders[mime];
  const url = {
    "image/webp": "https://esm.sh/@jsquash/webp@1.4.0",
    "image/avif": "https://esm.sh/@jsquash/avif@2.1.1",
    "image/jpeg": "https://esm.sh/@jsquash/jpeg@1.5.0",
  }[mime];
  if (!url) return null;
  const mod = await import(/* @vite-ignore */ url);
  wasmEncoders[mime] = mod.encode || (mod.default && mod.default.encode);
  return wasmEncoders[mime];
}

async function encodeViaWasm(canvas, mime, quality) {
  const enc = await loadWasmEncoder(mime);
  if (!enc) throw new Error(`Failed to load ${mime} encoder`);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const q100 = Math.round(quality * 100);
  let buf;
  if (mime === "image/webp")      buf = await enc(imageData, { quality: q100 });
  else if (mime === "image/avif") buf = await enc(imageData, { quality: q100, speed: 6 });
  else if (mime === "image/jpeg") buf = await enc(imageData, {
    quality: q100,
    progressive: true,
    optimize_coding: true,
    trellis_multipass: true,   // exhaustive RDO — slower, but the whole point of this option
    trellis_opt_zero: true,
    trellis_opt_table: true,
  });
  else throw new Error(`No WASM encoder for ${mime}`);
  return new Blob([buf], { type: mime });
}

async function encodeCanvas(profileKey, canvas, quality) {
  const profile = FORMAT_PROFILES[profileKey] || FORMAT_PROFILES.png;
  const { mime, encoder } = profile;

  if (encoder === "wasm-mozjpeg") {
    setStatus(`Encoding with mozjpeg — slower but better quality at the same file size…`);
    return await encodeViaWasm(canvas, "image/jpeg", quality);
  }

  if (encoder === "native") {
    return await new Promise((res) => canvas.toBlob(res, mime, quality));
  }

  // "auto": try native first; if browser silently returns wrong type, fall back to WASM
  const native = await new Promise((res) => canvas.toBlob(res, mime, quality));
  if (native && native.type === mime) return native;
  if (mime === "image/webp" || mime === "image/avif") {
    setStatus(`Encoding ${mime.split("/")[1].toUpperCase()} via WASM (your browser can't encode this natively)…`);
    return await encodeViaWasm(canvas, mime, quality);
  }
  return native;
}

async function reencodeOutput() {
  updateQualityRowVisibility();
  if (!state.lastCanvas) return;
  const profileKey = $("#format").value;
  const expectedMime = profileMime(profileKey);
  const quality = parseFloat($("#quality").value);
  const canvas = state.lastCanvas;
  downloadBtn.style.pointerEvents = "none";
  downloadBtn.style.opacity = "0.5";
  let blob;
  try {
    const t0 = performance.now();
    blob = await encodeCanvas(profileKey, canvas, quality);
    const dt = Math.round(performance.now() - t0);
    if (!blob) throw new Error("encoder returned null");
    if (blob.type !== expectedMime) {
      setStatus(`Browser returned ${blob.type} instead of ${expectedMime}. Try a different format.`, true);
    }
    if (downloadBtn.href.startsWith("blob:")) URL.revokeObjectURL(downloadBtn.href);
    const url = URL.createObjectURL(blob);
    output.src = url;
    downloadBtn.href = url;
    downloadBtn.download = `stitched.${extensionFor(blob.type)}`;
    const sizeKb = Math.round(blob.size / 1024);
    const variantLabel = profileKey === "jpeg-quality" ? "JPEG (mozjpeg)"
                       : profileKey === "jpeg-fast"    ? "JPEG (fast)"
                       : blob.type.split("/")[1].toUpperCase();
    const meta = `${canvas.width}×${canvas.height}px · ${sizeKb} KB · ${variantLabel}${isLossy(blob.type) ? ` @${Math.round(quality*100)}%` : ""} · ${dt}ms`;
    document.querySelector(".result-meta").textContent = meta;
  } catch (err) {
    setStatus(`Encoding failed: ${err.message}. Falling back to PNG.`, true);
    if ($("#format").value !== "png") {
      $("#format").value = "png";
      return reencodeOutput();
    }
  } finally {
    downloadBtn.style.pointerEvents = "";
    downloadBtn.style.opacity = "";
  }
}

// ----- Mask modal -----

function updateMaskCount() {
  const n = state.manualMasks.length;
  $("#mask-count").textContent = n === 0 ? "(none)" : `(${n} box${n === 1 ? "" : "es"})`;
}

function openMaskModal() {
  if (!state.images.length) {
    setStatus("Load images first.", true);
    return;
  }
  // Use second image if available (more likely to show the overlay) else first
  const refImg = state.images[Math.min(1, state.images.length - 1)];
  const modal = $("#mask-modal");
  const img = $("#mask-img");
  const canvas = $("#mask-canvas");
  const stage = $("#mask-stage");

  // Render the reference image as a data URL (so we don't depend on it being still around)
  const c = document.createElement("canvas");
  c.width = refImg.w;
  c.height = refImg.h;
  c.getContext("2d").drawImage(refImg.bitmap, 0, 0);
  img.src = c.toDataURL("image/jpeg", 0.7);

  modal.hidden = false;

  img.onload = () => {
    // Match canvas backing-store to display size so drawing maps 1:1 in CSS pixels
    const rect = img.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    stage.style.width = rect.width + "px";
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    drawMaskCanvas(canvas, refImg);
  };

  // Mouse interaction
  let dragStart = null;
  const ctx = canvas.getContext("2d");

  const cssToImg = (cssX, cssY) => {
    const scale = refImg.w / canvas.width;
    return { x: Math.round(cssX * scale), y: Math.round(cssY * scale) };
  };

  canvas.onmousedown = (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    // Click on existing box → delete it
    const clicked = state.manualMasks.findIndex((b) => {
      const top = b.y1 * (canvas.height / refImg.h);
      const bot = b.y2 * (canvas.height / refImg.h);
      const lef = b.x1 * (canvas.width / refImg.w);
      const rig = b.x2 * (canvas.width / refImg.w);
      return cx >= lef && cx <= rig && cy >= top && cy <= bot;
    });
    if (clicked >= 0) {
      state.manualMasks.splice(clicked, 1);
      drawMaskCanvas(canvas, refImg);
      updateMaskCount();
      return;
    }
    dragStart = { cx, cy };
  };
  canvas.onmousemove = (e) => {
    if (!dragStart) return;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    drawMaskCanvas(canvas, refImg);
    ctx.strokeStyle = "rgba(255, 200, 0, 0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(dragStart.cx, dragStart.cy, cx - dragStart.cx, cy - dragStart.cy);
  };
  canvas.onmouseup = (e) => {
    if (!dragStart) return;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x1 = Math.min(dragStart.cx, cx), x2 = Math.max(dragStart.cx, cx);
    const y1 = Math.min(dragStart.cy, cy), y2 = Math.max(dragStart.cy, cy);
    dragStart = null;
    if ((x2 - x1) < 8 || (y2 - y1) < 8) { drawMaskCanvas(canvas, refImg); return; }
    const p1 = cssToImg(x1, y1), p2 = cssToImg(x2, y2);
    state.manualMasks.push({ y1: p1.y, y2: p2.y, x1: p1.x, x2: p2.x });
    drawMaskCanvas(canvas, refImg);
    updateMaskCount();
  };
}

function drawMaskCanvas(canvas, refImg) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255, 84, 112, 0.25)";
  ctx.strokeStyle = "rgba(255, 84, 112, 1)";
  ctx.lineWidth = 2;
  for (const b of state.manualMasks) {
    const top = b.y1 * (canvas.height / refImg.h);
    const bot = b.y2 * (canvas.height / refImg.h);
    const lef = b.x1 * (canvas.width / refImg.w);
    const rig = b.x2 * (canvas.width / refImg.w);
    ctx.fillRect(lef, top, rig - lef, bot - top);
    ctx.strokeRect(lef, top, rig - lef, bot - top);
  }
}

// ----- Image data helpers -----

function getImageData(img) {
  if (img._imageData) return img._imageData;
  const c = document.createElement("canvas");
  c.width = img.w;
  c.height = img.h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img.bitmap, 0, 0);
  img._imageData = ctx.getImageData(0, 0, img.w, img.h);
  return img._imageData;
}

/** For each row [0..H), the maximum per-channel absolute diff across the row,
 *  comparing image A and image B. Both images must have equal width.
 *  Returns Uint8Array of length H. */
function perRowMaxDiff(a, b) {
  const ad = getImageData(a), bd = getImageData(b);
  const W = ad.width, H = Math.min(ad.height, bd.height);
  const ap = ad.data, bp = bd.data;
  const out = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let maxD = 0;
    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = rowOff + x * 4;
      const dr = Math.abs(ap[i]     - bp[i]);
      const dg = Math.abs(ap[i + 1] - bp[i + 1]);
      const db = Math.abs(ap[i + 2] - bp[i + 2]);
      const m = Math.max(dr, dg, db);
      if (m > maxD) maxD = m;
    }
    out[y] = maxD;
  }
  return out;
}

// ----- Algorithm: chrome detection -----

function detectChrome(images, tolerance) {
  const tops = [], bots = [];
  for (let k = 0; k < images.length - 1; k++) {
    const rowmax = perRowMaxDiff(images[k], images[k + 1]);
    const H = rowmax.length;
    let top = H;
    for (let y = 0; y < H; y++) {
      if (rowmax[y] > tolerance) { top = y; break; }
    }
    let bot = H;
    for (let y = H - 1; y >= 0; y--) {
      if (rowmax[y] > tolerance) { bot = H - 1 - y; break; }
    }
    tops.push(top);
    bots.push(bot);
  }
  return { top: median(tops), bot: median(bots) };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
}

// ----- Algorithm: overlap search -----

/** Find d in A such that A[d..d+stripH] best matches B[topChrome..topChrome+stripH].
 *  Subsamples both row and column by `step` for speed.
 *  Returns { d, score } where score is mean absolute diff (0 = perfect). */
function findOverlap(a, b, topChrome, botChrome, stripH, step) {
  const ad = getImageData(a), bd = getImageData(b);
  const W = ad.width;
  const Ha = ad.height, Hb = bd.height;

  let bsTop = topChrome;
  let actualStrip = stripH;
  if (bsTop + actualStrip > Hb - botChrome) {
    actualStrip = Math.max(50, (Hb - botChrome) - bsTop - 1);
  }
  const bsBot = bsTop + actualStrip;

  const dMin = topChrome;
  const dMax = Ha - botChrome - actualStrip;
  if (dMax <= dMin) return { d: null, score: Infinity };

  // Pre-collect sampled rows from B into a typed array (Int16, length = sampledRows * sampledCols * 3)
  const sampledCols = Math.ceil(W / step);
  const sampledRows = Math.ceil(actualStrip / step);
  const stripBuf = new Int16Array(sampledRows * sampledCols * 3);
  {
    const bp = bd.data;
    let pi = 0;
    for (let y = 0; y < actualStrip; y += step) {
      const rowOff = (bsTop + y) * W * 4;
      for (let x = 0; x < W; x += step) {
        const i = rowOff + x * 4;
        stripBuf[pi++] = bp[i];
        stripBuf[pi++] = bp[i + 1];
        stripBuf[pi++] = bp[i + 2];
      }
    }
  }

  const ap = ad.data;
  let bestD = -1, bestScore = Infinity;
  const totalSamples = sampledRows * sampledCols * 3;
  // bestSum is the sum-of-abs-diffs corresponding to bestScore
  let bestSum = Infinity;

  for (let d = dMin; d <= dMax; d++) {
    let sum = 0;
    let pi = 0;
    // Early exit if we exceed bestSum (Manhattan distance is monotone)
    for (let y = 0; y < actualStrip; y += step) {
      const rowOff = (d + y) * W * 4;
      for (let x = 0; x < W; x += step) {
        const i = rowOff + x * 4;
        sum += Math.abs(ap[i]     - stripBuf[pi++]);
        sum += Math.abs(ap[i + 1] - stripBuf[pi++]);
        sum += Math.abs(ap[i + 2] - stripBuf[pi++]);
      }
      if (sum >= bestSum) break;
    }
    if (sum < bestSum) {
      bestSum = sum;
      bestD = d;
    }
  }
  bestScore = bestSum / totalSamples;
  return { d: bestD, score: bestScore };
}

// ----- Floating UI overlay detection (e.g. WhatsApp scroll-to-bottom chevron) -----

/** Detect compact regions that stay pixel-identical across the majority of
 *  consecutive pairs in the scrollable area. Returns array of bounding boxes
 *  in image coordinates: [{ y1, y2, x1, x2, area }]. */
function detectOverlayBoxes(images, topChrome, botChrome, opts = {}) {
  const tolerance = opts.tolerance ?? 8;
  const nPairs = images.length - 1;
  const minVotes = opts.minVotes ?? Math.max(2, Math.floor(nPairs / 2) + 1);
  const erodeIter = opts.erodeIter ?? 3;
  const minArea = opts.minArea ?? 3000;     // overlay button is at least this many px
  const maxArea = opts.maxArea ?? 40000;
  const maxDim = opts.maxDim ?? 250;
  const minFill = opts.minFill ?? 0.35;
  const minAspect = opts.minAspect ?? 0.5;   // bbox short/long must be at least this
  const requireEdge = opts.requireEdge ?? true; // must touch left or right edge of screen
  const edgeMargin = opts.edgeMargin ?? 100; // "edge" = within this many px of border (WhatsApp chevron floats ~80px in)

  const W = images[0].w, H = images[0].h;
  const votes = new Uint8Array(W * H);

  for (let k = 0; k < nPairs; k++) {
    const ad = getImageData(images[k]).data;
    const bd = getImageData(images[k + 1]).data;
    for (let y = topChrome; y < H - botChrome; y++) {
      const rowOff = y * W * 4;
      const baseI = y * W;
      for (let x = 0; x < W; x++) {
        const i = rowOff + x * 4;
        const dr = Math.abs(ad[i]     - bd[i]);
        const dg = Math.abs(ad[i + 1] - bd[i + 1]);
        const db = Math.abs(ad[i + 2] - bd[i + 2]);
        if (Math.max(dr, dg, db) <= tolerance) votes[baseI + x]++;
      }
    }
  }

  let mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (votes[i] >= minVotes) mask[i] = 1;

  // Erode with 4-neighborhood
  let cur = mask;
  let nxt = new Uint8Array(W * H);
  for (let it = 0; it < erodeIter; it++) {
    nxt.fill(0);
    for (let y = 1; y < H - 1; y++) {
      const rowOff = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = rowOff + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W]) nxt[i] = 1;
      }
    }
    [cur, nxt] = [nxt, cur];
  }
  mask = cur;

  // Connected components (BFS, 4-connectivity)
  const labels = new Int32Array(W * H);
  const boxes = [];
  const rejected = [];
  const queue = new Int32Array(W * H);
  let nextLabel = 0;

  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const i = rowOff + x;
      if (!mask[i] || labels[i]) continue;
      nextLabel++;
      let qh = 0, qt = 0;
      queue[qt++] = i;
      labels[i] = nextLabel;
      let y1 = y, y2 = y, x1 = x, x2 = x, area = 0;
      while (qh < qt) {
        const p = queue[qh++];
        area++;
        const py = (p / W) | 0, px = p - py * W;
        if (py < y1) y1 = py;
        if (py > y2) y2 = py;
        if (px < x1) x1 = px;
        if (px > x2) x2 = px;
        if (px > 0     && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = nextLabel; queue[qt++] = p - 1; }
        if (px < W - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = nextLabel; queue[qt++] = p + 1; }
        if (py > 0     && mask[p - W] && !labels[p - W]) { labels[p - W] = nextLabel; queue[qt++] = p - W; }
        if (py < H - 1 && mask[p + W] && !labels[p + W]) { labels[p + W] = nextLabel; queue[qt++] = p + W; }
      }
      const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
      const bboxArea = bw * bh;
      const fill = area / bboxArea;
      const aspect = Math.min(bw, bh) / Math.max(bw, bh);
      const touchesEdge = (x1 <= edgeMargin) || (x2 >= W - 1 - edgeMargin);
      const cand = { y1, y2, x1, x2, area, fill, aspect, bw, bh, touchesEdge };
      let reason = null;
      if (area < minArea) reason = `area ${area} < ${minArea}`;
      else if (area > maxArea) reason = `area ${area} > ${maxArea}`;
      else if (Math.max(bw, bh) > maxDim) reason = `dim ${Math.max(bw, bh)} > ${maxDim}`;
      else if (fill < minFill) reason = `fill ${(fill*100).toFixed(0)}% < ${(minFill*100)|0}%`;
      else if (aspect < minAspect) reason = `aspect ${aspect.toFixed(2)} < ${minAspect}`;
      else if (requireEdge && !touchesEdge) reason = `not touching edge (x ${x1}-${x2}, W=${W})`;
      if (reason) { rejected.push({ ...cand, reason }); continue; }
      boxes.push({ y1, y2, x1, x2, area, fill, aspect });
    }
  }
  // Pad bboxes slightly to recover the rim eaten by erosion
  const pad = erodeIter + 1;
  const padded = boxes.map((b) => ({
    y1: Math.max(topChrome, b.y1 - pad),
    y2: Math.min(H - botChrome - 1, b.y2 + pad),
    x1: Math.max(0, b.x1 - pad),
    x2: Math.min(W - 1, b.x2 + pad),
    area: b.area,
    fill: b.fill,
  }));

  // Contrast filter: a real floating UI element (button, badge) has internal
  // structure — varied pixel values within the bbox. Flat wallpaper patches
  // are nearly uniform dark color, so they fail this check.
  // Use the per-image (image 1, which usually has overlays present) bbox to
  // compute brightness range. Keep if range > threshold.
  const minBrightnessRange = opts.minBrightnessRange ?? 80;
  const refImg = images[Math.min(1, images.length - 1)];
  const refData = getImageData(refImg).data;
  const accepted = [];
  for (const b of padded) {
    let minB = 255, maxB = 0;
    for (let y = b.y1; y <= b.y2; y++) {
      const rowOff = y * W * 4;
      for (let x = b.x1; x <= b.x2; x++) {
        const i = rowOff + x * 4;
        const lum = (refData[i] * 299 + refData[i + 1] * 587 + refData[i + 2] * 114 + 500) / 1000;
        if (lum < minB) minB = lum;
        if (lum > maxB) maxB = lum;
      }
    }
    const range = maxB - minB;
    if (range >= minBrightnessRange) accepted.push(b);
    else rejected.push({ ...b, reason: `brightness range ${range|0} < ${minBrightnessRange}` });
  }
  accepted.rejected = rejected;
  accepted.params = { tolerance, minVotes, nPairs, minArea, maxArea, maxDim, minFill, minAspect, requireEdge, minBrightnessRange };
  return accepted;
}

/** Patch the output canvas: for each overlay box and each image that contributed
 *  rows containing that overlay, copy clean pixels from a neighboring image whose
 *  equivalent rows are NOT under its own overlay. */
function inpaintOverlays(canvas, images, slices, overlays, topChrome, botChrome) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const out = ctx.getImageData(0, 0, W, H);

  // Pre-cache image data for each unique image in slices
  const imgData = slices.map((sl) => getImageData(images[sl.idx]).data);
  // shift(i) = sl.outputStart - sl.start, so output_y = shift(i) + image_y
  const shift = slices.map((sl) => sl.outputStart - sl.start);

  let patched = 0;
  for (const ov of overlays) {
    for (let si = 0; si < slices.length; si++) {
      const sl = slices[si];
      const yK1 = Math.max(ov.y1, sl.start);
      const yK2 = Math.min(ov.y2, sl.end - 1);
      if (yK2 < yK1) continue;

      // Try candidate neighbors, preferring closest
      const order = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
      let chosen = null;
      for (const delta of order) {
        const oi = si + delta;
        if (oi < 0 || oi >= slices.length) continue;
        const other = slices[oi];
        if (other.idx === sl.idx) continue;
        const otherImg = images[other.idx];
        const Ho = otherImg.h;
        // shift_K_to_M in image coords: y_M = y_K + (shift(K) - shift(M))
        const imgShift = shift[si] - shift[oi];

        // Compute the y_M range we'd be reading
        const yM1 = yK1 + imgShift;
        const yM2 = yK2 + imgShift;
        // Must be entirely in scrollable area
        if (yM1 < topChrome || yM2 >= Ho - botChrome) continue;
        // Must be entirely outside this other image's overlay region (same overlay bbox, same screen coords)
        const inOverlay = (yMin, yMax) => yMax >= ov.y1 && yMin <= ov.y2;
        if (inOverlay(yM1, yM2)) continue;
        chosen = { other, otherImg, otherData: imgData[oi], imgShift };
        break;
      }
      if (!chosen) continue;

      const { otherData, imgShift } = chosen;
      const Ho = chosen.otherImg.h;

      for (let outY = shift[si] + yK1; outY <= shift[si] + yK2; outY++) {
        const yK = outY - shift[si];
        const yM = yK + imgShift;
        if (yM < 0 || yM >= Ho) continue;
        const outRow = outY * W * 4;
        const inRow = yM * W * 4;
        for (let x = ov.x1; x <= ov.x2; x++) {
          const oi4 = outRow + x * 4;
          const ii4 = inRow + x * 4;
          out.data[oi4]     = otherData[ii4];
          out.data[oi4 + 1] = otherData[ii4 + 1];
          out.data[oi4 + 2] = otherData[ii4 + 2];
          out.data[oi4 + 3] = 255;
        }
      }
      patched++;
    }
  }
  ctx.putImageData(out, 0, 0);
  return patched;
}

// ----- Moving overlay: right-edge scroll indicator -----

/** Auto-detect the column range that contains a moving vertical bar near the
 *  right edge. Looks at the last 50 columns and picks the contiguous span of
 *  cols whose brightness range across all source images exceeds a threshold. */
function detectScrollbarCols(images, topChrome, botChrome, opts = {}) {
  const lookback = opts.lookback ?? 50;
  const threshold = opts.threshold ?? 50;
  const W = images[0].w, H = images[0].h;
  const xStart = Math.max(0, W - lookback);

  // For each col x in [xStart, W), compute brightness range across all (image, y).
  const rangePerCol = new Int32Array(W - xStart);
  for (const img of images) {
    const data = getImageData(img).data;
    for (let x = xStart; x < W; x++) {
      let lo = 255, hi = 0;
      for (let y = topChrome; y < H - botChrome; y++) {
        const i = (y * W + x) * 4;
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000 | 0;
        if (lum < lo) lo = lum;
        if (lum > hi) hi = lum;
      }
      const ci = x - xStart;
      const range = hi - lo;
      if (range > rangePerCol[ci]) rangePerCol[ci] = range;
    }
  }

  // Find contiguous span(s) above threshold; pick the widest
  let bestStart = -1, bestEnd = -1, bestLen = 0;
  let curStart = -1;
  for (let i = 0; i < rangePerCol.length; i++) {
    if (rangePerCol[i] >= threshold) {
      if (curStart < 0) curStart = i;
    } else if (curStart >= 0) {
      const len = i - curStart;
      if (len > bestLen) { bestStart = curStart; bestEnd = i - 1; bestLen = len; }
      curStart = -1;
    }
  }
  if (curStart >= 0) {
    const len = rangePerCol.length - curStart;
    if (len > bestLen) { bestStart = curStart; bestEnd = rangePerCol.length - 1; bestLen = len; }
  }
  if (bestStart < 0) return null;
  // Add a 2-col safety pad
  return { xStart: Math.max(0, xStart + bestStart - 2), xEnd: Math.min(W - 1, xStart + bestEnd + 2) };
}

/** For each row in the scrollable output region, replace pixels in cols
 *  [xStart, xEnd] that exceed a brightness threshold (i.e. scrollbar pixels)
 *  with the wallpaper pixel from a reference column just left of the scrollbar.
 *  Pure in-frame operation on the stitched canvas — works for every row, not
 *  just multi-frame overlap regions. */
function removeScrollbar(canvas, xStart, xEnd, topChromeOutput, botChromeOutput, opts = {}) {
  const threshold = opts.threshold ?? 70;
  const refOffset = opts.refOffset ?? 5; // ref col = xStart - refOffset
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  const out = ctx.getImageData(0, 0, W, H);
  const data = out.data;
  const refCol = Math.max(0, xStart - refOffset);

  let pxPatched = 0;
  const yLo = Math.max(0, topChromeOutput);
  const yHi = Math.min(H, H - botChromeOutput);
  for (let y = yLo; y < yHi; y++) {
    const refI = (y * W + refCol) * 4;
    const refR = data[refI], refG = data[refI + 1], refB = data[refI + 2];
    for (let x = xStart; x <= xEnd; x++) {
      const i = (y * W + x) * 4;
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) >> 10;
      if (lum > threshold) {
        data[i]     = refR;
        data[i + 1] = refG;
        data[i + 2] = refB;
        pxPatched++;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return pxPatched;
}

// ----- Stitch -----

async function runStitch() {
  const images = state.images;
  if (images.length < 2) {
    setStatus("Need at least 2 images.", true);
    return;
  }
  // Validate widths
  const w0 = images[0].w;
  for (const im of images) {
    if (im.w !== w0) {
      setStatus(`All images must have the same width. ${im.name} is ${im.w}px, expected ${w0}px.`, true);
      return;
    }
  }

  stitchBtn.disabled = true;
  setStatus("Working…");
  await new Promise((r) => setTimeout(r, 10)); // let UI repaint

  const tolerance = parseInt($("#tolerance").value, 10) || 8;
  const stripH = parseInt($("#strip").value, 10) || 200;
  const step = Math.max(1, parseInt($("#step").value, 10) || 2);

  let top, bot;
  if (overrideChromeBox.checked) {
    top = parseInt($("#top-chrome").value, 10) || 0;
    bot = parseInt($("#bot-chrome").value, 10) || 0;
    setStatus(`Using manual chrome: top=${top}, bot=${bot}`);
  } else {
    const t0 = performance.now();
    ({ top, bot } = detectChrome(images, tolerance));
    setStatus(`Detected chrome: top=${top}px, bot=${bot}px  (${Math.round(performance.now() - t0)}ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }

  // Compute slices
  const slices = [{ idx: 0, start: 0, end: images[0].h - bot }];
  const diag = [];

  for (let k = 1; k < images.length; k++) {
    const a = images[k - 1], b = images[k];
    const t0 = performance.now();
    const { d, score } = findOverlap(a, b, top, bot, stripH, step);
    const dt = Math.round(performance.now() - t0);

    let firstNew;
    if (d === null || score > 30) {
      firstNew = top;
      diag.push(`pair ${k - 1}→${k}: WEAK match (d=${d}, score=${score.toFixed(2)}); appending without overlap removal [${dt}ms]`);
    } else {
      firstNew = top + ((a.h - bot) - d);
      diag.push(`pair ${k - 1}→${k}: d=${d}, score=${score.toFixed(2)}, first_new=${firstNew} [${dt}ms]`);
    }

    const isLast = (k === images.length - 1);
    const end = isLast ? b.h : b.h - bot;
    firstNew = Math.max(top, Math.min(firstNew, end));
    slices.push({ idx: k, start: firstNew, end });
    setStatus(diag.join("\n"));
    await new Promise((r) => setTimeout(r, 10));
  }

  // Composite onto a canvas
  let cumulative = 0;
  for (const sl of slices) {
    sl.outputStart = cumulative;
    cumulative += (sl.end - sl.start);
  }
  const totalH = cumulative;
  const canvas = document.createElement("canvas");
  canvas.width = w0;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");

  for (const sl of slices) {
    const h = sl.end - sl.start;
    if (h <= 0) continue;
    ctx.drawImage(images[sl.idx].bitmap, 0, sl.start, w0, h, 0, sl.outputStart, w0, h);
  }

  // Floating UI overlay masking: auto-detect + manual
  const autoOn = $("#mask-overlays").checked && images.length >= 3;
  const allOverlays = [];
  if (autoOn) {
    const t0 = performance.now();
    const auto = detectOverlayBoxes(images, top, bot);
    const p = auto.params || {};
    const allRej = auto.rejected || [];
    // Only show "interesting" rejections: roughly chevron-sized candidates that
    // failed near a threshold. Drop 1-px noise and giant background blobs.
    const interesting = allRej.filter((r) =>
      r.area >= 500 && r.area <= 200000 && Math.max((r.x2 - r.x1 + 1), (r.y2 - r.y1 + 1)) <= 500
    );
    diag.push(`auto overlay detection: ${auto.length} accepted, ${allRej.length} rejected (${interesting.length} near-miss) [${Math.round(performance.now() - t0)}ms]`);
    diag.push(`  params: pairs=${p.nPairs}, minVotes=${p.minVotes}, tolerance=${p.tolerance}`);
    for (const ov of auto) {
      diag.push(`  ✓ rows ${ov.y1}-${ov.y2}, cols ${ov.x1}-${ov.x2} (area=${ov.area}, fill=${(ov.fill*100).toFixed(0)}%)`);
    }
    const shown = interesting.slice(0, 12);
    for (const ov of shown) {
      diag.push(`  ✗ rows ${ov.y1}-${ov.y2}, cols ${ov.x1}-${ov.x2} (area=${ov.area}) — ${ov.reason}`);
    }
    if (interesting.length > shown.length) {
      diag.push(`  … ${interesting.length - shown.length} more near-miss rejection(s) suppressed`);
    }
    allOverlays.push(...auto);
  }
  if (state.manualMasks.length) {
    diag.push(`manual masks: ${state.manualMasks.length} box(es)`);
    allOverlays.push(...state.manualMasks);
  }
  if (allOverlays.length) {
    const t1 = performance.now();
    const patched = inpaintOverlays(canvas, images, slices, allOverlays, top, bot);
    diag.push(`patched ${patched} region(s) [${Math.round(performance.now() - t1)}ms]`);
    setStatus(diag.join("\n"));
    await new Promise((r) => setTimeout(r, 10));
  }

  // Optional: remove right-edge scroll indicator via median across frames
  if ($("#mask-scrollbar").checked && images.length >= 3) {
    const t0 = performance.now();
    const sb = detectScrollbarCols(images, top, bot);
    if (sb) {
      diag.push(`scrollbar columns detected: ${sb.xStart}-${sb.xEnd} [${Math.round(performance.now() - t0)}ms]`);
      const t1 = performance.now();
      const px = removeScrollbar(canvas, sb.xStart, sb.xEnd, top, bot);
      diag.push(`scrollbar removal: cleared ${px} pixel(s) over ${sb.xEnd - sb.xStart + 1} cols [${Math.round(performance.now() - t1)}ms]`);
    } else {
      diag.push(`scrollbar removal: no high-variance column span detected; skipped`);
    }
    setStatus(diag.join("\n"));
    await new Promise((r) => setTimeout(r, 10));
  }

  state.lastCanvas = canvas;
  result.hidden = false; // ensure result section visible before reencode populates it
  await reencodeOutput();
  stitchBtn.disabled = false;
  setStatus(diag.join("\n") + `\nDone.`);
}
