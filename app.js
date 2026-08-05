import {
    clearAllRecords,
    deleteRecord,
    getAllRecords,
    saveRecord,
} from "./db.js";
import { initChangelog } from "./src/changelog.mjs";
import { detectFps, injectContainer } from "./mp4-inject.js";

// ============================================================
//  KONSTANTA & UI REFS
// ============================================================
const outputSuffix = "METHOD MINZHA @xd_minn";
const supportedMimeTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-quicktime",
];
const supportedExtensions = [".mp4", ".mov", ".webm"];

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

// ============================================================
//  TIKTOK OPTIMAL SETTINGS 2026 — berdasar riset encoding 2026
//  (bitrate sweet-spot 8-12 Mbps · GOP 2 detik · H.264 bukan HEVC)
// ============================================================
const TIKTOK_SETTINGS = {
    // Encoding ADAPTIF per video (ala Maska, tapi menyesuaikan tiap file):
    //   - fps asli video dideteksi -> GOP = fps x 1 detik, bitrate naik utk fps tinggi
    //   - resolusi -> areaFactor menyesuaikan bitrate (1080p = bitrate penuh)
    //   - CRF 17 + cap maxrate -> kualitas tinggi, hindari "burik"
    bitrateBase1080: 7e6,    // bitrate 1080p @30fps = 7 Mbps (rekomendasi 6–8 Mbps)
    bitrateCap: 10e6,        // JANGAN lebih dari 10 Mbps (cap keras)
    bitrateFloor: 4e6,       // batas bawah (video kecil)
    fpsFactorMin: 0.8,       // fps < 24 -> bitrate dikurangi
    fpsFactorMax: 2.0,       // fps >= 60 -> bitrate 2x
    crf: 17,                 // kualitas tinggi (anti-burik)
    keyFrameSeconds: 1,      // GOP = fps x 1 detik (Maska riil: ±1.0 s)
    audioBitrate: "192k",    // AAC
    preset: "medium",        // balance speed vs quality
    codec: "libx265",        // HEVC default (meniru file Maska riil hvc1); fallback H.264 otomatis
    encodeTimeoutMs: 90000,  // timeout deteksi hang encode (ms)
    audioCodec: "aac",
    profile: "high",
    level: "4.2",
    pixFmt: "yuv420p",
    bframes: 2,
    refs: 4,
    movflags: "+faststart",
    threads: 0,
    // Color metadata BT.709
    colorPrimaries: "bt709",
    colorTrc: "bt709",
    colorSpace: "bt709",
    // Container fuzz — mode "maska" (ts 90000, stts 2 entries, 5.56x)
    injectEnabled: true,
    injectMode: "maska",
    injectPercent: 18,
    injectAddTime: 0.3,
    // Resize ala Maska: downscale fit saja (tanpa upscale, tanpa pad)
    hybridEnabled: true,
    maxLandscapeW: 1920,
    maxLandscapeH: 1080,
    maxPortraitW: 1080,
    maxPortraitH: 1920,
    hybridFlags: "lanczos",
};

const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const METADATA_TIMEOUT_MS = 10000;
const MAX_THUMBNAIL_DIMENSION = 120;
const MOBILE_BREAKPOINT = 900;
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const PROGRESS_HIDE_DELAY_MS = 800;
const PROGRESS_FADE_DURATION_MS = 400;
const DOWNLOAD_INTERVAL_MS = 300;
const PATCH_INTERVAL_MS = 600;
const MOBILE_SCROLL_DELAY_MS = 150;
const DOWNLOAD_ANCHOR_CLEANUP_MS = 100;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";

// ============================================================
//  UTILITY
// ============================================================
let lastWidth = null;
function adjustMobileLayout() {
    const currentWidth = window.innerWidth;
    if (lastWidth !== null && currentWidth === lastWidth) return;
    lastWidth = currentWidth;

    const isMobile = currentWidth <= MOBILE_BREAKPOINT;
    const header = document.querySelector(".header");
    const panelHeader = header ? header.parentNode : null;
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
        let toastTimer = null;
        copyBtn.addEventListener("click", async () => {
            const text = [...statusLog.querySelectorAll(".log-row")]
                .map((r) => r.textContent)
                .join("\n");
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                if (copyToast) {
                    copyToast.textContent = "Copied";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
            } catch {
                if (copyToast) {
                    copyToast.textContent = "Copy failed";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
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

function clearLog() {
    statusLog.innerHTML = "";
}

function setLogCopyVisible(visible) {
    const copyBtn = document.getElementById("copyLogBtn");
    if (copyBtn) copyBtn.classList.toggle("visible", visible);
}

function setProgress(percent) {
    progressBar.style.width = `${percent}%`;
}

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
        }, PROGRESS_FADE_DURATION_MS);
    }, PROGRESS_HIDE_DELAY_MS);
}

