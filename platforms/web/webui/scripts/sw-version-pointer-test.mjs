import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const swSource = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');
const origin = 'https://krkr2.test';
const pointerUrl = origin + '/engine/build-config.js';
const listeners = new Map();
const cacheEntries = new Map([
    [pointerUrl, new Response('stale-pointer')]
]);

const context = vm.createContext({
    URL,
    Request,
    Response,
    console,
    fetch: async () => new Response('fresh-pointer', { status: 200 }),
    caches: {
        match: async (request) => cacheEntries.get(request.url)?.clone(),
        open: async () => ({
            put: async (request, response) => {
                cacheEntries.set(request.url, response.clone());
            }
        }),
        keys: async () => []
    },
    self: {
        location: { origin },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        }
    }
});
vm.runInContext(swSource, context);

async function dispatchPointerRequest() {
    let responsePromise;
    listeners.get('fetch')({
        request: new Request(pointerUrl),
        respondWith(value) {
            responsePromise = Promise.resolve(value);
        }
    });
    assert.ok(responsePromise, 'version pointer request was not intercepted');
    return await responsePromise;
}

const online = await dispatchPointerRequest();
assert.equal(await online.text(), 'fresh-pointer',
             'online request returned the stale cached pointer');
assert.equal(await cacheEntries.get(pointerUrl).clone().text(), 'fresh-pointer',
             'online response did not replace the cached pointer');

context.fetch = async () => {
    throw new Error('offline');
};
const offline = await dispatchPointerRequest();
assert.equal(await offline.text(), 'fresh-pointer',
             'offline request did not fall back to the cached pointer');

console.log('PASS  engine version pointer is network-first with offline fallback');
