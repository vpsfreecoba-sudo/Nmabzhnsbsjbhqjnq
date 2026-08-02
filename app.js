import { clearAllRecords, deleteRecord, getAllRecords, saveRecord } from "./db.js";
import { initChangelog } from "./src/changelog.mjs";

// ============================================================
//  KONSTANTA & UI REFERENSI
// ============================================================
const outputSuffix = "METHOD MINZHA @xd_minn";
const supportedMimeTypes = ["video/mp4", "video/quicktime", "video/x-quicktime"];
const supportedExtensions = [".mp4", ".mov"];

const fileInput = document.getElementById("fileInput");
const patchBtn = document.getElementById("patchBtn");
const clearBtn = document.getElementById("clearBtn");
const dropZone = document.getElementById("dropZone");
const statusLog = document.getElementById("statusLog");
const progressBar = document.getElementById("progressBar");
const progressTrack = document.getElementById("progressTrack");
const fileListEl = document.getElementById("fileList");
const historyList = document.getElementById("historyList");
const historyBadge = document.getElementById("historyBadge");
const historyHeader = document.getElementById("historyHeader");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;
let lastPatchedVfi = false;
let lastPatchedRes = "1080";

// ============================================================
//  UTILITY (tetap)
// ============================================================
function adjustMobileLayout() {
  const isMobile = window.innerWidth <= 900;
  const header = document.querySelector(".header");
  const panelHeader = header?.parentNode;
  const panelRight = document.querySelector(".panel-right");
  const dropZoneEl = document.getElementById("dropZone");
  if (isMobile) {
    if (dropZoneEl && panelHeader && dropZoneEl.parentNode !== panelHeader) {
      panelHeader.after(dropZoneEl);
    }
  } else {
    if (dropZoneEl && panelRight && dropZoneEl.parentNode !== panelRight) {
      panelRight.insertBefore(dropZoneEl, panelRight.firstChild);
    }
  }
}

function initializeApp() {
  renderHistoryList();
  adjustMobileLayout();
  window.addEventListener("resize", adjustMobileLayout);
  const copyBtn = document.getElementById("copyLogBtn");
  const copyToast = document.getElementById("copyLogToast");
  if (copyBtn) {
    let timer = null;
    copyBtn.addEventListener("click", async () => {
      const text = [...statusLog.querySelectorAll(".log-row")].map(r => r.textContent).join("\n");
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        copyToast.textContent = "Copied";
        copyToast.classList.add("show");
        clearTimeout(timer);
        timer = setTimeout(() => copyToast.classList.remove("show"), 1500);
      } catch {
        copyToast.textContent = "Copy failed";
        copyToast.classList.add("show");
        clearTimeout(timer);
        timer = setTimeout(() => copyToast.classList.remove("show"), 1500);
      }
    });
  }
}