function isSupportedFile(file) {
    const lowerName = file.name.toLowerCase();
    return (
        supportedMimeTypes.includes(file.type) ||
        supportedExtensions.some((ext) => lowerName.endsWith(ext))
    );
}

function getMimeType(file) {
    return "video/mp4";
}

function isMovFile(file) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".mov")) return true;
    if (file.type === "video/quicktime" || file.type === "video/x-quicktime")
        return true;
    return false;
}

function getOutputFilename(file) {
    return `${outputSuffix}.mp4`;
}

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
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
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
            const maxDimension = MAX_THUMBNAIL_DIMENSION;
            let width = video.videoWidth;
            let height = video.videoHeight;

            if (width > height) {
                if (width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                }
            } else {
                if (height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup(dataUrl);
        };

        video.onerror = () => {
            cleanup(null);
        };

        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, FRAME_CAPTURE_TIMEOUT_MS);

        video.src = objectUrl;
    });
}

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBuffer(data, filename, mimeType) {
    const blob =
        data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
        document.body.removeChild(anchor);
    }, DOWNLOAD_ANCHOR_CLEANUP_MS);
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, DOWNLOAD_REVOKE_DELAY_MS);
}

function getStatusLabel(status) {
    return (
        {
            pending: "Pending",
            processing: "Processing",
            success: "Done",
            error: "Error",
        }[status] || status
    );
}

// ============================================================
//  RENDER FILE LIST & HISTORY
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

    let index = 0;
    for (const item of selectedFiles) {
        const removeIndex = index;
        const row = document.createElement("div");
        row.className = `file-item status-${item.status}`;

        const checkboxWrapper = document.createElement("label");
        checkboxWrapper.className = "custom-checkbox";
        const checkboxInput = document.createElement("input");
        checkboxInput.type = "checkbox";
        checkboxInput.checked = item.checked;
        if (
            currentFlowState !== "completed" ||
            item.status !== "success" ||
            !item.patchedBuffer
        ) {
            checkboxInput.disabled = true;
        }
        checkboxInput.addEventListener("change", () => {
            item.checked = checkboxInput.checked;
            updatePatchButton();
        });
        const checkboxSpan = document.createElement("span");
        checkboxSpan.className = "checkbox-mark";
        checkboxWrapper.appendChild(checkboxInput);
        checkboxWrapper.appendChild(checkboxSpan);
        row.appendChild(checkboxWrapper);

        const body = document.createElement("div");
        body.className = "file-item-body";

        const name = document.createElement("div");
        name.className = "file-item-name";
        name.textContent = item.name;

        const meta = document.createElement("div");
        meta.className = "file-item-meta";
        meta.textContent = formatFileSize(item.size);

        const fileProgressTrack = document.createElement("div");
        fileProgressTrack.className = "file-item-progress";
        const fileProgressBar = document.createElement("div");
        fileProgressBar.className = "file-item-progress-bar";
        fileProgressTrack.appendChild(fileProgressBar);

        body.appendChild(name);
        body.appendChild(meta);
        body.appendChild(fileProgressTrack);

        const icon = document.createElement("div");
        icon.className = "file-item-icon";
        const iconEl = document.createElement("i");
        iconEl.className = "ri-movie-2-fill";
        icon.appendChild(iconEl);

        row.appendChild(icon);
        row.appendChild(body);

        const right = document.createElement("div");
        right.className = "file-item-right";

        const badge = document.createElement("span");
        badge.className = `file-badge badge-${item.status}`;
        badge.textContent = getStatusLabel(item.status);
        right.appendChild(badge);

        if (item.status === "pending" && currentFlowState !== "patching") {
            const removeBtn = document.createElement("button");
            removeBtn.className = "file-remove-btn";
            const removeIcon = document.createElement("i");
            removeIcon.className = "ri-close-fill";
            removeBtn.appendChild(removeIcon);
            removeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                removeFile(removeIndex);
            });
            right.appendChild(removeBtn);
        }

        row.appendChild(right);
        fileListEl.appendChild(row);
        index++;
    }
}

async function addFiles(fileList) {
    if (processingFiles || currentFlowState === "patching") return;
    processingFiles = true;
    try {
        const filesArray = Array.from(fileList);
        if (currentFlowState === "completed") {
            selectedFiles = [];
            currentFlowState = "idle";
            setLogCopyVisible(false);
        }
        let skipped = 0;
        for (const file of filesArray) {
            if (!isSupportedFile(file)) {
                skipped++;
                continue;
            }
            const isDupe = selectedFiles.some(
                (f) => f.name === file.name && f.size === file.size,
            );
            if (isDupe) {
                logMessage(
                    `Duplicate file detected: "${file.name}". Skipping.`,
                    "warning",
                );
                continue;
            }
            selectedFiles.push({
                file,
                name: file.name,
                size: file.size,
                status: "pending",
                patchedBuffer: null,
                outputName: null,
                mimeType: null,
                checked: true,
            });
        }
        if (skipped > 0) logMessage(`${skipped} file(s) skipped.`, "warning");
        renderFileList();
        updatePatchButton();
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            setTimeout(() => {
                const controlBox = document.querySelector(".control-box");
                if (controlBox) {
                    controlBox.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });
                }
            }, MOBILE_SCROLL_DELAY_MS);
        }
    } finally {
        processingFiles = false;
    }
}

