import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { ImportError } from './importSecurity.js';

export const IMPORT_PART_BYTES = 8 * 1024 * 1024;

export function selectImportStorage(env, config, input) {
    const kind = String(input.uploadChannel || 'cfr2').toLowerCase();
    if (!['cfr2', 's3'].includes(kind)) throw new ImportError('unsupported_storage', 'URL import requires R2 or S3 storage');
    const channels = (config[kind]?.channels || []).filter(channel => channel.enabled !== false);
    const channel = input.channelName ? channels.find(item => item.name === input.channelName) : channels[0];
    if (!channel) throw new ImportError('storage_unavailable', 'The selected storage channel is unavailable');
    if (kind === 'cfr2' && typeof env.img_r2?.createMultipartUpload !== 'function') {
        throw new ImportError('storage_unavailable', 'R2 storage is not configured', 503);
    }
    if (kind === 's3' && (!channel.endpoint || !channel.bucketName || !channel.accessKeyId || !channel.secretAccessKey)) {
        throw new ImportError('storage_unavailable', 'S3 storage is not configured', 503);
    }
    return { kind, channel, identity: JSON.stringify([kind, channel.name, channel.endpoint || '', channel.bucketName || '', !!channel.pathStyle]) };
}

function isTransient(error) {
    const status = error?.$metadata?.httpStatusCode || error?.status || error?.statusCode;
    return [408, 429, 500, 502, 503, 504].includes(status) ||
        ['source_network', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'NetworkingError', 'TimeoutError', 'SlowDown', 'InternalError', 'ServiceUnavailable'].includes(error?.code || error?.name);
}

export async function abortable(operation, signal, timeoutMS = 30000) {
    if (signal.aborted) throw signal.reason;
    let timer;
    let onAbort;
    const stopped = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => reject(new ImportError('stalled', 'Import made no progress before the timeout', 504)), timeoutMS);
    });
    try { return await Promise.race([Promise.resolve().then(operation), stopped]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

export async function retryTransient(operation, signal, idleMS, onAttempt = () => {}) {
    for (let attempt = 1; ; attempt++) {
        onAttempt(attempt);
        try { return await abortable(operation, signal, idleMS); }
        catch (error) {
            if (attempt >= 3 || signal.aborted || !isTransient(error)) throw error;
            await abortable(() => new Promise(resolve => setTimeout(resolve, attempt * 100)), signal, idleMS);
        }
    }
}

export async function createImportWriter(env, selected, key, contentType, identity, signal, idleMS, onAttempt) {
    if (selected.kind === 'cfr2') {
        const pending = env.img_r2.createMultipartUpload(key, { httpMetadata: { contentType }, customMetadata: { importIdentity: identity } });
        // If cancellation beats creation, abort the late-created session too.
        pending.then(upload => { if (signal.aborted) upload.abort().catch(() => {}); }).catch(() => {});
        const upload = await abortable(() => pending, signal, idleMS);
        return {
            part: (number, bytes) => retryTransient(() => upload.uploadPart(number, bytes, { signal }), signal, idleMS, onAttempt),
            complete(parts, onCommitted = () => {}, waitUntil) {
                const completion = upload.complete(parts, { signal }).then(async result => { await onCommitted(); return result; });
                // Only the commit acknowledgement and its short metadata
                // finalization survive a disconnect; no download runs here.
                waitUntil?.(completion.catch(() => {}));
                return abortable(() => completion, signal, idleMS);
            },
            abort: () => upload.abort(),
            close() {},
        };
    }
    const channel = selected.channel;
    const clientConfig = {
        endpoint: channel.endpoint, region: channel.region || 'auto', forcePathStyle: !!channel.pathStyle,
        credentials: { accessKeyId: channel.accessKeyId, secretAccessKey: channel.secretAccessKey }, maxAttempts: 1,
    };
    const client = new S3Client(clientConfig);
    const base = { Bucket: channel.bucketName, Key: key };
    let created;
    let abandoned = false;
    const pending = client.send(new CreateMultipartUploadCommand({ ...base, ContentType: contentType, Metadata: { importidentity: identity } }), { abortSignal: signal });
    pending.then(async result => {
        if ((!abandoned && !signal.aborted) || !result.UploadId) return;
        const cleanup = new AbortController();
        const timer = setTimeout(() => cleanup.abort(), 5000);
        const cleanupClient = new S3Client(clientConfig);
        try { await cleanupClient.send(new AbortMultipartUploadCommand({ ...base, UploadId: result.UploadId }), { abortSignal: cleanup.signal }); }
        finally { clearTimeout(timer); cleanupClient.destroy(); }
    }).catch(() => {});
    try {
        created = await abortable(() => pending, signal, idleMS);
    } catch (error) { abandoned = true; client.destroy(); throw error; }
    const params = { ...base, UploadId: created.UploadId };
    return {
        async part(number, bytes) {
            const part = await retryTransient(() => client.send(new UploadPartCommand({ ...params, PartNumber: number, Body: bytes, ContentLength: bytes.byteLength }), { abortSignal: signal }), signal, idleMS, onAttempt);
            return { partNumber: number, etag: part.ETag };
        },
        complete(parts, onCommitted = () => {}, waitUntil) {
            const completion = client.send(new CompleteMultipartUploadCommand({ ...params, MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })) } }), { abortSignal: signal })
                .then(async result => { await onCommitted(); return result; });
            waitUntil?.(completion.catch(() => {}));
            return abortable(() => completion, signal, idleMS);
        },
        abort: () => client.send(new AbortMultipartUploadCommand(params)),
        close: () => client.destroy(),
    };
}