function logMessage(text, type = "info") {
  const row = document.createElement("div");
  row.className = `log-row log-${type}`;
  row.textContent = text;
  statusLog.appendChild(row);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function clearLog() { statusLog.innerHTML = ""; }
function setLogCopyVisible(visible) {
  document.getElementById("copyLogBtn")?.classList.toggle("visible", visible);
}
function setProgress(percent) { progressBar.style.width = `${percent}%`; }
function showProgress() {
  progressTrack.classList.add("active");
  progressTrack.style.opacity = "1";
}
function hideProgress() {
  setTimeout(() => {
    progressTrack.style.opacity = "0";
    setTimeout(() => {
      setProgress(0);
      progressTrack.classList.remove("active");
    }, 400);
  }, 800);
}

function isSupportedFile(file) {
  const lower = file.name.toLowerCase();
  return supportedMimeTypes.includes(file.type) || supportedExtensions.some(ext => lower.endsWith(ext));
}
function getMimeType(file) { return "video/mp4"; }
function isMovFile(file) {
  const lower = file.name.toLowerCase();
  return lower.endsWith(".mov") || file.type === "video/quicktime" || file.type === "video/x-quicktime";
}
function getOutputFilename(file) { return `${outputSuffix}.mp4`; }

function formatFileSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBuffer(data, filename, mimeType) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

function getStatusLabel(status) {
  const map = { pending: "Pending", processing: "Processing", success: "Done", error: "Error" };
  return map[status] || status;
}

// ============================================================
//  THUMBNAIL CAPTURE (tetap)
// ============================================================
const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const MAX_THUMBNAIL_DIMENSION = 120;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";

function captureVideoFrame(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    let objectUrl = null;

    function cleanup(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.src = "";
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(result);
    }

    video.onloadeddata = () => {
      if (settled) return;
      video.currentTime = 0.1;
    };
    video.onseeked = () => {
      if (settled) return;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      let w = video.videoWidth;
      let h = video.videoHeight;
      const maxDim = MAX_THUMBNAIL_DIMENSION;
      if (w > h) {
        if (w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      } else {
        if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      cleanup(canvas.toDataURL("image/jpeg", 0.7));
    };
    video.onerror = () => cleanup(null);

    objectUrl = URL.createObjectURL(file);
    const timeoutId = setTimeout(() => cleanup(null), FRAME_CAPTURE_TIMEOUT_MS);
    video.src = objectUrl;
  });
}

// ============================================================
//  RENDER FILE LIST & HISTORY (tetap)
// ============================================================
function renderFileList() {
  fileListEl.innerHTML = "";
  if (selectedFiles.length === 0) {
    fileListEl.style.display = "none";
    clearBtn.style.display = "none";
    return;
  }
  fileListEl.style.display = "flex";
  clearBtn.style.display = "inline-flex";

  selectedFiles.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `file-item status-${item.status}`;

    const cw = document.createElement("label");
    cw.className = "custom-checkbox";
    const ci = document.createElement("input");
    ci.type = "checkbox";
    ci.checked = item.checked;
    if (currentFlowState !== "completed" || item.status !== "success" || !item.patchedBuffer) {
      ci.disabled = true;
    }
    ci.addEventListener("change", () => {
      item.checked = ci.checked;
      updatePatchButton();
    });
    const cs = document.createElement("span");
    cs.className = "checkbox-mark";
    cw.appendChild(ci);
    cw.appendChild(cs);
    row.appendChild(cw);

    const body = document.createElement("div");
    body.className = "file-item-body";
    const name = document.createElement("div");
    name.className = "file-item-name";
    name.textContent = item.name;
    const meta = document.createElement("div");
    meta.className = "file-item-meta";
    meta.textContent = formatFileSize(item.size);
    const track = document.createElement("div");
    track.className = "file-item-progress";
    const bar = document.createElement("div");
    bar.className = "file-item-progress-bar";
    track.appendChild(bar);
    body.appendChild(name);
    body.appendChild(meta);
    body.appendChild(track);

    const icon = document.createElement("div");
    icon.className = "file-item-icon";
    const i = document.createElement("i");
    i.className = "ri-movie-2-fill";
    icon.appendChild(i);
    row.appendChild(icon);
    row.appendChild(body);

    const right = document.createElement("div");
    right.className = "file-item-right";
    const badge = document.createElement("span");
    badge.className = `file-badge badge-${item.status}`;
    badge.textContent = getStatusLabel(item.status);
    right.appendChild(badge);

    if (item.status === "pending" && currentFlowState !== "patching") {
      const rm = document.createElement("button");
      rm.className = "file-remove-btn";
      const rmIcon = document.createElement("i");
      rmIcon.className = "ri-close-fill";
      rm.appendChild(rmIcon);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedFiles.splice(idx, 1);
        if (selectedFiles.length === 0) currentFlowState = "idle";
        renderFileList();
        updatePatchButton();
      });
      right.appendChild(rm);
    }

    row.appendChild(right);
    fileListEl.appendChild(row);
  });
}

async function addFiles(fileList) {
  if (processingFiles || currentFlowState === "patching") return;
  processingFiles = true;
  try {
    const files = Array.from(fileList);
    if (currentFlowState === "completed") {
      selectedFiles = [];
      currentFlowState = "idle";
      setLogCopyVisible(false);
    }
    for (const f of files) {
      if (!isSupportedFile(f)) continue;
      if (selectedFiles.some(s => s.name === f.name && s.size === f.size)) {
        logMessage(`Duplicate: "${f.name}" skipped.`, "warning");
        continue;
      }
      selectedFiles.push({
        file: f,
        name: f.name,
        size: f.size,
        status: "pending",
        patchedBuffer: null,
        outputName: null,
        mimeType: null,
        checked: true,
      });
    }
    renderFileList();
    updatePatchButton();
  } finally {
    processingFiles = false;
  }
}