function removeFile(index) {
    if (currentFlowState === "patching") return;
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        currentFlowState = "idle";
    }
    renderFileList();
    updatePatchButton();
}

function updatePatchButton() {
    const failedCount = selectedFiles.filter(
        (f) => f.status === "error",
    ).length;
    if (failedCount > 0) {
        patchBtn.disabled = false;
        const retryLabel =
            failedCount > 1 ? `Retry Failed (${failedCount})` : "Retry Failed";
        patchBtn.querySelector("span").textContent = retryLabel;
        return;
    }

    if (currentFlowState === "completed") {
        const checkedCount = selectedFiles.filter(
            (f) => f.status === "success" && f.checked && f.patchedBuffer,
        ).length;
        patchBtn.disabled = checkedCount === 0;
        const label =
            checkedCount > 1
                ? `Download Selected (${checkedCount})`
                : checkedCount > 0
                  ? "Download Selected"
                  : "Optimize Video";
        patchBtn.querySelector("span").textContent = label;
    } else {
        const pendingCount = selectedFiles.filter(
            (f) => f.status === "pending",
        ).length;
        patchBtn.disabled =
            pendingCount === 0 || currentFlowState === "patching";
        const label =
            pendingCount > 1
                ? `Optimize Video (${pendingCount})`
                : "Optimize Video";
        patchBtn.querySelector("span").textContent = label;
    }
}

// ============================================================
//  FFMPEG SETUP (sama kaya NoBlurr asli)
// ============================================================
let ffmpegInstance = null;

async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    try {
        await ffmpegInstance.terminate();
    } catch (err) {
        console.error("FFmpeg terminate failed:", err);
    }
    ffmpegInstance = null;
}

async function getFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;

    const { FFmpeg } = await import("@ffmpeg/ffmpeg");

    ffmpegInstance = new FFmpeg();
    logMessage("Loading FFmpeg engine...", "info");

    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const repoBase =
        location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1) ||
        "/";
    const absBase = new URL(repoBase, location.href).href;
    const baseURL = `${absBase}${isMultiThread ? "ffmpeg-core-mt" : "ffmpeg-core"}`;

    ffmpegInstance.on("progress", ({ progress }) => {
        setProgress(Math.round(progress * 100));
    });

    try {
        const loadConfig = {
            coreURL: `${baseURL}/ffmpeg-core.js`,
            wasmURL: `${baseURL}/ffmpeg-core.wasm`,
            classWorkerURL: `${absBase}ffmpeg-worker/worker.js`,
        };
        if (isMultiThread) {
            loadConfig.workerURL = `${baseURL}/ffmpeg-core.worker.js`;
        }
        await ffmpegInstance.load(loadConfig);
        logMessage("FFmpeg engine loaded successfully.", "success");
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
    return ffmpegInstance;
}

function resolveInputExtension(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) return ".mov";
    if (lower.endsWith(".webm")) return ".webm";
    return ".mp4";
}

// ============================================================
//  VIDEO INFO DETECTION — RES & FPS ASLI
// ============================================================
function getVideoInfo(file) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        let objectUrl = null;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            video.onloadedmetadata = null;
            video.onerror = null;
            video.src = "";
            video.load();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            resolve(result);
        }

        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, METADATA_TIMEOUT_MS);

        video.src = objectUrl;
        video.onloadedmetadata = () => {
            if (settled) return;
            cleanup({
                width: video.videoWidth,
                height: video.videoHeight,
                duration: video.duration,
            });
        };
        video.onerror = () => {
            cleanup(null);
        };
    });
}

