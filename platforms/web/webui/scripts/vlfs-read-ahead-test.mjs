import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BLOCK_SIZE = 256 * 1024;
const sourceSize = 2 * 1024 * 1024;

function makePayload(size, seed) {
    const data = new Uint8Array(size);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + seed) & 0xff;
    return data;
}

function makeStoredZip(name, payload) {
    const nameBytes = new TextEncoder().encode(name);
    const localSize = 30 + nameBytes.length;
    const centralSize = 46 + nameBytes.length;
    const eocdSize = 22;
    const total = localSize + payload.length + centralSize + eocdSize;
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    let p = 0;

    view.setUint32(p, 0x04034b50, true);
    view.setUint16(p + 8, 0, true);       // stored
    view.setUint32(p + 18, payload.length, true);
    view.setUint32(p + 22, payload.length, true);
    view.setUint16(p + 26, nameBytes.length, true);
    p += 30;
    bytes.set(nameBytes, p);
    p += nameBytes.length;
    const dataOffset = p;
    bytes.set(payload, p);
    p += payload.length;
    const centralOffset = p;

    view.setUint32(p, 0x02014b50, true);
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, 0, true);
    view.setUint32(p + 20, payload.length, true);
    view.setUint32(p + 24, payload.length, true);
    view.setUint16(p + 28, nameBytes.length, true);
    view.setUint32(p + 42, 0, true);
    p += 46;
    bytes.set(nameBytes, p);
    p += nameBytes.length;

    view.setUint32(p, 0x06054b50, true);
    view.setUint16(p + 8, 1, true);
    view.setUint16(p + 10, 1, true);
    view.setUint32(p + 12, centralSize, true);
    view.setUint32(p + 16, centralOffset, true);
    return { bytes, dataOffset };
}

function concatChunks(chunks) {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function assertBytesEqual(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: byte length`);
    for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
            assert.fail(`${label}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
        }
    }
}

function makeContext(sources, ranges, persisted) {
    const gameCache = {
        async openSource() {
            return { blockBytes: 0, usageTimer: 0 };
        },
        async hasBlock(_cache, index, expected) {
            return persisted.has(index) && persisted.get(index).length === expected;
        },
        async readBlock(_cache, index, expected) {
            const data = persisted.get(index);
            return data && data.length === expected ? new Uint8Array(data) : null;
        },
        async writeBlock(_cache, index, data) {
            persisted.set(index, new Uint8Array(data));
        }
    };
    const window = { KrKr2GameCache: gameCache };
    const context = vm.createContext({
        window,
        navigator: { storage: { getDirectory: async () => { throw new Error('no OPFS'); } } },
        console,
        crypto: globalThis.crypto,
        TextDecoder,
        TextEncoder,
        Blob,
        Response,
        Uint8Array,
        DataView,
        Map,
        WeakMap,
        Math,
        Number,
        Date,
        setTimeout,
        clearTimeout,
        fetch: async (url, init = {}) => {
            const source = sources.get(url);
            assert.ok(source, `unexpected fetch URL: ${url}`);
            const sourceBytes = source.bytes || source;
            const match = String(init.headers?.Range || '').match(/^bytes=(\d+)-(\d+)$/);
            assert.ok(match, `fetch without a single byte range: ${url}`);
            const start = Number(match[1]);
            const end = Number(match[2]);
            assert.ok(start >= 0 && end >= start && end < sourceBytes.length,
                      `invalid range ${start}-${end} for ${sourceBytes.length}`);
            ranges.push({ url, start, end });
            const rangeBytes = sourceBytes.slice(start, end + 1);
            const body = source.makeBody ? source.makeBody(rangeBytes) : rangeBytes;
            return new Response(body, {
                status: 206,
                headers: {
                    'Content-Range': `bytes ${start}-${end}/${sourceBytes.length}`
                }
            });
        }
    });
    vm.runInContext(readFileSync(new URL('../public/vlfs.js', import.meta.url), 'utf8'), context);
    return context;
}

async function readExact(vlfs, fd, size) {
    const chunks = [];
    let remaining = size;
    while (remaining > 0) {
        const n = Math.min(BLOCK_SIZE, remaining);
        chunks.push(await vlfs.read(fd, n));
        remaining -= n;
    }
    return concatChunks(chunks);
}

