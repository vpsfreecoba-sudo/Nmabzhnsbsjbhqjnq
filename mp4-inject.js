// ============================================================
//  MP4 CONTAINER FUZZER — MIDX + MASKA HYBRID (VERIFIED)
//  ============================================================
//  Dua mode, keduanya DIVERIFIKASI dengan output nyata:
//
//  MODE "midx" (default) — dari API api.midx.app (inject-v1/protect),
//  dianalisis dgn mengupload video uji ke server midx & membandingkan
//  struktur output aslinya:
//    1. Faststart remux (moov ke depan)
//    2. Video mdhd: timescale -> 90000, duration -> 1438646272 (0x55C00000,
//       durasi palsu sangat besar — "signature" clean export)
//    3. stts di-REWRITE jadi 1 entry (totalSamples, delta=90000/fps)
//    4. stsz: inflasi 5x (fake = real x 4, entri 8 byte)
//    5. stsc: +1 entry (realChunks+1, 1, desc)
//    6. stco: real + fake entri; SEMUA fake -> SATU dummy offset di akhir mdat
//    7. mdhd audio: duration -> 1438646272 juga (timescale tetap)
//    8. tkhd/mvhd: duration tetap (perubahan ~19ms kosmetik)
//    9. Audio chunk offsets digeser +delta moov (wajib, kalau tidak audio rusak)
//    Catatan: midx juga RE-ENCODE video & audio di server (CRF lebih rendah,
//    audio 48kHz) — di app ini re-encode dilakukan oleh tahap hybrid 1080p.
//
//  MODE "maska" — dari worker mh1-CrGkOskX.js (Bt/Ut):
//    stts asli dipertahankan + ghost entry, mdhd TIDAK diubah,
//    tkhd/mvhd +floor(addTime x mvhdTimescale), inflasi 100/percent.
//
//  Video & audio bitstream tidak disentuh oleh fuzzer (stream copy).
// ============================================================

const FAKE_SAMPLE_SIZE = 8; // byte per fake sample
const FUZZ_PERCENT = 18; // Maska: 18 -> inflasi (100/18) = 5.56x
const FUZZ_ADD_TIME = 0.3; // Maska: +30% dari mvhd timescale
// Konstanta mode midx (terverifikasi dari output api.midx.app)
const MIDX_TIMESCALE = 90000;
const MIDX_FAKE_DURATION = 1438646272; // 0x55C00000
const MIDX_MULTIPLIER = 5; // inflasi 5x

// ---------- helpers ----------
function u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    return b;
}
function u64(v) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, Math.floor(v / 4294967296));
    dv.setUint32(4, v >>> 0);
    return b;
}
function readU32(dv, off) { return dv.getUint32(off); }
function readU64(dv, off) { return dv.getUint32(off) * 4294967296 + dv.getUint32(off + 4); }

function concatBytes(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrays) { out.set(a, p); p += a.length; }
    return out;
}
function setBoxSize(b) {
    new DataView(b.buffer, b.byteOffset, 4).setUint32(0, b.length >>> 0);
}

// ---------- box parser ----------
function parseTopBoxes(data) {
    const boxes = [];
    let off = 0;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (off + 8 <= data.length) {
        let size = readU32(dv, off);
        const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
        let headerSize = 8;
        if (size === 1) {
            size = readU64(dv, off + 8);
            headerSize = 16;
        } else if (size === 0) {
            size = data.length - off;
        }
        if (size < headerSize || off + size > data.length) break;
        boxes.push({ type, start: off, size, headerSize });
        off += size;
    }
    return boxes;
}

function findBoxes(data, boxStart, boxSize, targetType) {
    const results = [];
    const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    const stack = [{ start: boxStart, size: boxSize }];
    while (stack.length) {
        const { start, size } = stack.pop();
        let off = start;
        const end = start + size;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        while (off + 8 <= end) {
            let sz = readU32(dv, off);
            const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
            let hs = 8;
            if (sz === 1) { sz = readU64(dv, off + 8); hs = 16; }
            else if (sz === 0) { sz = end - off; }
            if (sz < hs || off + sz > end) break;
            if (type === targetType) results.push({ start: off, size: sz, headerSize: hs });
            if (containerTypes.has(type) && sz > hs) stack.push({ start: off + hs, size: sz - hs });
            off += sz;
        }
    }
    return results;
}