// ============================================================
//  TIKTOK OPTIMIZE ENGINE 2026 — RES & FPS TETAP ASLI
// ============================================================
async function optimizeVideoForTikTok(file) {
    const { fetchFile } = await import("@ffmpeg/util");

    let instance;
    try {
        if (isCancelled) throw new Error("Cancelled");
        instance = await getFFmpeg();
        if (isCancelled) throw new Error("Cancelled");

        const ext = resolveInputExtension(file);
        const inputName = `input${ext}`;
        const outputName = "output.mp4";

        logMessage("Reading video file...", "info");
        const inputBytes = await fetchFile(file);
        await instance.writeFile(inputName, inputBytes);
        if (isCancelled) throw new Error("Cancelled");

        // Get video info — RES & FPS ASLI (parse tabel MP4, tanpa ffmpeg)
        logMessage("Analyzing video...", "info");
        const videoInfo = await getVideoInfo(file);
        let sourceWidth = 0;
        let sourceHeight = 0;

        if (videoInfo) {
            sourceWidth = videoInfo.width;
            sourceHeight = videoInfo.height;
            logMessage(
                `  Source: ${sourceWidth}x${sourceHeight} (keep original)`,
                "info",
            );
        }

        // Deteksi fps asli dari tabel stts — untuk GOP 6 detik (Maska high)
        const s = TIKTOK_SETTINGS;
        const fpsInfo = detectFps(inputBytes);
        const srcFps = fpsInfo?.fps || null;
        const gopSize = Math.max(
            24,
            Math.round((srcFps || 30) * s.keyFrameSeconds),
        );
        if (srcFps) {
            logMessage(
                `  Source FPS: ${srcFps} — GOP ${gopSize} frame (${s.keyFrameSeconds}s)`,
                "info",
            );
        }

        // ============================================================
        //  RESIZE ala Maska (jd): hanya DOWNSCALE fit, TANPA upscale,
        //  TANPA pad/black bar. n = min(1, maxW/w, maxH/h).
        //  Kalau n >= 1 → video dibiarkan apa adanya (stream copy).
        // ============================================================
        const isLandscape =
            sourceWidth !== 0 && sourceHeight !== 0 && sourceWidth >= sourceHeight;
        const maxW = isLandscape ? s.maxLandscapeW : s.maxPortraitW;
        const maxH = isLandscape ? s.maxLandscapeH : s.maxPortraitH;
        const needScale =
            sourceWidth > 0 && sourceHeight > 0 &&
            (sourceWidth > maxW || sourceHeight > maxH);
        const already1080 = !needScale;
        let scaleFilter = null;
        if (needScale) {
            const n = Math.min(maxW / sourceWidth, maxH / sourceHeight);
            const tw = Math.floor((sourceWidth * n) / 2) * 2;
            const th = Math.floor((sourceHeight * n) / 2) * 2;
            scaleFilter = `scale=${tw}:${th}:flags=${s.hybridFlags}`;
            logMessage(
                `  Resize (Maska): ${sourceWidth}x${sourceHeight} → ${tw}x${th} (downscale only)`,
                "info",
            );
        }

        // ============================================================
        //  BITRATE ADAPTIF per video (ala Maska, tapi menyesuaikan tiap file):
        //    bitrate = base1080 x areaFactor x fpsFactor
        //    areaFactor = clamp(area / (1080x1920), 0.45, 1)
        //    fpsFactor  = clamp(fps / 30, 0.8, 2)  -> 60fps = bitrate 2x
        //    dibatasi floor 3M, cap 20M
        // ============================================================
        const area = (sourceWidth || 1920) * (sourceHeight || 1080);
        const areaFactor = Math.max(
            0.45,
            Math.min(1, area / (1080 * 1920)),
        );
        const srcFpsNum = srcFps || 30;
        const fpsFactor = Math.max(
            s.fpsFactorMin,
            Math.min(s.fpsFactorMax, srcFpsNum / 30),
        );
        let bitrateBps = Math.round(
            s.bitrateBase1080 * areaFactor * fpsFactor,
        );
        bitrateBps = Math.max(s.bitrateFloor, Math.min(s.bitrateCap, bitrateBps));
        const bitrateStr =
            bitrateBps >= 1e6
                ? `${(bitrateBps / 1e6).toFixed(1)}M`
                : `${Math.round(bitrateBps / 1e3)}k`;
        const bufsizeBps = bitrateBps * 2;
        const bufsizeStr =
            bufsizeBps >= 1e6
                ? `${(bufsizeBps / 1e6).toFixed(1)}M`
                : `${Math.round(bufsizeBps / 1e3)}k`;

        // Build filter — NO scale, NO fps change
        // Cuma dipakai kalau fallback re-encode (codec tidak kompatibel utk copy)
        const filter = `eq=saturation=1.05:contrast=1.02`;

        // ============================================================
        //  MODE CEPAT: STREAM COPY (TANPA RE-ENCODE)
        //  Resolusi & fps 100% asli — proses hitungan detik.
        // ============================================================
        const copyArgs = [
            "-y", "-loglevel", "error", "-i", inputName,
            "-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", "-c:a", "copy",
            "-movflags", "+faststart", outputName,
        ];

        // ============================================================
        //  CODEC: HEVC (libx265) DEFAULT — meniru file Maska riil (hvc1),
        //  dengan FALLBACK otomatis ke H.264 (libx264) jika HEVC gagal
        //  atau hang (beberapa build ffmpeg-core menggantung saat x265).
        //  (Di browser app memakai ffmpeg-core-mt -> HEVC biasanya jalan.)
        // ============================================================
        let codec = s.codec;   // "libx265"
        let codecTag = s.codec === "libx265" ? "hvc1" : null;
        let codecProfile = s.codec === "libx265" ? "main" : s.profile;
        let codecLevel = s.codec === "libx265" ? "5.1" : s.level;

        function buildVArgs(vf) {
            const a = ["-y", "-loglevel", "error", "-i", inputName];
            if (vf) a.push("-vf", vf);
            a.push(
                "-c:v", codec,
                "-preset", s.preset,
                "-profile:v", codecProfile,
                "-level", codecLevel,
                "-pix_fmt", s.pixFmt,
                "-crf", String(s.crf),
                "-maxrate", bitrateStr,
                "-bufsize", bufsizeStr,
                "-g", String(gopSize),
                "-bf", String(s.bframes),
                "-refs", String(s.refs),
                "-color_primaries", s.colorPrimaries,
                "-color_trc", s.colorTrc,
                "-colorspace", s.colorSpace,
                "-map_metadata", "-1",
                "-c:a", s.audioCodec,
                "-b:a", s.audioBitrate,
                "-ar", "48000",
                "-ac", "2",
                "-movflags", s.movflags,
                "-threads", String(s.threads),
                outputName,
            );
            if (codecTag) {
                a.splice(a.indexOf(outputName), 0, "-tag:v", codecTag);
            }
            if (codec === "libx265") {
                a.splice(a.indexOf(outputName), 0, "-x265-params", "log-level=error");
            }
            return a;
        }

        // exec dengan timeout — deteksi hang (x265 di sebagian build)
        function execWithTimeout(args, ms) {
            return new Promise((resolve) => {
                let done = false;
                const timer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    resolve({ timeout: true });
                }, ms || s.encodeTimeoutMs || 90000);
                instance.exec(args)
                    .then((ret) => { if (!done) { done = true; clearTimeout(timer); resolve({ ret }); } })
                    .catch((err) => { if (!done) { done = true; clearTimeout(timer); resolve({ err }); } });
            });
        }

        // reload instance + tulis ulang input (dipakai setelah hang/gagal)
        async function reloadInstance() {
            await destroyFFmpegInstance();
            instance = await getFFmpeg();
            await instance.writeFile(inputName, inputBytes);
            return instance;
        }

        async function tryEncode(vf) {
            const res = await execWithTimeout(buildVArgs(vf));
            if (res.timeout) return { status: "hang" };
            if (res.err) return { status: "error", message: res.err.message };
            return { status: res.ret === 0 ? "ok" : "error", message: res.ret };
        }

        let usedHybrid = false;
        let usedEncode = false;
        let ret = null;
        let ffmpegLog = "";
        const logHandler = ({ message }) => { ffmpegLog += message + "\n"; };
        instance.on("log", logHandler);

        showProgress();
        progressBar.classList.add("indeterminate");

        // ---- jalur 1: perlu downscale (>1080p) -> High Quality HEVC (fallback H.264) ----
        if (s.hybridEnabled && !already1080) {
            logMessage(
                `Mode 1 (Hybrid Downscale): ${sourceWidth || "?"}x${sourceHeight || "?"} -> ${codec === "libx265" ? "HEVC (hvc1)" : "H.264"} ${bitrateStr} (crf ${s.crf}), GOP ${gopSize} fr, fps asli ${srcFps || "?"}...`,
                "info",
            );
            let r = await tryEncode(scaleFilter);
            if (r.status === "ok") {
                usedHybrid = true;
                ret = 0;
            } else if (r.status === "hang" || (r.status === "error" && codec === "libx265")) {
                logMessage(
                    r.status === "hang"
                        ? "  HEVC encode menggantung — fallback H.264..."
                        : "  HEVC encode gagal — fallback H.264...",
                    "warning",
                );
                codec = "libx264"; codecTag = null;
                codecProfile = s.profile; codecLevel = s.level;
                await reloadInstance();
                ffmpegLog = "";
                r = await tryEncode(scaleFilter);
                if (r.status === "ok") { usedHybrid = true; usedEncode = true; ret = 0; }
                else ret = r.status === "hang" ? -999 : (r.message ?? -1);
            } else {
                ret = r.message ?? -1;
            }
        } else {
            // ---- jalur 2: native <=1080p -> High Quality HEVC (sebagus Mode 1) ----
            logMessage(
                `Mode 2 (High Quality 1080p): ${sourceWidth || "?"}x${sourceHeight || "?"} -> ${codec === "libx265" ? "HEVC (hvc1)" : "H.264"} ${bitrateStr} (crf ${s.crf}), GOP ${gopSize} fr, fps asli ${srcFps || "?"}...`,
                "info",
            );
            let r = await tryEncode(filter);
            if (r.status === "ok") {
                usedEncode = true;
                ret = 0;
            } else if (r.status === "hang" || (r.status === "error" && codec === "libx265")) {
                logMessage(
                    r.status === "hang"
                        ? "  HEVC encode menggantung — fallback H.264..."
                        : "  HEVC encode gagal — fallback H.264...",
                    "warning",
                );
                codec = "libx264"; codecTag = null;
                codecProfile = s.profile; codecLevel = s.level;
                await reloadInstance();
                ffmpegLog = "";
                r = await tryEncode(filter);
                if (r.status === "ok") { usedEncode = true; ret = 0; }
                else {
                    logMessage("  Re-encode H.264 gagal — mencoba Stream Copy...", "warning");
                    ret = await instance.exec(copyArgs);
                }
            } else {
                logMessage("  Re-encode gagal — mencoba Stream Copy...", "warning");
                ret = await instance.exec(copyArgs);
            }
        }

        if (ret !== 0) {
            const tail = ffmpegLog.trim().split("\n").slice(-12).join("\n");
            logMessage("FFmpeg failed (exit " + ret + "):", "error");
            if (tail) logMessage(tail, "error");
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
            progressBar.classList.remove("indeterminate");
            throw new Error("FFmpeg failed with exit code " + ret);
        }
        instance.off?.("log", logHandler);

        if (usedHybrid) {
            logMessage(
                `  OK: Mode 1 (Hybrid Downscale) — ${codec === "libx265" ? "HEVC (hvc1)" : "H.264 (avc1)"} ${bitrateStr}, fps asli, siap di-fuzz`,
                "success",
            );
        } else if (usedEncode) {
            logMessage(
                `  OK: Mode 2 (High Quality 1080p) — ${codec === "libx265" ? "HEVC (hvc1)" : "H.264 (avc1)"} ${bitrateStr}, fps asli, siap di-fuzz`,
                "success",
            );
        } else {
            logMessage(
                "  OK: Stream Copy — video TIDAK di-re-encode (resolusi & fps asli)",
                "success",
            );
        }

        logMessage("Reading output file...", "info");
        let data = await instance.readFile(outputName);
        if (!data || data.length < 100) {
            logMessage("Output file is empty or invalid.", "error");
            await instance.deleteFile(inputName).catch(() => {});
            await instance.deleteFile(outputName).catch(() => {});
            progressBar.classList.remove("indeterminate");
            throw new Error("Output file is empty");
        }

        // ============================================================
        //  CONTAINER INJECT — AST-STYLE (stsz/stsc/stco fake samples)
        //  TikTok web menganggap file sudah "dioptimasi" -> skip
        //  re-kompresi destruktif. Video stream TIDAK di-re-encode lagi.
        // ============================================================
        if (s.injectEnabled) {
            try {
                logMessage(
                    `Running fuzz (mode: ${s.injectMode}) — fake samples + timescale...`,
                    "info",
                );
                const injected = injectContainer(data, {
                    mode: s.injectMode,
                    percent: s.injectPercent,
                    addTime: s.injectAddTime,
                });
                if (injected && injected.data && injected.data.length > 100) {
                    data = injected.data;
                    logMessage(
                        `  Fuzz OK [${injected.info.mode}]: ${injected.info.fakeSamples} fake samples (${injected.info.scale}x)` +
                            (injected.info.midxTimescale
                                ? `, timescale=${injected.info.midxTimescale}, mdhdDur=${injected.info.midxFakeDuration}`
                                : `, durDelta=${injected.info.durDelta}`),
                        "success",
                    );
                } else {
                    logMessage(
                        "  Hybrid fuzz skipped (invalid result), using file apa adanya.",
                        "warning",
                    );
                }
            } catch (injectError) {
                logMessage(
                    `  Hybrid fuzz gagal (${injectError.message}) — pakai file apa adanya.`,
                    "warning",
                );
            }
        }

        logMessage(
            `Done: ${formatFileSize(data.length)}`,
            "success",
        );

        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile(outputName).catch(() => {});
        progressBar.classList.remove("indeterminate");

        return {
            buffer: data.slice().buffer,
            size: data.length,
        };
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
}