// Direct XP3: a non-aligned 900 KiB physical segment is consumed in 256 KiB
// reads, but the read-ahead range must result in one network request.
{
    const payload = makePayload(sourceSize, 11);
    const ranges = [];
    const persisted = new Map();
    let releaseTail;
    let tailDelivered = false;
    const tailGate = new Promise((resolve) => { releaseTail = resolve; });
    const streamedSource = {
        bytes: payload,
        makeBody(rangeBytes) {
            return new ReadableStream({
                start(controller) {
                    controller.enqueue(rangeBytes.slice(0, 300000));
                    tailGate.then(() => {
                        tailDelivered = true;
                        controller.enqueue(rangeBytes.slice(300000));
                        controller.close();
                    });
                }
            });
        }
    };
    const context = makeContext(
        new Map([['https://test.invalid/data.xp3', streamedSource]]),
        ranges, persisted);
    const vlfs = context.window.VLFS;
    vlfs.setGameCacheId('read-ahead-test');
    vlfs.registerRemote(
        '/data.xp3', 'https://test.invalid/data.xp3', payload.length, true, {
            kind: 'xp3', slot: '/data.xp3', fingerprint: 'etag-test'
        });
    const segmentStart = 12345;
    const segmentLength = 900000;
    const fd = vlfs.open('/data.xp3', 0);
    assert.equal(vlfs.setReadAhead(fd, segmentStart, segmentLength), 0);
    assert.equal(vlfs.seek(fd, segmentStart, 0), segmentStart);
    const first = await Promise.race([
        vlfs.read(fd, BLOCK_SIZE),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('first block waited for the complete segment')), 1000))
    ]);
    assert.equal(tailDelivered, false,
                 'first block is returned before the response tail arrives');
    releaseTail();
    const rest = await readExact(vlfs, fd, segmentLength - first.length);
    const actual = concatChunks([first, rest]);
    assertBytesEqual(
        actual, payload.slice(segmentStart, segmentStart + segmentLength),
        'direct XP3 segment');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(ranges.length, 1, 'one physical segment should issue one Range GET');
    assert.equal(ranges[0].start, 0, 'read-ahead is rounded to the cache block start');
    assert.ok(ranges[0].end + 1 >= segmentStart + segmentLength,
              'Range must cover the complete segment');
    assert.equal(persisted.size, 4, 'all covered cache blocks are persisted');

    // A second fd sees the persisted full blocks and must not fetch again.
    vlfs.registerRemote(
        '/data-again.xp3', 'https://test.invalid/data.xp3', payload.length, true, {
            kind: 'xp3', slot: '/data.xp3', fingerprint: 'etag-test'
        });
    const fd2 = vlfs.open('/data-again.xp3', 0);
    assert.equal(vlfs.setReadAhead(fd2, segmentStart, segmentLength), 0);
    assert.equal(vlfs.seek(fd2, segmentStart, 0), segmentStart);
    const actual2 = await readExact(vlfs, fd2, segmentLength);
    assertBytesEqual(actual2, actual, 'persistent cache replay');
    assert.equal(ranges.length, 1, 'complete persistent blocks avoid another GET');
}

// Stored ZIP: the XP3 entry starts at a non-aligned absolute offset. The same
// one-request guarantee must survive the ZIP dataOffset translation.
{
    const payload = makePayload(900000, 29);
    const zip = makeStoredZip('data.xp3', payload);
    const ranges = [];
    const context = makeContext(
        new Map([['https://test.invalid/game.zip', zip.bytes]]), ranges, new Map());
    const vlfs = context.window.VLFS;
    const registration = await vlfs.registerZipRemote(
        'https://test.invalid/game.zip', zip.bytes.length);
    assert.ok(registration.xp3Paths.includes('/data.xp3'));
    const entry = vlfs._entries.get('/data.xp3');
    assert.ok(entry);
    await vlfs._resolveZipDataOffset(entry);
    assert.equal(entry.dataOffset, zip.dataOffset);
    const fd = vlfs.open('/data.xp3', 0);
    assert.equal(vlfs.setReadAhead(fd, 0, payload.length), 0);
    const actual = await readExact(vlfs, fd, payload.length);
    assertBytesEqual(actual, payload, 'stored ZIP XP3 segment');

    const dataRanges = ranges.filter((range) => range.start <= zip.dataOffset &&
        range.end + 1 >= zip.dataOffset + payload.length);
    assert.equal(dataRanges.length, 1,
                 'stored ZIP segment should issue one translated Range GET');
}

console.log('PASS  VLFS XP3 segment read-ahead and stored ZIP offset tests');
