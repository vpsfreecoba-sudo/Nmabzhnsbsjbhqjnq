// ============================================================
//  MP4 CONTAINER INJECTOR — AST-STYLE (stsz / stsc / stco/co64)
//  ============================================================
//  Teknik: menyuntikkan "fake samples" ke tabel sample MP4 agar
//  pipeline transcoder TikTok menganggap video sudah dioptimasi
//  (skip destructive re-compression). Video stream TIDAK di-re-encode.
//
//  Referensi konsep:
//  - AST Engine (hazemethod.xyz): ffmpeg faststart remux + fake sample
//    injection ke stsz/stsc/stco + multi-pass offset recalculation
//    + hdlr/mdhd normalization.
//  - Midx Method: "inject-v1 / preset=protect / encoder=off" (server side).
//
//  Pipeline di modul ini (murni JS, tanpa dependency, browser-safe):
//    1. Parse box tree MP4 (ftyp/moov/mdat/free/...)
//    2. Temukan video trak (hdlr type 'vide')
//    3. Inflate stsz + stsc + stco/co64 dengan fake samples (8 byte/sample)
//    4. Normalisasi hdlr name -> "VideoHandler"/"SoundHandler",
//       mdhd language -> 0x55C4 ('und')
//    5. Rebuild container + hitung ulang semua offset absolut
//       (delta moov) + append padding di mdat untuk fake chunks
// ============================================================

const FAKE_SAMPLE_SIZE = 8; // byte per fake sample (sama kaya AST Engine)
const MAX_FAKE_MULTIPLIER = 8; // jangan inflate lebih dari 8x
const TARGET_IMPLIED_FPS = 240; // target fps palsu (AST: up to 400)

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

// ---------- box parser ----------
// Parsing top-level: return list of { type, start, size, headerSize }
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

// Cari trak yang handler_type-nya 'vide' atau 'soun', kembalikan { trakBox, hdlr, mdhd, stbl }
function analyzeTracks(data, moov) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tracks = [];
    const traks = findBoxes(data, moov.start + moov.headerSize, moov.size - moov.headerSize, "trak");
    for (const trak of traks) {
        const stbl = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "stbl")[0];
        const hdlr = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "hdlr")[0];
        const mdhd = findBoxes(data, trak.start + trak.headerSize, trak.size - trak.headerSize, "mdhd")[0];
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
        tracks.push({ trak, stbl, hdlr, mdhd, handlerType });
    }
    return tracks;
}

// Hitung fps asli dari stts + mdhd timescale
function getRealFps(data, stbl, mdhd) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const mdhdContent = mdhd.start + mdhd.headerSize;
    const version = data[mdhdContent];
    let off = mdhdContent + 4;
    off += version === 1 ? 8 : 4; // creation
    off += version === 1 ? 8 : 4; // modification
    const timescale = readU32(dv, off);
    off += 4;
    off += version === 1 ? 8 : 4; // duration
    // stts
    const stts = findBoxes(data, stbl.start + stbl.headerSize, stbl.size - stbl.headerSize, "stts")[0];
    if (!stts) return { fps: 30, timescale, sampleCount: 0 };
    let p = stts.start + stts.headerSize + 4;
    const entryCount = readU32(dv, p);
    p += 4;
    let totalSamples = 0;
    let totalDuration = 0;
    for (let i = 0; i < entryCount; i++) {
        const count = readU32(dv, p);
        const delta = readU32(dv, p + 4);
        totalSamples += count;
        totalDuration += count * delta;
        p += 8;
    }
    const seconds = timescale ? totalDuration / timescale : 1;
    const fps = seconds > 0 ? totalSamples / seconds : 30;
    return { fps, timescale, sampleCount: totalSamples };
}