// ============================================================
//  PATCH SINGLE FILE
// ============================================================
async function patchSingleFile(item) {
    logMessage(`Processing: ${item.name}`, "info");

    const result = await optimizeVideoForTikTok(item.file);
    if (isCancelled) throw new Error("Cancelled");

    // Capture thumbnail
    let thumbnail = null;
    try {
        const blob = new Blob([result.buffer], { type: "video/mp4" });
        thumbnail = await captureVideoFrame(blob);
    } catch (_) {
        thumbnail = null;
    }
    if (!thumbnail) {
        try {
            thumbnail = await captureVideoFrame(item.file);
        } catch (_) {
            thumbnail = null;
        }
    }

    return {
        finalBuffer: result.buffer,
        outputName: getOutputFilename(item.file),
        mimeType: "video/mp4",
        movThumbnail: thumbnail,
        optimizedSize: result.size,
    };
}

// ============================================================
//  DOWNLOAD SELECTED
// ============================================================
async function downloadSelectedFiles() {
    const selectedToDownload = selectedFiles.filter(
        (f) => f.status === "success" && f.checked && f.patchedBuffer,
    );
    if (selectedToDownload.length === 0) return;

    logMessage(
        `Starting download for ${selectedToDownload.length} file(s)...`,
        "info",
    );

    for (let i = 0; i < selectedToDownload.length; i++) {
        const item = selectedToDownload[i];
        logMessage(`  Downloading: ${item.outputName}`, "success");
        downloadBuffer(item.patchedBuffer, item.outputName, item.mimeType);
        item.patchedBuffer = null;
        item.file = null;
        item.checked = false;

        if (i < selectedToDownload.length - 1) {
            await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL_MS));
        }
    }

    logMessage("All downloads completed.", "success");
    renderFileList();
    updatePatchButton();
}

