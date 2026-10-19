import { lookup } from 'node:dns/promises';
import { request as nativeHttpRequest } from 'node:http';
import { request as nativeHttpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { ImportError, assertPublicSourceURL, isPublicAddress } from '../../functions/utils/importSecurity.js';

const networkError = () => new ImportError('source_network', 'Source download failed', 502);
const blockedError = () => new ImportError('blocked_source', 'Source address is not allowed', 400);

function withAbort(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(networkError());
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

// Uses native sockets rather than global fetch, which Docker rewrites for
// self-origin URLs. Every request has a fresh agent and a pinned DNS answer.
export function createNodeImportFetcher({
    dnsLookup = lookup,
    httpRequest = nativeHttpRequest,
    httpsRequest = nativeHttpsRequest,
} = {}) {
    return async function fetchSource(value, init = {}) {
        const url = assertPublicSourceURL(value);
        if (init.method && (typeof init.method !== 'string' || init.method.toUpperCase() !== 'GET')) {
            throw new ImportError('invalid_method', 'Only GET source requests are allowed', 400);
        }
        const signal = init.signal;
        if (signal?.aborted) throw networkError();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        let addresses;
        try {
            addresses = isIP(hostname)
                ? [{ address: hostname, family: isIP(hostname) }]
                : await withAbort(dnsLookup(hostname, { all: true, verbatim: true }), signal);
        } catch {
            throw networkError();
        }
        if (signal?.aborted) throw networkError();
        if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) =>
            !entry || typeof entry.address !== 'string' || !isPublicAddress(entry.address) ||
            !isIP(entry.address) || isIP(entry.address) !== entry.family)) {
            throw blockedError();
        }
        const selected = { address: addresses[0].address, family: addresses[0].family };
        const pinnedLookup = (name, options, callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (options?.all) callback(null, [{ ...selected }]);
            else callback(null, selected.address, selected.family);
        };
        let headers;
        try {
            headers = new Headers(init.headers);
            headers.set('Host', url.host);
            headers.set('Accept-Encoding', 'identity');
        } catch {
            throw networkError();
        }

        return new Promise((resolve, reject) => {
            let outgoing;
            let incoming;
            let settled = false;
            let failed = false;
            let finishBody;
            const cleanup = () => signal?.removeEventListener('abort', abort);
            const fail = () => {
                if (failed) return;
                failed = true;
                const error = networkError();
                if (!settled) { settled = true; reject(error); }
                finishBody?.(error);
                incoming?.destroy(error);
                outgoing?.destroy(error);
                cleanup();
            };
            const abort = () => fail();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { fail(); return; }

            const onResponse = (response) => {
                incoming = response;
                response.on('error', fail);
                if (signal?.aborted) { fail(); return; }
                try {
                    const responseHeaders = new Headers();
                    for (let index = 0; index < response.rawHeaders.length; index += 2) {
                        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
                    }
                    let body = null;
                    if ([204, 205, 304].includes(response.statusCode)) {
                        response.resume();
                        response.once('end', cleanup);
                    } else {
                        const reader = Readable.toWeb(response, {
                            strategy: { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
                        }).getReader();
                        let done = false;
                        body = new ReadableStream({
                            start(controller) {
                                finishBody = (error) => {
                                    if (done) return;
                                    done = true;
                                    controller.error(error);
                                    reader.cancel(error).catch(() => {});
                                };
                            },
                            async pull(controller) {
                                try {
                                    const result = await reader.read();
                                    if (done) return;
                                    if (result.done) {
                                        done = true;
                                        cleanup();
                                        controller.close();
                                    } else controller.enqueue(result.value);
                                } catch {
                                    if (!done) {
                                        done = true;
                                        cleanup();
                                        controller.error(networkError());
                                    }
                                }
                            },
                            async cancel() {
                                done = true;
                                cleanup();
                                incoming.destroy();
                                outgoing.destroy();
                                await reader.cancel().catch(() => {});
                            },
                        });
                    }
                    const result = new Response(body, {
                        status: response.statusCode,
                        statusText: response.statusMessage,
                        headers: responseHeaders,
                    });
                    settled = true;
                    resolve(result);
                } catch {
                    fail();
                }
            };

            try {
                const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
                outgoing = request({
                    protocol: url.protocol,
                    hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: `${url.pathname}${url.search}`,
                    method: 'GET',
                    headers: Object.fromEntries(headers),
                    agent: false,
                    lookup: pinnedLookup,
                    family: selected.family,
                    autoSelectFamily: false,
                    ...(url.protocol === 'https:' ? { servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true } : {}),
                }, onResponse);
                outgoing.on('error', fail);
                outgoing.on('upgrade', (response, socket) => { socket.destroy(); fail(); });
                outgoing.end();
            } catch {
                fail();
            }
        });
    };
}