function analyzeTracks(data, moov) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tracks = [];
    const traks = findBoxes(data, moov.start + moov.headerSize, moov.size - moov.headerSize, "trak");
    for (const trak of traks) {
        const stbl = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "stbl")[0];
        const hdlr = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "hdlr")[0];
        const mdhd = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "mdhd")[0];
        const tkhd = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "tkhd")[0];
        let handlerType = null;
        if (hdlr) {
            handlerType = String.fromCharCode(
                data[hdlr.start + hdlr.headerSize + 8],
                data[hdlr.start + hdlr.headerSize + 9],
                data[hdlr.start + hdlr.headerSize + 10],
                data[hdlr.start + hdlr.headerSize + 11],
            );
        }
        if (!stbl || !hdlr || !mdhd) continue;
        tracks.push({ trak, stbl, hdlr, mdhd, tkhd, handlerType });
    }
    return tracks;
}

// Baca mvhd: version, timescale, duration
function getMvhd(data, moov) {
    const mvhd = findBoxes(
        data,
        moov.start + moov.headerSize,
        moov.size - moov.headerSize,
        "mvhd",
    )[0];
    if (!mvhd) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const content = mvhd.start + mvhd.headerSize;
    const version = data[content];
    let off = content + 4;
    off += version === 1 ? 8 : 4; // creation
    off += version === 1 ? 8 : 4; // modification
    const timescale = readU32(dv, off);
    off += 4;
    const duration = version === 1 ? readU64(dv, off) : readU32(dv, off);
    return { version, timescale, duration, box: mvhd };
}

// Baca stts video: entries + lastDelta
function getVideoStts(data, videoTrack) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const stblStart = videoTrack.stbl.start + videoTrack.stbl.headerSize;
    const stblSize = videoTrack.stbl.size - videoTrack.stbl.headerSize;
    const stts = findBoxes(data, stblStart, stblSize, "stts")[0];
    if (!stts) return null;
    const content = stts.start + stts.headerSize;
    const count = readU32(dv, content + 4);
    const entries = [];
    let lastDelta = 1;
    for (let i = 0; i < count; i++) {
        const c = readU32(dv, content + 8 + i * 8);
        const d = readU32(dv, content + 12 + i * 8);
        entries.push([c, d]);
        if (d > 0) lastDelta = d;
    }
    return { box: stts, count, entries, lastDelta };
}

// ============================================================
//  detectFps — fps asli dari stts + mdhd (untuk log & GOP app)
// ============================================================
export function detectFps(bytes) {
    try {
        // Salinan murni — hindari Buffer view (byteOffset != 0)
        const data = new Uint8Array(
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        );
        const top = parseTopBoxes(data);
        const moov = top.find((b) => b.type === "moov");
        if (!moov) return null;
        const tracks = analyzeTracks(data, moov);
        const vt = tracks.find((t) => t.handlerType === "vide");
        if (!vt) return null;
        const st = getVideoStts(data, vt);
        if (!st) return null;
        const totalSamples = st.entries.reduce((a, e) => a + e[0], 0);
        const totalDuration = st.entries.reduce((a, e) => a + e[0] * e[1], 0);
        const mdhd = vt.mdhd;
        const content = mdhd.start + mdhd.headerSize;
        const version = data[content];
        let off = content + 4;
        off += version === 1 ? 8 : 4;
        off += version === 1 ? 8 : 4;
        const timescale = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(off);
        const seconds = timescale ? totalDuration / timescale : 1;
        const fps = seconds > 0 ? totalSamples / seconds : 30;
        if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
        return {
            fps: Math.round(fps * 100) / 100,
            timescale,
            sampleCount: totalSamples,
            lastDelta: st.lastDelta,
        };
    } catch {
        return null;
    }
}