function updatePatchButton() {
  const failed = selectedFiles.filter(f => f.status === "error");
  if (failed.length > 0) {
    patchBtn.disabled = false;
    patchBtn.querySelector("span").textContent = `Retry Failed (${failed.length})`;
    return;
  }

  if (currentFlowState === "completed") {
    const checked = selectedFiles.filter(f => f.status === "success" && f.checked && f.patchedBuffer).length;
    patchBtn.disabled = checked === 0;
    patchBtn.querySelector("span").textContent = checked > 0 ? `Download Selected (${checked})` : "Patch Videos";
  } else {
    const pending = selectedFiles.filter(f => f.status === "pending").length;
    patchBtn.disabled = pending === 0 || currentFlowState === "patching";
    patchBtn.querySelector("span").textContent = pending > 0 ? `Patch Videos (${pending})` : "Patch Videos";
  }
}

async function renderHistoryList() {
  const records = await getAllRecords();
  historyList.innerHTML = "";
  historyBadge.textContent = records.length;

  if (records.length === 0) {
    historyList.innerHTML = `<div class="history-item-empty">No history records found</div>`;
    return;
  }

  for (const record of records) {
    const item = document.createElement("div");
    item.className = "history-item";

    const thumb = document.createElement("div");
    thumb.className = "history-thumbnail";
    if (record.thumbnail?.startsWith(SAFE_THUMBNAIL_PREFIX)) {
      const img = document.createElement("img");
      img.src = record.thumbnail;
      img.alt = "preview";
      thumb.appendChild(img);
    } else {
      const icon = document.createElement("i");
      icon.className = "ri-movie-2-fill";
      thumb.appendChild(icon);
    }

    const body = document.createElement("div");
    body.className = "history-item-body";
    const name = document.createElement("div");
    name.className = "history-item-name";
    name.textContent = record.name;
    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = `${formatFileSize(record.size)} • ${new Date(record.timestamp).toLocaleTimeString()}`;
    body.appendChild(name);
    body.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "history-item-actions";

    const dlBtn = document.createElement("button");
    dlBtn.className = "history-btn";
    const dlIcon = document.createElement("i");
    dlIcon.className = "ri-download-fill";
    dlBtn.appendChild(dlIcon);
    dlBtn.addEventListener("click", () => {
      downloadBuffer(record.blob || record.buffer, record.name, record.mimeType || "video/mp4");
    });

    const delBtn = document.createElement("button");
    delBtn.className = "history-btn history-btn-delete";
    const delIcon = document.createElement("i");
    delIcon.className = "ri-delete-bin-fill";
    delBtn.appendChild(delIcon);
    delBtn.addEventListener("click", async () => {
      await deleteRecord(record.id);
      await renderHistoryList();
    });

    actions.appendChild(dlBtn);
    actions.appendChild(delBtn);

    item.appendChild(thumb);
    item.appendChild(body);
    item.appendChild(actions);
    historyList.appendChild(item);
  }
}

// ============================================================
//  FFMPEG ENCODER (LOKAL) — Menggunakan parameter dari content.js
// ============================================================
let ffmpegInstance = null;

async function destroyFFmpeg() {
  if (!ffmpegInstance) return;
  try { await ffmpegInstance.terminate(); } catch {}
  ffmpegInstance = null;
}

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  ffmpegInstance = new FFmpeg();
  const isMultiThread = typeof SharedArrayBuffer !== "undefined" && window.crossOriginIsolated;
  const repoBase = location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1) || "/";
  const absBase = new URL(repoBase, location.href).href;
  const baseURL = `${absBase}${isMultiThread ? "ffmpeg-core-mt" : "ffmpeg-core"}`;
  ffmpegInstance.on("progress", ({ progress }) => setProgress(Math.round(progress * 100)));
  await ffmpegInstance.load({
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
    classWorkerURL: `${absBase}ffmpeg-worker/worker.js`,
    ...(isMultiThread ? { workerURL: `${baseURL}/ffmpeg-core.worker.js` } : {})
  });
  return ffmpegInstance;
}

