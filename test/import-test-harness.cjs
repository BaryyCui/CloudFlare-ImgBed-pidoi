'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const media = {
    video: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]),
    image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    audio: Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'),
};

async function loadImport(options = {}) {
    const records = new Map();
    const stored = new Map();
    const background = [];
    const calls = { fetch: [], parts: [], aborts: 0, completes: 0, s3: [] };
    const db = {
        async get(key) { return records.get(key)?.value ?? null; },
        async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
        async put(key, value, extra = {}) { records.set(key, { value, metadata: extra.metadata }); },
        async delete(key) { records.delete(key); },
    };
    const r2 = {
        async createMultipartUpload(key) {
            const parts = [];
            return {
                uploadId: 'test-upload', key,
                async uploadPart(partNumber, value, partOptions = {}) {
                    calls.parts.push(value.byteLength);
                    if (options.uploadPart) await options.uploadPart(partNumber, value, calls, partOptions);
                    parts[partNumber - 1] = Buffer.from(value);
                    return { partNumber, etag: `etag-${partNumber}` };
                },
                async complete() { calls.completes++; stored.set(key, Buffer.concat(parts)); return { key, size: stored.get(key).length }; },
                async abort() { calls.aborts++; },
            };
        },
        async delete(key) { stored.delete(key); },
    };
    const sourceFetch = async (url, init) => {
        calls.fetch.push({ url: String(url), headers: new Headers(init.headers) });
        if (options.fetchImpl) return options.fetchImpl(url, init, calls);
        return new Response(media.video, { headers: { 'content-type': 'video/mp4' } });
    };
    const settings = options.settings || { cfr2: { channels: [{ name: 'R2_env', enabled: true }] }, s3: { channels: [] } };
    const context = vm.createContext({
        URL, Headers, Request, Response, ReadableStream, TransformStream, TextEncoder, TextDecoder,
        AbortController, AbortSignal, Uint8Array, ArrayBuffer, DataView, Blob,
        crypto: webcrypto, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: sourceFetch,
    });
    const cache = new Map();
    const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context, identifier: id });
    const commands = {};
    for (const name of ['CreateMultipartUploadCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand', 'AbortMultipartUploadCommand', 'DeleteObjectCommand', 'HeadObjectCommand']) {
        commands[name] = class { constructor(input) { this.input = input; this.command = name; } };
    }
    commands.S3Client = class {
        constructor(config) { this.config = config; }
        async send(command, sendOptions = {}) {
            calls.s3.push({ config: this.config, command: command.command, input: command.input });
            if (options.s3Send) return options.s3Send(command, calls, sendOptions);
            if (command.command === 'CreateMultipartUploadCommand') return { UploadId: 's3-upload' };
            if (command.command === 'UploadPartCommand') return { ETag: 'part-etag' };
            return {};
        }
        destroy() {}
    };
    async function linker(specifier, parent) {
        let id = specifier.startsWith('.') ? path.resolve(path.dirname(parent.identifier), specifier) : specifier;
        if (cache.has(id)) return cache.get(id);
        let module;
        if (specifier.includes('userAuth')) module = synthetic(id, {
            userAuthCheck: async () => options.authorized !== false,
            UnauthorizedResponse: reason => new Response(reason, { status: 401 }),
        });
        else if (specifier.includes('sysConfig')) module = synthetic(id, {
            fetchSecurityConfig: async () => ({}), fetchUploadConfig: async () => settings,
            fetchPageConfig: async () => ({ config: options.prefixConfig || [] }),
        });
        else if (specifier.includes('databaseAdapter')) module = synthetic(id, { getDatabase: () => db });
        else if (specifier.includes('uploadTools')) module = synthetic(id, {
            buildUniqueFileId: async () => 'videos/example.mp4',
            createResponse: (body, init = {}) => new Response(body, init),
            endUpload: async () => options.indexResult || { success: true }, sanitizeFileName: name => name,
            sanitizeUploadFolder: folder => folder,
            getUploadIp: () => '1.1.1.1', isBlockedUploadIp: async () => false,
        });
        else if (specifier === '@aws-sdk/client-s3') module = synthetic(id, commands);
        else module = new vm.SourceTextModule(fs.readFileSync(id, 'utf8'), { context, identifier: id });
        cache.set(id, module);
        if (module instanceof vm.SourceTextModule) await module.link(linker);
        return module;
    }
    const entry = path.resolve(__dirname, '../functions/api/import-url.js');
    const module = new vm.SourceTextModule(fs.readFileSync(entry, 'utf8'), { context, identifier: entry });
    cache.set(entry, module);
    await module.link(linker); await module.evaluate();
    const env = { img_r2: r2, IMPORT_SOURCE_FETCH: sourceFetch, ...options.env };
    const invoke = async (body = {}, init = {}) => module.namespace.onRequest({
        request: new Request(init.origin || 'https://imgbed.example/api/import-url', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...init.headers },
            body: JSON.stringify({ url: 'https://media.example/file.mp4', ...body }), signal: init.signal,
        }), env, waitUntil: promise => { background.push(promise); promise.catch(() => {}); },
    });
    const importLimits = cache.get(path.resolve(__dirname, '../functions/utils/importMedia.js')).namespace.importLimits;
    return { invoke, env, records, stored, calls, background, importLimits, onRequest: module.namespace.onRequest };
}

module.exports = { loadImport, media };