// ============================================================
//  MAIN: fuzzContainer(bytes, { percent, addTime })
// ============================================================
export function injectContainer(bytes, opts = {}) {
    const mode = opts.mode || "midx";
    const percent = opts.percent || FUZZ_PERCENT;
    const addTime = opts.addTime !== undefined ? opts.addTime : FUZZ_ADD_TIME;
    // Selalu buat SALINAN Uint8Array murni (bukan Buffer view):
    // Buffer.slice() di Node mengembalikan view dengan byteOffset != 0,
    // yang membuat DataView(buffer) menulis di offset salah.
    const data = new Uint8Array(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const top = parseTopBoxes(data);
    const ftyp = top.find((b) => b.type === "ftyp");
    const moov = top.find((b) => b.type === "moov");
    const mdat = top.find((b) => b.type === "mdat");
    if (!moov || !mdat) throw new Error("Not a valid MP4 (moov/mdat not found)");

    const tracks = analyzeTracks(data, moov);
    const videoTrack = tracks.find((t) => t.handlerType === "vide");
    if (!videoTrack) throw new Error("Video track (hdlr 'vide') not found");

    // ---- box video stbl ----
    const stblStart = videoTrack.stbl.start + videoTrack.stbl.headerSize;
    const stblSize = videoTrack.stbl.size - videoTrack.stbl.headerSize;
    const stsz = findBoxes(data, stblStart, stblSize, "stsz")[0];
    const stsc = findBoxes(data, stblStart, stblSize, "stsc")[0];
    const stco = findBoxes(data, stblStart, stblSize, "stco")[0];
    const co64 = findBoxes(data, stblStart, stblSize, "co64")[0];
    const chunkBox = stco || co64;
    if (!stsz || !stsc || !chunkBox) throw new Error("Sample tables not found");

    // ---- baca struktur asli ----
    const stszContent = stsz.start + stsz.headerSize;
    const sampleSizeUniform = readU32(dv, stszContent + 4);
    const realSampleCount = readU32(dv, stszContent + 8);
    if (realSampleCount === 0) throw new Error("stsz has 0 samples");

    const stscContent = stsc.start + stsc.headerSize;
    const stscCount = readU32(dv, stscContent + 4);
    const stscEntries = [];
    for (let i = 0; i < stscCount; i++) {
        stscEntries.push({
            firstChunk: readU32(dv, stscContent + 8 + i * 12),
            samplesPerChunk: readU32(dv, stscContent + 12 + i * 12),
            sampleDesc: readU32(dv, stscContent + 16 + i * 12),
        });
    }
    const lastStsc = stscEntries[stscEntries.length - 1];

    const isCo64 = !!co64;
    const entrySize = isCo64 ? 8 : 4;
    const realChunkCount = readU32(dv, chunkBox.start + chunkBox.headerSize + 4);
    const chunkEntriesStart = chunkBox.start + chunkBox.headerSize + 8;
    const realChunkOffsets = [];
    for (let i = 0; i < realChunkCount; i++) {
        realChunkOffsets.push(
            isCo64
                ? readU64(dv, chunkEntriesStart + i * entrySize)
                : readU32(dv, chunkEntriesStart + i * entrySize),
        );
    }

    // ---- stts asli (untuk lastDelta) ----
    const sttsInfo = getVideoStts(data, videoTrack);
    const lastDelta = sttsInfo ? sttsInfo.lastDelta : 1;

    // ---- hitung fake count ----
    // midx: inflasi 5x total (fake = real x 4) — terverifikasi output asli
    // maska: percent=18 -> 5.56x
    const scale = mode === "midx" ? MIDX_MULTIPLIER : 100 / percent;
    const fakeCount = Math.floor(realSampleCount * scale) - realSampleCount;
    if (fakeCount <= 0) throw new Error("Video too short for fuzz");
    // 1 sample per fake chunk -> fakeChunkCount = fakeCount
    const fakeChunkCount = fakeCount;

    // ---- durDelta (hanya mode maska; midx membiarkan tkhd/mvhd tetap) ----
    const mvhdInfo = getMvhd(data, moov);
    const durDelta =
        mode === "maska"
            ? Math.floor(addTime * (mvhdInfo ? mvhdInfo.timescale : 1000))
            : 0;

    // ---- fps asli (untuk rewrite stts mode midx) ----
    const fpsInfo = detectFps(data);
    const realFps = fpsInfo ? fpsInfo.fps : 30;

    // ============================================================
    //  BANGUN BOX BARU (persis Maska)
    // ============================================================

    // ---- stts baru ----
    // midx : di-REWRITE jadi 1 entry (totalSamples, delta=90000/fps)
    // maska: entries asli dipertahankan + 1 ghost entry (fakeCount, lastDelta)
    let newStts = null;
    if (sttsInfo && sttsInfo.box) {
        const sttsBox = sttsInfo.box;
        const origCount = sttsInfo.count;
        const newEntryCount = mode === "midx" ? 1 : origCount + 1;
        newStts = new Uint8Array(sttsBox.headerSize + 8 + newEntryCount * 8);
        newStts.set(data.slice(sttsBox.start, sttsBox.start + sttsBox.headerSize));
        const nDv = new DataView(newStts.buffer);
        nDv.setUint32(8, 0); // version+flags
        nDv.setUint32(12, newEntryCount);
        let tp = 16;
        if (mode === "midx") {
            // rewrite: (totalSamples, delta=90000/fps) — persis midx
            const deltaNew = Math.max(1, Math.round(MIDX_TIMESCALE / Math.max(realFps, 1)));
            nDv.setUint32(tp, realSampleCount + fakeCount);
            nDv.setUint32(tp + 4, deltaNew);
            tp += 8;
        } else {
            for (const [c, d] of sttsInfo.entries) {
                nDv.setUint32(tp, c);
                nDv.setUint32(tp + 4, d); // delta asli, TIDAK diubah
                tp += 8;
            }
            // ghost entry: (fakeCount, lastDelta asli) — persis Maska
            nDv.setUint32(tp, fakeCount);
            nDv.setUint32(tp + 4, lastDelta);
            tp += 8;
        }
        setBoxSize(newStts);
    }

    // ---- stsz baru: asli + fakeCount entri 8 byte ----
    const newStsz = new Uint8Array(stsz.headerSize + 12 + (realSampleCount + fakeCount) * 4);
    newStsz.set(data.slice(stsz.start, stsz.start + stsz.headerSize));
    const nStszDv = new DataView(newStsz.buffer);
    nStszDv.setUint32(8, 0); // version+flags
    nStszDv.setUint32(12, sampleSizeUniform);
    nStszDv.setUint32(16, realSampleCount + fakeCount);
    let sp = 20;
    for (let i = 0; i < realSampleCount; i++) {
        const v = sampleSizeUniform !== 0 ? sampleSizeUniform : readU32(dv, stszContent + 12 + i * 4);
        nStszDv.setUint32(sp, v);
        sp += 4;
    }
    for (let i = 0; i < fakeCount; i++) {
        nStszDv.setUint32(sp, FAKE_SAMPLE_SIZE);
        sp += 4;
    }
    setBoxSize(newStsz);

    // ---- stsc baru: asli + 1 entry (realChunkCount+1, 1, desc) ----
    const newStsc = new Uint8Array(stsc.headerSize + 8 + (stscCount + 1) * 12);
    newStsc.set(data.slice(stsc.start, stsc.start + stsc.headerSize));
    const nStscDv = new DataView(newStsc.buffer);
    nStscDv.setUint32(8, 0);
    nStscDv.setUint32(12, stscCount + 1);
    let scp = 16;
    for (const e of stscEntries) {
        nStscDv.setUint32(scp, e.firstChunk);
        nStscDv.setUint32(scp + 4, e.samplesPerChunk);
        nStscDv.setUint32(scp + 8, e.sampleDesc);
        scp += 12;
    }
    nStscDv.setUint32(scp, realChunkCount + 1);
    nStscDv.setUint32(scp + 4, 1); // 1 sample per fake chunk (Maska)
    nStscDv.setUint32(scp + 8, lastStsc.sampleDesc);
    scp += 12;
    setBoxSize(newStsc);

    // ---- stco/co64 baru: real + fake, fake -> SATU offset (isi nanti) ----
    const newChunkCount = realChunkCount + fakeChunkCount;
    const newChunkBox = new Uint8Array(chunkBox.headerSize + 8 + newChunkCount * entrySize);
    newChunkBox.set(data.slice(chunkBox.start, chunkBox.start + chunkBox.headerSize));
    const nChunkDv = new DataView(newChunkBox.buffer);
    nChunkDv.setUint32(8, 0);
    nChunkDv.setUint32(12, newChunkCount);
    setBoxSize(newChunkBox);
    // real offsets diisi setelah delta moov diketahui (sementara 0)

    // ---- tkhd/mvhd: duration += durDelta (fixed-size patch) ----
    const fuzzPatches = new Map();
    for (const t of tracks) {
        if (t.tkhd) {
            const content = t.tkhd.start + t.tkhd.headerSize;
            const version = data[content];
            let off = content + 4;
            off += version === 1 ? 8 : 4; // creation
            off += version === 1 ? 8 : 4; // modification
            off += 4; // track_ID
            off += 4; // reserved
            const patch = data.slice(t.tkhd.start, t.tkhd.start + t.tkhd.size);
            const pDv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
            const rel = off - t.tkhd.start;
            if (version === 1) {
                pDv.setBigUint64(rel, BigInt(readU64(dv, off) + durDelta), false);
            } else {
                pDv.setUint32(rel, (readU32(dv, off) + durDelta) >>> 0, false);
            }
            fuzzPatches.set(t.tkhd.start, patch);
        }
    }
    if (mvhdInfo) {
        const mvhd = mvhdInfo.box;
        const content = mvhd.start + mvhd.headerSize;
        const version = data[content];
        let off = content + 4;
        off += version === 1 ? 8 : 4;
        off += version === 1 ? 8 : 4;
        off += 4; // timescale
        const patch = data.slice(mvhd.start, mvhd.start + mvhd.size);
        const pDv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
        const rel = off - mvhd.start;
        if (version === 1) {
            pDv.setBigUint64(rel, BigInt(readU64(dv, off) + durDelta), false);
        } else {
            pDv.setUint32(rel, (readU32(dv, off) + durDelta) >>> 0, false);
        }
        fuzzPatches.set(mvhd.start, patch);
    }

    // ---- patch hdlr (VideoHandler/SoundHandler) & mdhd lang 'und' ----
    function patchHdlr(box, name) {
        const content = data.slice(box.start + box.headerSize, box.start + box.size);
        const nameStart = 24;
        const newContent = new Uint8Array(nameStart + name.length + 1);
        newContent.set(content.slice(0, nameStart));
        for (let i = 0; i < name.length; i++) newContent[nameStart + i] = name.charCodeAt(i);
        newContent[nameStart + name.length] = 0;
        const rebuilt = concatBytes([data.slice(box.start, box.start + box.headerSize), newContent]);
        setBoxSize(rebuilt);
        return rebuilt;
    }
    // mode midx: ubah timescale (video -> 90000) & duration -> MIDX_FAKE_DURATION
    // (audio: duration -> MIDX_FAKE_DURATION, timescale tetap — persis output midx)
    // mode maska: hanya lang 'und', durasi TIDAK diubah (penting utk audio!)
    function patchMdhd(box, isVideo) {
        const content = data.slice(box.start + box.headerSize, box.start + box.size);
        const version = content[0];
        const dvIn = new DataView(content.buffer, content.byteOffset, content.byteLength);
        let off = 4;
        off += version === 1 ? 8 : 4; // creation
        off += version === 1 ? 8 : 4; // modification
        const tsOff = off;
        off += 4; // timescale
        const durOff = off;
        off += version === 1 ? 8 : 4; // duration
        const langOff = off;
        const newContent = content.slice();
        const nDv = new DataView(newContent.buffer);
        if (mode === "midx") {
            if (isVideo) {
                nDv.setUint32(tsOff, MIDX_TIMESCALE); // 90000
            }
            if (version === 1) {
                nDv.setBigUint64(durOff, BigInt(MIDX_FAKE_DURATION));
            } else {
                nDv.setUint32(durOff, MIDX_FAKE_DURATION);
            }
        }
        newContent[langOff] = 0x55;
        newContent[langOff + 1] = 0xc4;
        const rebuilt = concatBytes([data.slice(box.start, box.start + box.headerSize), newContent]);
        setBoxSize(rebuilt);
        return rebuilt;
    }

    // ============================================================
    //  REBUILD moov (rekursif) — 2 pass
    // ============================================================
    const moovContentStart = moov.start + moov.headerSize;
    const moovContentEnd = moov.start + moov.size;

    // Geser offset SEMUA stco/co64 di track lain (audio dll) mengikuti
    // relokasi mdat. Rumus yang benar (berlaku baik moov di depan maupun
    // di belakang):
    //   offsetBaru = (offsetLama - mdatDataStartLama) + mdatDataStartBaru
    // (pakai "+delta" saja salah kalau moov pindah posisi relatif thd mdat)
    function buildOtherChunkPatches(mdatShift) {
        const patches = new Map();
        const moovContentSize = moov.size - moov.headerSize;
        const allStco = findBoxes(data, moovContentStart, moovContentSize, "stco");
        const allCo64 = findBoxes(data, moovContentStart, moovContentSize, "co64");
        for (const box of [...allStco, ...allCo64]) {
            if (box.start === chunkBox.start) continue; // video sudah di-handle
            const is64 = box.type === "co64";
            const es = is64 ? 8 : 4;
            const content = box.start + box.headerSize;
            const count = readU32(dv, content + 4);
            if (count === 0) continue;
            const patch = data.slice(box.start, box.start + box.size);
            const pDv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
            const relStart = content + 8 - box.start;
            for (let i = 0; i < count; i++) {
                const rel = relStart + i * es;
                const abs = content + 8 + i * es;
                const orig = is64 ? readU64(dv, abs) : readU32(dv, abs);
                const v = orig + mdatShift;
                if (is64) {
                    pDv.setBigUint64(rel, BigInt(v), false);
                } else {
                    pDv.setUint32(rel, v >>> 0, false);
                }
            }
            patches.set(box.start, { end: box.start + box.size, bytes: patch });
        }
        return patches;
    }

    function buildReplaceMap(mdatShift) {
        const map = new Map();
        for (const [start, bytes] of fuzzPatches) {
            map.set(start, { end: start + bytes.length, bytes });
        }
        // offset audio & track lain digeser mengikuti relokasi mdat
        for (const [start, entry] of buildOtherChunkPatches(mdatShift)) {
            map.set(start, entry);
        }
        map.set(stsz.start, { end: stsz.start + stsz.size, bytes: newStsz });
        map.set(stsc.start, { end: stsc.start + stsc.size, bytes: newStsc });
        map.set(chunkBox.start, { end: chunkBox.start + chunkBox.size, bytes: newChunkBox });
        if (newStts && sttsInfo && sttsInfo.box) {
            map.set(sttsInfo.box.start, {
                end: sttsInfo.box.start + sttsInfo.box.size,
                bytes: newStts,
            });
        }
        for (const t of tracks) {
            const isVideo = t.handlerType === "vide";
            map.set(t.hdlr.start, {
                end: t.hdlr.start + t.hdlr.size,
                bytes: patchHdlr(t.hdlr, isVideo ? "VideoHandler" : "SoundHandler"),
            });
            // mdhd: mode midx -> timescale 90000 + durasi palsu;
            //       mode maska -> hanya lang 'und' (durasi tetap!)
            map.set(t.mdhd.start, {
                end: t.mdhd.start + t.mdhd.size,
                bytes: patchMdhd(t.mdhd, isVideo),
            });
        }
        return map;
    }

    const moovContainerTypes = new Set(["trak", "mdia", "minf", "stbl"]);
    function rebuildRegion(start, end, replaceMap) {
        const out = [];
        let q = start;
        while (q < end) {
            const rep = replaceMap.get(q);
            if (rep) {
                out.push(rep.bytes);
                q = rep.end;
                continue;
            }
            let sz = readU32(dv, q);
            let hs = 8;
            if (sz === 1) { sz = readU64(dv, q + 8); hs = 16; }
            else if (sz === 0) { sz = end - q; }
            if (sz < hs || q + sz > end) break;
            const type = String.fromCharCode(data[q + 4], data[q + 5], data[q + 6], data[q + 7]);
            if (moovContainerTypes.has(type) && sz > hs) {
                const inner = rebuildRegion(q + hs, q + sz, replaceMap);
                const newSize = hs + inner.length;
                const header = newSize > 0xffffffff
                    ? concatBytes([u32(1), new TextEncoder().encode(type), u64(newSize)])
                    : concatBytes([u32(newSize), new TextEncoder().encode(type)]);
                out.push(concatBytes([header, inner]));
            } else {
                out.push(data.slice(q, q + sz));
            }
            q += sz;
        }
        return concatBytes(out);
    }

    // PASS 1: hitung delta moov (untuk offset chunk)
    let replaceMap = buildReplaceMap(0);
    let newMoovContent = rebuildRegion(moovContentStart, moovContentEnd, replaceMap);
    let newMoovSize = 8 + newMoovContent.length;
    let delta = newMoovSize - moov.size;

    // ---- layout file ----
    const mdatDataStart = mdat.start + mdat.headerSize;
    const mdatDataLen = mdat.size - mdat.headerSize;

    // ftyp: major brand -> isom
    let newFtyp = null;
    if (ftyp) {
        newFtyp = data.slice(ftyp.start, ftyp.start + ftyp.size);
        const brandOff = ftyp.start + ftyp.headerSize;
        newFtyp[brandOff] = 0x69;
        newFtyp[brandOff + 1] = 0x73;
        newFtyp[brandOff + 2] = 0x6f;
        newFtyp[brandOff + 3] = 0x6d;
    }

    const preParts = [];
    for (const box of top) if (box.type === "ftyp") preParts.push(newFtyp || data.slice(box.start, box.start + box.size));
    const afterParts = [];
    for (const box of top) {
        if (box.type === "ftyp" || box.type === "moov" || box.type === "mdat") continue;
        afterParts.push(data.slice(box.start, box.start + box.size));
    }

    let newMdatOffset = 0;
    for (const b of preParts) newMdatOffset += b.length;
    newMdatOffset += newMoovSize;
    for (const b of afterParts) newMdatOffset += b.length;
    const newMdatSize = 8 + mdatDataLen + FAKE_SAMPLE_SIZE; // + dummy 8-byte
    const newMdatHeader = concatBytes([u32(newMdatSize), new TextEncoder().encode("mdat")]);
    const newMdatDataOffset = newMdatOffset + newMdatHeader.length;
    const dummyOffset = newMdatDataOffset + mdatDataLen; // posisi dummy 8-byte

    // ---- isi offset chunk (relokasi berbasis mdat) ----
    // offsetBaru = (offsetLama - mdatDataStartLama) + mdatDataStartBaru
    const mdatShift = newMdatDataOffset - mdatDataStart;
    const chunkBuf = replaceMap.get(chunkBox.start).bytes;
    const cDv = new DataView(chunkBuf.buffer);
    let cOff = 16;
    for (let i = 0; i < realChunkCount; i++) {
        const v = realChunkOffsets[i] + mdatShift;
        if (isCo64) { cDv.setUint32(cOff, Math.floor(v / 4294967296)); cDv.setUint32(cOff + 4, v >>> 0); cOff += 8; }
        else { cDv.setUint32(cOff, v >>> 0); cOff += 4; }
    }
    for (let j = 0; j < fakeChunkCount; j++) {
        // SEMUA fake chunk -> SATU offset dummy (persis Maska/midx)
        if (isCo64) { cDv.setUint32(cOff, Math.floor(dummyOffset / 4294967296)); cDv.setUint32(cOff + 4, dummyOffset >>> 0); cOff += 8; }
        else { cDv.setUint32(cOff, dummyOffset >>> 0); cOff += 4; }
    }

    // ---- rebuild moov FINAL (audio offset ikut relokasi mdat) ----
    // PENTING: isi offset video di atas menulis ke buffer chunkBox lama
    // (replaceMap.get). Rebuild pass 2 harus memakai replaceMap BARU yang
    // berisi patch audio dengan mdatShift — chunk video sudah diisi.
    replaceMap = buildReplaceMap(mdatShift);
    // pastikan chunk video yang sudah diisi tidak tertimpa: ambil dari
    // replaceMap lama (yang berisi cDv yang sudah ditulis)
    replaceMap.set(chunkBox.start, {
        end: chunkBox.start + chunkBox.size,
        bytes: newChunkBox,
    });
    newMoovContent = rebuildRegion(moovContentStart, moovContentEnd, replaceMap);
    const newMoovFinal = concatBytes([
        u32(8 + newMoovContent.length),
        new TextEncoder().encode("moov"),
        newMoovContent,
    ]);

    // ---- susun file ----
    const fileParts = [];
    for (const b of preParts) fileParts.push(b);
    fileParts.push(newMoovFinal);
    for (const b of afterParts) fileParts.push(b);
    fileParts.push(newMdatHeader);
    fileParts.push(data.slice(mdatDataStart, mdatDataStart + mdatDataLen));
    // dummy 8-byte: NAL filler H.264 valid (diabaikan decoder)
    fileParts.push(new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x0c, 0xff, 0xff, 0xff]));

    return {
        data: concatBytes(fileParts),
        info: {
            mode,
            realSamples: realSampleCount,
            fakeSamples: fakeCount,
            fakeChunks: fakeChunkCount,
            scale: Math.round(scale * 100) / 100,
            percent,
            durDelta,
            midxTimescale: mode === "midx" ? MIDX_TIMESCALE : null,
            midxFakeDuration: mode === "midx" ? MIDX_FAKE_DURATION : null,
            mvhdTimescale: mvhdInfo ? mvhdInfo.timescale : null,
            deltaBytes: delta,
            hdlr: "VideoHandler/SoundHandler",
            mdhdLang: "und",
            sttsPatched: Boolean(newStts),
            ftypBrand: "isom",
        },
    };
}