async function encodeVideoWithFFmpeg(file, targetRes = 1080) {
  const { fetchFile } = await import("@ffmpeg/util");
  let instance;
  try {
    instance = await getFFmpeg();
    const ext = isMovFile(file) ? ".mov" : ".mp4";
    const inputName = `input${ext}`;
    const outputName = "output.mp4";

    await instance.writeFile(inputName, await fetchFile(file));

    // Parameter encoding dari content.js:
    // preset: 'protect' → kualitas tinggi (CRF 18, preset medium)
    // encoder: 'off' → tetap pakai H.264 (libx264)
    // audioQuality: '256k' → audio bitrate 256k
    // Juga tambahkan faststart dan timescale untuk TikTok
    const filter = `scale=${targetRes}:-2:flags=lanczos`;
    const args = [
      "-y", "-loglevel", "error",
      "-i", inputName,
      "-vf", filter,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "256k",
      "-movflags", "+faststart",
      "-video_track_timescale", "90000",
      outputName
    ];

    logMessage("Encoding video with high quality (CRF 18, 256k audio)...", "info");
    showProgress();
    await instance.exec(args);

    const data = await instance.readFile(outputName);
    await instance.deleteFile(inputName).catch(() => {});
    await instance.deleteFile(outputName).catch(() => {});
    await destroyFFmpeg();

    if (!data || data.length < 100) throw new Error("Encoded output is empty.");
    return data.buffer;
  } catch (err) {
    await destroyFFmpeg();
    throw err;
  }
}

// ============================================================
//  PATCH SINGLE FILE (menggunakan FFmpeg lokal)
// ============================================================
async function patchSingleFile(item) {
  const resolutionEl = document.getElementById("outputResolution");
  const targetRes = resolutionEl ? Number.parseInt(resolutionEl.value, 10) : 1080;

  // Encode video dengan FFmpeg
  const buffer = await encodeVideoWithFFmpeg(item.file, targetRes);
  if (isCancelled) throw new Error("Cancelled");

  // Ambil thumbnail dari hasil encode
  let thumbnail = null;
  try {
    const blob = new Blob([buffer], { type: "video/mp4" });
    thumbnail = await captureVideoFrame(blob);
  } catch {}
  if (!thumbnail) {
    try { thumbnail = await captureVideoFrame(item.file); } catch {}
  }

  return {
    finalBuffer: buffer,
    outputName: getOutputFilename(item.file),
    mimeType: "video/mp4",
    prePatchBuffer: null,
    movThumbnail: thumbnail,
  };
}