// ============================================================
//  EVENT LISTENERS
// ============================================================
dropZone.addEventListener("click", () => {
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
        fileInput.setAttribute("accept", "video/*");
    }
    fileInput.click();
});

fileInput.addEventListener("change", (event) => {
    if (event.target.files.length > 0) addFiles(event.target.files);
    fileInput.value = "";
});

clearBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (currentFlowState === "patching") {
        isCancelled = true;
        logMessage("Cancelling optimization...", "warning");
        await destroyFFmpegInstance();
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

dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
});

let wakeLock = null;

async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            if (currentFlowState === "patching") {
                acquireWakeLock();
            }
        });
    } catch (_) {
        wakeLock = null;
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        currentFlowState === "patching" &&
        !wakeLock
    ) {
        acquireWakeLock();
    }
});

// ============================================================
//  MAIN PATCH BUTTON HANDLER
// ============================================================
patchBtn.addEventListener("click", async () => {
    const failedItems = selectedFiles.filter((f) => f.status === "error");
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
        const checkedCount = selectedFiles.filter(
            (f) =>
                f.status === "success" && f.checked && f.patchedBuffer,
        ).length;
        if (checkedCount > 0) {
            await downloadSelectedFiles();
            return;
        }
    }

    const pendingItems = selectedFiles.filter((f) => f.status === "pending");
    if (pendingItems.length === 0) return;

    currentFlowState = "patching";
    setLogCopyVisible(false);
    clearLog();
    patchBtn.disabled = true;
    clearBtn.innerText = "Cancel";
    clearBtn.disabled = false;
    showProgress();
    await acquireWakeLock();

    isCancelled = false;
    let successCount = 0;

    logMessage("=== H.265 (HEVC) 6-8 Mbps · TikTok Studio Web ===", "info");
    logMessage("Codec: H.265 (hvc1), fallback H.264 otomatis", "info");
    logMessage("Bitrate: 6-8 Mbps target, JANGAN lebih dari 10 Mbps", "info");
    logMessage("Resize: downscale fit hanya jika > 1080p (tanpa pad)", "info");
    logMessage("Fuzz: inflasi 5.56x, timescale 90000, stts 2 entries", "info");
    logMessage("Upload via TikTok Studio (Web) agar kompresi ringan", "info");
    logMessage("", "info");

    for (let i = 0; i < pendingItems.length; i++) {
        if (isCancelled) {
            break;
        }
        const item = pendingItems[i];
        setProgress(Math.round((i / pendingItems.length) * 100));

        item.status = "processing";
        renderFileList();
        logMessage(`[${i + 1}/${pendingItems.length}] ${item.name}`, "info");

        try {
            const result = await patchSingleFile(item);
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "success";
            item.patchedBuffer = result.finalBuffer;
            item.outputName = result.outputName;
            item.mimeType = result.mimeType;
            item.checked = true;
            successCount++;

            // Save to history
            try {
                if (isCancelled) break;
                const blob = new Blob([result.finalBuffer], {
                    type: result.mimeType,
                });

                let thumbnail = result.movThumbnail;
                if (!thumbnail) {
                    try {
                        thumbnail = await captureVideoFrame(blob);
                    } catch (_) {}
                }
                if (!thumbnail) {
                    try {
                        thumbnail = await captureVideoFrame(item.file);
                    } catch (_) {}
                }

                await saveRecord({
                    id: self.crypto.randomUUID(),
                    name: result.outputName,
                    size: result.finalBuffer.byteLength,
                    timestamp: Date.now(),
                    thumbnail,
                    blob,
                    mimeType: result.mimeType,
                });
                await renderHistoryList();
            } catch (dbError) {
                logMessage(
                    `  History save skipped: ${dbError.message}`,
                    "warning",
                );
            }

            if (i < pendingItems.length - 1) {
                if (isCancelled) {
                    break;
                }
                await new Promise((r) => setTimeout(r, PATCH_INTERVAL_MS));
                if (isCancelled) {
                    break;
                }
            }
        } catch (error) {
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "error";
            item.checked = false;
            const msg =
                error instanceof Error ? error.message : String(error);
            logMessage(`  Error: ${msg}`, "error");
        }

        renderFileList();
    }

    if (isCancelled) {
        for (const item of pendingItems) {
            if (item.status === "processing" || item.status === "pending") {
                item.status = "pending";
            }
        }
        currentFlowState = "idle";
        setProgress(0);
        hideProgress();
        releaseWakeLock();
        setLogCopyVisible(false);
        clearBtn.innerText = "Clear";
        logMessage("Optimization cancelled by user.", "warning");
        renderFileList();
        updatePatchButton();
        return;
    }

    currentFlowState =
        successCount === pendingItems.length ? "completed" : "idle";
    setProgress(100);
    releaseWakeLock();
    setLogCopyVisible(true);
    logMessage(
        `Done. ${successCount}/${pendingItems.length} file(s) optimized.`,
        successCount === pendingItems.length ? "success" : "warning",
    );
    hideProgress();

    clearBtn.innerText = "Clear";
    clearBtn.disabled = false;
    renderFileList();
    updatePatchButton();
});

