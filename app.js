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
    videoBitrate: "12M",      // 12 Mbps — sweet spot TikTok (8–12 Mbps)
    maxrate: "14M",           // cap puncak, bukan 15M (sinkron sweet spot)
    bufsize: "28M",
    gopSeconds: 2,            // keyframe tiap 2 detik (48/60/120 frame sesuai fps)
    audioBitrate: "256k",     // 256 kbps AAC
    preset: "medium",         // Balance speed vs quality
    codec: "libx264",         // H.264 — TikTok pass-through paling bersih
    audioCodec: "aac",
    profile: "high",
    level: "4.2",
    pixFmt: "yuv420p",        // 8-bit — jangan 10-bit/HDR (menimbulkan banding)
    bframes: 2,
    refs: 4,
    movflags: "+faststart",
    threads: 0,
    // Color metadata BT.709 — mencegah warna pudar setelah transcode
    colorPrimaries: "bt709",
    colorTrc: "bt709",
    colorSpace: "bt709",
    // Container fuzz (Maska hybrid): fake samples + tkhd/mvhd duration
    injectEnabled: true,
    injectPercent: 18,        // Maska: percent=18 → inflasi 5.56x
    injectAddTime: 0.3,       // Maska: durDelta = floor(0.3 × mvhd_timescale)
    // Hybrid Method (Maska x Editing News): auto 1080p + container fuzz
    hybridEnabled: true,
    hybridWidth: 1080,
    hybridHeight: 1920,
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

        // Deteksi fps asli dari tabel stts — untuk GOP 2 detik (riset 2026)
        const s = TIKTOK_SETTINGS;
        const fpsInfo = detectFps(inputBytes);
        const srcFps = fpsInfo?.fps || null;
        const gopSize = Math.max(
            24,
            Math.round((srcFps || 30) * s.gopSeconds),
        );
        if (srcFps) {
            logMessage(
                `  Source FPS: ${srcFps} — GOP ${gopSize} frame (${s.gopSeconds}s)`,
                "info",
            );
        }

        // Build filter — NO scale, NO fps change
        // Cuma dipakai kalau fallback re-encode (codec tidak kompatibel utk copy)
        const filter = `eq=saturation=1.05:contrast=1.02`;

        // ============================================================
        //  MODE CEPAT: STREAM COPY (TANPA RE-ENCODE)
        //  Resolusi & fps 100% asli — proses hitungan detik.
        //  (konsep: NoBlur Inflate mode / midx encoder=off / AST stage 1)
        // ============================================================
        const copyArgs = [
            "-y",
            "-loglevel",
            "error",
            "-i",
            inputName,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            outputName,
        ];

        // Fallback re-encode (hanya jika stream copy gagal, mis. codec
        // tidak kompatibel MP4 seperti WebM/ProRes di dalam MOV)
        const encodeArgs = [
            "-y",
            "-loglevel",
            "error",
            "-i",
            inputName,
            "-vf",
            filter,
            "-c:v",
            s.codec,
            "-preset",
            s.preset,
            "-profile:v",
            s.profile,
            "-level",
            s.level,
            "-pix_fmt",
            s.pixFmt,
            "-b:v",
            s.videoBitrate,
            "-maxrate",
            s.maxrate,
            "-bufsize",
            s.bufsize,
            "-g",
            String(gopSize),
            "-bf",
            String(s.bframes),
            "-refs",
            String(s.refs),
            // Color metadata BT.709 — hasil transcode TikTok tidak pudar
            "-color_primaries",
            s.colorPrimaries,
            "-color_trc",
            s.colorTrc,
            "-colorspace",
            s.colorSpace,
            // Strip semua metadata — container "bersih" (AST Engine stage 1)
            "-map_metadata",
            "-1",
            // NO -vf scale, NO -r fps — tetap asli
            "-c:a",
            s.audioCodec,
            "-b:a",
            s.audioBitrate,
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            s.movflags,
            "-threads",
            String(s.threads),
            outputName,
        ];

        let usedHybrid = false;
        let usedEncode = false;
        let ret = null;

        // ============================================================
        //  HYBRID METHOD (Maska x Editing News):
        //  "Running hybrid fuzz…" + "Downscaling to 1080p…"
        //  - Auto 1080p: semua resolusi → 1080x1920 (lanczos, tanpa distorsi)
        //  - FPS TETAP ASLI (tidak diubah, tidak ditambah)
        //  - Lalu container fuzz (fake samples) di tahap berikutnya
        //  - Jika video SUDAH 1080x1920 → stream copy (cepat, tanpa re-encode)
        // ============================================================
        const hybridArgs = [
            "-y",
            "-loglevel",
            "error",
            "-i",
            inputName,
            "-vf",
            `scale=${s.hybridWidth}:${s.hybridHeight}:force_original_aspect_ratio=decrease:flags=${s.hybridFlags},pad=${s.hybridWidth}:${s.hybridHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
            "-c:v",
            s.codec,
            "-preset",
            s.preset,
            "-profile:v",
            s.profile,
            "-level",
            s.level,
            "-pix_fmt",
            s.pixFmt,
            "-b:v",
            s.videoBitrate,
            "-maxrate",
            s.maxrate,
            "-bufsize",
            s.bufsize,
            "-g",
            String(gopSize),
            "-bf",
            String(s.bframes),
            "-refs",
            String(s.refs),
            // Color metadata BT.709 — hasil transcode TikTok tidak pudar
            "-color_primaries",
            s.colorPrimaries,
            "-color_trc",
            s.colorTrc,
            "-colorspace",
            s.colorSpace,
            // Strip semua metadata — container "bersih" (AST Engine stage 1)
            "-map_metadata",
            "-1",
            // NO -r — fps tetap asli
            "-c:a",
            s.audioCodec,
            "-b:a",
            s.audioBitrate,
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            s.movflags,
            "-threads",
            String(s.threads),
            outputName,
        ];

        const already1080 =
            sourceWidth === s.hybridWidth && sourceHeight === s.hybridHeight;

        let ffmpegLog = "";
        const logHandler = ({ message }) => {
            ffmpegLog += message + "\n";
        };
        instance.on("log", logHandler);

        showProgress();
        progressBar.classList.add("indeterminate");

        if (s.hybridEnabled && !already1080) {
            // --- jalur hybrid: scale ke 1080p (fps asli) ---
            logMessage(
                `Hybrid (Editing News): scale ${sourceWidth || "?"}x${sourceHeight || "?"} → ${s.hybridWidth}x${s.hybridHeight}, fps asli...`,
                "info",
            );
            ret = await instance.exec(hybridArgs);
            if (ret === 0) {
                usedHybrid = true;
            } else {
                logMessage(
                    "  Hybrid scale gagal — fallback stream copy...",
                    "warning",
                );
                ffmpegLog = "";
                ret = await instance.exec(copyArgs);
                if (ret !== 0) {
                    logMessage(
                        "  Stream copy gagal (codec tidak kompatibel) — fallback re-encode...",
                        "warning",
                    );
                    ffmpegLog = "";
                    ret = await instance.exec(encodeArgs);
                    usedEncode = true;
                    logMessage(
                        `Encoding: keep ${sourceWidth}x${sourceHeight}, keep original fps, H.264 High ${s.videoBitrate}, BT.709...`,
                        "info",
                    );
                }
            }
        } else {
            // --- video sudah 1080x1920 (atau hybrid off) → stream copy cepat ---
            logMessage(
                `Fast mode: stream copy — ${sourceWidth || "?"}x${sourceHeight || "?"} sudah 1080p, fps asli...`,
                "info",
            );
            ret = await instance.exec(copyArgs);
            if (ret !== 0) {
                logMessage(
                    "  Stream copy gagal (codec tidak kompatibel) — fallback re-encode...",
                    "warning",
                );
                ffmpegLog = "";
                ret = await instance.exec(encodeArgs);
                usedEncode = true;
                logMessage(
                    `Encoding: keep ${sourceWidth}x${sourceHeight}, keep original fps, H.264 High ${s.videoBitrate}, BT.709...`,
                    "info",
                );
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
                "  OK: Hybrid (Editing News) — auto 1080p, fps asli, siap di-fuzz",
                "success",
            );
        } else if (!usedEncode) {
            logMessage(
                "  OK: stream copy — video TIDAK di-re-encode (resolusi & fps asli)",
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
                    "Running hybrid fuzz (fake samples + duration fuzz)...",
                    "info",
                );
                const injected = injectContainer(data, {
                    percent: s.injectPercent,
                    addTime: s.injectAddTime,
                });
                if (injected && injected.data && injected.data.length > 100) {
                    data = injected.data;
                    logMessage(
                        `  Fuzz OK: ${injected.info.fakeSamples} fake samples (${injected.info.scale}x, percent ${injected.info.percent}), durDelta=${injected.info.durDelta} (mvhd ts ${injected.info.mvhdTimescale})`,
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

    logMessage("=== HYBRID METHOD (Maska x Editing News) ===", "info");
    logMessage("Auto 1080p: semua resolusi → 1080x1920 (lanczos)", "info");
    logMessage("Remux: -map 0:v:0 -map 0:a? -c:v copy -c:a copy", "info");
    logMessage("Fuzz: fake samples 5.56x + duration fuzz (mdhd/tkhd/mvhd/stts)", "info");
    logMessage("Upload via TikTok Studio + aktifkan 'Allow high-quality uploads'", "info");
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