// ============================================================
//  EVENT HANDLER PATCH / DOWNLOAD
// ============================================================
patchBtn.addEventListener("click", async () => {
  const failedItems = selectedFiles.filter(f => f.status === "error");
  if (failedItems.length > 0) {
    for (const item of failedItems) {
      item.status = "pending";
      item.checked = true;
      item.patchedBuffer = null;
    }
    currentFlowState = "idle";
    setLogCopyVisible(false);
    renderFileList();
    updatePatchButton();
  }

  if (currentFlowState === "completed") {
    const checked = selectedFiles.filter(f => f.status === "success" && f.checked && f.patchedBuffer);
    if (checked.length > 0) {
      for (const item of checked) {
        downloadBuffer(item.patchedBuffer, item.outputName, item.mimeType);
        item.patchedBuffer = null;
        item.file = null;
        item.checked = false;
        await new Promise(r => setTimeout(r, 300));
      }
      logMessage("Download completed.", "success");
      renderFileList();
      updatePatchButton();
      return;
    }
  }

  const pendingItems = selectedFiles.filter(f => f.status === "pending");
  if (pendingItems.length === 0) return;

  currentFlowState = "patching";
  setLogCopyVisible(false);
  clearLog();
  patchBtn.disabled = true;
  clearBtn.innerText = "Cancel";
  clearBtn.disabled = false;
  showProgress();
  isCancelled = false;

  let successCount = 0;
  for (let i = 0; i < pendingItems.length; i++) {
    if (isCancelled) break;
    const item = pendingItems[i];
    setProgress(Math.round((i / pendingItems.length) * 100));

    item.status = "processing";
    renderFileList();
    logMessage(`[${i+1}/${pendingItems.length}] ${item.name}`, "info");

    try {
      const result = await patchSingleFile(item);
      if (isCancelled) { item.status = "pending"; break; }
      item.status = "success";
      item.patchedBuffer = result.finalBuffer;
      item.outputName = result.outputName;
      item.mimeType = result.mimeType;
      item.checked = true;
      successCount++;

      // Simpan ke riwayat
      try {
        const blob = new Blob([result.finalBuffer], { type: result.mimeType });
        let thumb = result.movThumbnail;
        if (!thumb) thumb = await captureVideoFrame(blob);
        await saveRecord({
          id: crypto.randomUUID(),
          name: result.outputName,
          size: result.finalBuffer.byteLength,
          timestamp: Date.now(),
          thumbnail: thumb,
          blob,
          mimeType: result.mimeType,
        });
        await renderHistoryList();
      } catch (dbErr) {
        logMessage(`  DB save error: ${dbErr.message}`, "warning");
      }

      if (i < pendingItems.length - 1) {
        await new Promise(r => setTimeout(r, 600));
        if (isCancelled) break;
      }
    } catch (err) {
      if (isCancelled) { item.status = "pending"; break; }
      item.status = "error";
      item.checked = false;
      logMessage(`  Error: ${err.message}`, "error");
    }
    renderFileList();
  }

  if (isCancelled) {
    for (const item of pendingItems) {
      if (item.status === "processing" || item.status === "pending") item.status = "pending";
    }
    currentFlowState = "idle";
    setProgress(0);
    hideProgress();
    clearBtn.innerText = "Clear";
    logMessage("Cancelled.", "warning");
    renderFileList();
    updatePatchButton();
    return;
  }

  currentFlowState = "completed";
  setProgress(100);
  hideProgress();
  setLogCopyVisible(true);
  logMessage(`Done. ${successCount}/${pendingItems.length} file(s) processed.`, "success");
  clearBtn.innerText = "Clear";
  clearBtn.disabled = false;
  renderFileList();
  updatePatchButton();
});

// ============================================================
//  EVENT LISTENER LAINNYA (drop, drag, click, dll.)
// ============================================================
dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) addFiles(e.target.files);
  fileInput.value = "";
});

clearBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (currentFlowState === "patching") {
    isCancelled = true;
    await destroyFFmpeg();
    logMessage("Cancelling...", "warning");
    return;
  }
  selectedFiles = [];
  currentFlowState = "idle";
  setLogCopyVisible(false);
  hideProgress();
  clearLog();
  renderFileList();
  updatePatchButton();
});

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
});

historyHeader.addEventListener("click", () => {
  historyHeader.parentElement.classList.toggle("collapsed");
});

clearHistoryBtn.addEventListener("click", async () => {
  await clearAllRecords();
  await renderHistoryList();
});

// ============================================================
//  MODAL TIKTOK & VFI (dummy, tidak dipakai)
// ============================================================
const vfiModal = document.getElementById("vfiModal");
const enableInterpolation = document.getElementById("enableInterpolation");
if (enableInterpolation) {
  enableInterpolation.checked = false;
  enableInterpolation.disabled = true;
  enableInterpolation.parentElement.style.opacity = "0.5";
}
// (Tidak perlu VFI, jadi kita nonaktifkan)

// ============================================================
//  INISIALISASI
// ============================================================
initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) initChangelog(changelogContainer);

// Popup follow (tetap)
window.addEventListener("load", function () {
  const popup = document.getElementById("popupFollow");
  if (!popup) return;
  const closeBtn = document.getElementById("popupClose");
  const laterBtn = document.getElementById("popupLater");
  const closePopup = () => popup.classList.remove("active");
  if (closeBtn) closeBtn.addEventListener("click", closePopup);
  if (laterBtn) laterBtn.addEventListener("click", closePopup);
  popup.addEventListener("click", (e) => { if (e.target === popup) closePopup(); });
  setTimeout(() => popup.classList.add("active"), 400);
});