// ============================================================
//  HISTORY
// ============================================================
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
        meta.textContent = `${formatFileSize(record.size)} \u2022 ${new Date(
            record.timestamp,
        ).toLocaleTimeString()}`;

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
            downloadBuffer(
                record.blob || record.buffer,
                record.name,
                record.mimeType || "video/mp4",
            );
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

historyHeader.addEventListener("click", () => {
    const container = historyHeader.parentElement;
    container.classList.toggle("collapsed");
});

clearHistoryBtn.addEventListener("click", async () => {
    await clearAllRecords();
    await renderHistoryList();
});

let scrollPosition = 0;

function lockScroll() {
    scrollPosition = window.pageYOffset;
    document.body.style.overflow = "hidden";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
}

function unlockScroll() {
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollPosition);
}

// ============================================================
//  MODAL & POPUP
// ============================================================
const tiktokModal = document.getElementById("tiktokModal");
const tiktokStudioBtn = document.getElementById("tiktokStudioBtn");
const closeTiktokModalBtn = document.getElementById("closeTiktokModalBtn");
const cancelTiktokModalBtn = document.getElementById("cancelTiktokModalBtn");
const confirmTiktokBtn = document.getElementById("confirmTiktokBtn");

function isMobileDevice() {
    return (
        window.innerWidth <= MOBILE_BREAKPOINT ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
}

if (tiktokStudioBtn && tiktokModal) {
    tiktokStudioBtn.addEventListener("click", (e) => {
        if (isMobileDevice()) {
            e.preventDefault();
            tiktokModal.classList.add("active");
            lockScroll();
        }
    });

    const closeTiktokModal = () => {
        tiktokModal.classList.remove("active");
        unlockScroll();
    };

    closeTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    cancelTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    confirmTiktokBtn?.addEventListener("click", closeTiktokModal);

    tiktokModal.addEventListener("click", (e) => {
        if (e.target === tiktokModal) closeTiktokModal();
    });
}

initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) {
    initChangelog(changelogContainer);
}

// ===== POPUP FOLLOW @xd_minn =====
window.addEventListener("load", function () {
    const popup = document.getElementById("popupFollow");
    const closeBtn = document.getElementById("popupClose");
    const laterBtn = document.getElementById("popupLater");
    if (!popup) return;

    function closePopup() {
        popup.classList.remove("active");
    }

    if (closeBtn) closeBtn.addEventListener("click", closePopup);
    if (laterBtn) laterBtn.addEventListener("click", closePopup);
    popup.addEventListener("click", function (e) {
        if (e.target === popup) closePopup();
    });

    const avatarImg = document.getElementById("popupAvatar");
    const iconWrap = document.getElementById("popupIconWrap");
    if (avatarImg && iconWrap) {
        avatarImg.addEventListener("load", () => iconWrap.classList.add("has-avatar"));
        avatarImg.addEventListener("error", () => iconWrap.classList.remove("has-avatar"));
        fetch("/api/tiktok-avatar?username=xd_minn")
            .then((r) => r.json())
            .then((data) => {
                if (data && data.avatar) avatarImg.src = data.avatar;
            })
            .catch(() => {});
    }

    setTimeout(function () {
        popup.classList.add("active");
    }, 400);
});