// ============================================================
//  MAIN: injectContainer(bytes, { targetFps })
//  return Uint8Array baru (file MP4 hasil patch)
// ============================================================
export function injectContainer(bytes, opts = {}) {
    const targetFps = opts.targetFps || TARGET_IMPLIED_FPS;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const top = parseTopBoxes(data);
    const ftyp = top.find((b) => b.type === "ftyp");
    const moov = top.find((b) => b.type === "moov");
    const mdat = top.find((b) => b.type === "mdat");
    if (!moov || !mdat) {
        throw new Error("Not a valid MP4 (moov/mdat not found)");
    }

    const tracks = analyzeTracks(data, moov);
    const videoTrack = tracks.find((t) => t.handlerType === "vide");
    if (!videoTrack) {
        throw new Error("Video track (hdlr 'vide') not found");
    }

    // ---- ambil box stsz / stsc / stco/co64 dari video track ----
    const stblStart = videoTrack.stbl.start + videoTrack.stbl.headerSize;
    const stblSize = videoTrack.stbl.size - videoTrack.stbl.headerSize;
    const stsz = findBoxes(data, stblStart, stblSize, "stsz")[0];
    const stsc = findBoxes(data, stblStart, stblSize, "stsc")[0];
    const stco = findBoxes(data, stblStart, stblSize, "stco")[0];
    const co64 = findBoxes(data, stblStart, stblSize, "co64")[0];
    const chunkBox = stco || co64;
    if (!stsz || !stsc || !chunkBox) {
        throw new Error("Sample tables (stsz/stsc/stco) not found");
    }

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
    const lastEntry = stscEntries[stscEntries.length - 1];

    // hitung real chunk count dari stco
    const realChunkCount = readU32(dv, chunkBox.start + chunkBox.headerSize + 4);
    const isCo64 = !!co64;
    const entrySize = isCo64 ? 8 : 4;
    const chunkEntriesStart = chunkBox.start + chunkBox.headerSize + 8;
    const realChunkOffsets = [];
    for (let i = 0; i < realChunkCount; i++) {
        realChunkOffsets.push(isCo64
            ? readU64(dv, chunkEntriesStart + i * entrySize)
            : readU32(dv, chunkEntriesStart + i * entrySize));
    }

    // ---- hitung fps asli & jumlah fake samples ----
    const { fps: realFps } = getRealFps(data, videoTrack.stbl, videoTrack.mdhd);
    let multiplier = Math.max(2, Math.min(MAX_FAKE_MULTIPLIER, Math.round(targetFps / Math.max(realFps, 1))));
    const fakeCount = realSampleCount * (multiplier - 1);
    const fakeSamplesPerChunk = 8;
    const fakeChunkCount = Math.ceil(fakeCount / fakeSamplesPerChunk);
    const fakeCountFinal = fakeChunkCount * fakeSamplesPerChunk;

    // ---- bangun stsz baru ----
    const newStsz = new Uint8Array(stsz.headerSize + 12 + (realSampleCount + fakeCountFinal) * 4);
    newStsz.set(data.slice(stsz.start, stsz.start + stsz.headerSize)); // header box
    const nStszDv = new DataView(newStsz.buffer);
    nStszDv.setUint32(8, 0); // version+flags
    nStszDv.setUint32(12, sampleSizeUniform);
    nStszDv.setUint32(16, realSampleCount + fakeCountFinal); // entry count baru
    let sp = 20;
    for (let i = 0; i < realSampleCount; i++) {
        const v = sampleSizeUniform !== 0 ? sampleSizeUniform : readU32(dv, stszContent + 12 + i * 4);
        nStszDv.setUint32(sp, v);
        sp += 4;
    }
    for (let i = 0; i < fakeCountFinal; i++) {
        nStszDv.setUint32(sp, FAKE_SAMPLE_SIZE);
        sp += 4;
    }

    // ---- bangun stsc baru (1 entry tambahan untuk fake chunks) ----
    const newStsc = new Uint8Array(stsc.headerSize + 8 + (stscCount + 1) * 12);
    newStsc.set(data.slice(stsc.start, stsc.start + stsc.headerSize));
    const nStscDv = new DataView(newStsc.buffer);
    nStscDv.setUint32(8, 0); // version+flags
    nStscDv.setUint32(12, stscCount + 1); // entry count baru
    let scp = 16;
    for (let i = 0; i < stscCount; i++) {
        nStscDv.setUint32(scp, stscEntries[i].firstChunk);
        nStscDv.setUint32(scp + 4, stscEntries[i].samplesPerChunk);
        nStscDv.setUint32(scp + 8, stscEntries[i].sampleDesc);
        scp += 12;
    }
    const fakeFirstChunk = realChunkCount + 1;
    nStscDv.setUint32(scp, fakeFirstChunk);
    nStscDv.setUint32(scp + 4, fakeSamplesPerChunk);
    nStscDv.setUint32(scp + 8, lastEntry.sampleDesc);
    scp += 12;

    // ---- bangun stco/co64 baru ----
    const newChunkCount = realChunkCount + fakeChunkCount;
    const chunkContentSize = 8 + newChunkCount * entrySize;
    const newChunkBox = new Uint8Array(chunkBox.headerSize + chunkContentSize);
    newChunkBox.set(data.slice(chunkBox.start, chunkBox.start + chunkBox.headerSize));
    const nChunkDv = new DataView(newChunkBox.buffer);
    nChunkDv.setUint32(8, 0); // version+flags
    nChunkDv.setUint32(12, newChunkCount);
    // offset asli diisi nanti setelah delta moov diketahui; simpan dulu posisi
    let cp = 16;
    for (let i = 0; i < realChunkCount; i++) {
        if (isCo64) { nChunkDv.setUint32(cp, 0); nChunkDv.setUint32(cp + 4, 0); cp += 8; }
        else { nChunkDv.setUint32(cp, 0); cp += 4; }
    }
    const fakeChunkOffsetPos = cp; // posisi mulai fake chunk offsets (dalam buffer box baru)

    // ---- normalisasi hdlr & mdhd (copy + patch) ----
    function patchHdlr(box, name) {
        const content = data.slice(box.start + box.headerSize, box.start + box.size);
        // hdlr: version(1)+flags(3), pre_defined(4), handler_type(4), reserved(12), name...
        const nameStart = 24;
        const newContent = new Uint8Array(nameStart + name.length + 1);
        newContent.set(content.slice(0, nameStart));
        for (let i = 0; i < name.length; i++) newContent[nameStart + i] = name.charCodeAt(i);
        newContent[nameStart + name.length] = 0;
        return concatBytes([data.slice(box.start, box.start + box.headerSize), newContent]);
    }
    function patchMdhd(box) {
        const content = data.slice(box.start + box.headerSize, box.start + box.size);
        const version = content[0];
        let langOff = 4;
        langOff += version === 1 ? 8 : 4; // creation
        langOff += version === 1 ? 8 : 4; // modification
        langOff += 4; // timescale
        langOff += version === 1 ? 8 : 4; // duration
        const newContent = content.slice();
        newContent[langOff] = 0x55; // 'und' (0x55C4 big-endian)
        newContent[langOff + 1] = 0xc4;
        return concatBytes([data.slice(box.start, box.start + box.headerSize), newContent]);
    }

    // ---- rebuild moov ----
    // strategi: salin semua isi moov per-box, ganti box yang di-patch
    const moovContentStart = moov.start + moov.headerSize;
    const moovContentEnd = moov.start + moov.size;
    const patchedRegions = [];
    // tandai region yang akan diganti
    const replaceMap = new Map(); // start -> {end, bytes}
    replaceMap.set(stsz.start, { end: stsz.start + stsz.size, bytes: newStsz });
    replaceMap.set(stsc.start, { end: stsc.start + stsc.size, bytes: newStsc });
    replaceMap.set(chunkBox.start, { end: chunkBox.start + chunkBox.size, bytes: newChunkBox });
    // hdlr + mdhd untuk SEMUA track (video & audio)
    for (const t of tracks) {
        const isVideo = t.handlerType === "vide";
        replaceMap.set(t.hdlr.start, {
            end: t.hdlr.start + t.hdlr.size,
            bytes: patchHdlr(t.hdlr, isVideo ? "VideoHandler" : "SoundHandler"),
        });
        replaceMap.set(t.mdhd.start, {
            end: t.mdhd.start + t.mdhd.size,
            bytes: patchMdhd(t.mdhd),
        });
    }

    const moovParts = [];
    let p = moovContentStart;
    while (p < moovContentEnd) {
        const rep = replaceMap.get(p);
        if (rep) {
            moovParts.push(rep.bytes);
            p = rep.end;
        } else {
            // salin box utuh berikutnya (pakai parser sederhana)
            let sz = readU32(dv, p);
            let hs = 8;
            if (sz === 1) { sz = readU64(dv, p + 8); hs = 16; }
            if (sz === 0) { sz = moovContentEnd - p; }
            if (sz < hs || p + sz > moovContentEnd) break;
            moovParts.push(data.slice(p, p + sz));
            p += sz;
        }
    }
    const newMoovContent = concatBytes(moovParts);
    const newMoovSize = 8 + newMoovContent.length; // header 8 byte (32-bit cukup)
    const newMoovHeader = concatBytes([u32(newMoovSize), new TextEncoder().encode("moov")]);
    const newMoov = concatBytes([newMoovHeader, newMoovContent]);
    const delta = newMoovSize - moov.size;

    // ---- rebuild file: ftyp + moov + free? + mdat(+padding) ----
    const mdatDataStart = mdat.start + mdat.headerSize;
    const mdatDataLen = mdat.size - mdat.headerSize;
    const padding = fakeChunkCount * fakeSamplesPerChunk * FAKE_SAMPLE_SIZE;

    const parts = [];
    let cursor = 0;
    for (const box of top) {
        if (box.type === "moov") continue;
        if (box.type === "mdat") continue;
        if (box.type === "ftyp") parts.push(data.slice(box.start, box.start + box.size));
    }
    // pastikan ftyp pertama
    const preParts = [];
    for (const box of top) {
        if (box.type === "ftyp") preParts.push(data.slice(box.start, box.start + box.size));
    }
    const afterParts = [];
    for (const box of top) {
        if (box.type === "ftyp" || box.type === "moov" || box.type === "mdat") continue;
        afterParts.push(data.slice(box.start, box.start + box.size));
    }

    // offset mdat baru
    let newMdatOffset = 0;
    for (const b of preParts) newMdatOffset += b.length;
    newMdatOffset += newMoov.length;
    for (const b of afterParts) newMdatOffset += b.length;
    // mdat box header (32-bit)
    const newMdatSize = 8 + mdatDataLen + padding;
    const newMdatHeader = concatBytes([u32(newMdatSize), new TextEncoder().encode("mdat")]);
    const newMdatDataOffset = newMdatOffset + newMdatHeader.length;

    // ---- isi offset chunk: real = original + delta; fake = padding area ----
    // padding area mulai di newMdatDataOffset + mdatDataLen
    const paddingStart = newMdatDataOffset + mdatDataLen;
    const chunkBuf = replaceMap.get(chunkBox.start).bytes;
    const cDv = new DataView(chunkBuf.buffer);
    let cOff = 12;
    for (let i = 0; i < realChunkCount; i++) {
        const v = realChunkOffsets[i] + delta;
        if (isCo64) { cDv.setUint32(cOff, Math.floor(v / 4294967296)); cDv.setUint32(cOff + 4, v >>> 0); cOff += 8; }
        else { cDv.setUint32(cOff, v >>> 0); cOff += 4; }
    }
    for (let j = 0; j < fakeChunkCount; j++) {
        const v = paddingStart + j * (fakeSamplesPerChunk * FAKE_SAMPLE_SIZE);
        if (isCo64) { cDv.setUint32(cOff, Math.floor(v / 4294967296)); cDv.setUint32(cOff + 4, v >>> 0); cOff += 8; }
        else { cDv.setUint32(cOff, v >>> 0); cOff += 4; }
    }

    // ---- susun file akhir ----
    const fileParts = [];
    for (const b of preParts) fileParts.push(b);
    fileParts.push(newMoov);
    for (const b of afterParts) fileParts.push(b);
    fileParts.push(newMdatHeader);
    fileParts.push(data.slice(mdatDataStart, mdatDataStart + mdatDataLen));
    fileParts.push(new Uint8Array(padding)); // padding zero

    return {
        data: concatBytes(fileParts),
        info: {
            realFps: Math.round(realFps * 100) / 100,
            realSamples: realSampleCount,
            fakeSamples: fakeCount,
            fakeChunks: fakeChunkCount,
            impliedFps: Math.round((realSampleCount + fakeCount) / (realSampleCount / realFps)),
            deltaBytes: delta,
            paddingBytes: padding,
            hdlr: "VideoHandler/SoundHandler",
            mdhdLang: "und",
        },
    };
}
