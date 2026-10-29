/**
 * 本地 R2 存储适配器
 * 使用本地文件系统模拟 Cloudflare R2 的 API 接口。
 * 对象及分片均先流式写入同目录临时文件，再原子发布。
 */

import { createReadStream, createWriteStream, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, lstatSync, realpathSync, readdirSync, rmSync } from 'fs';
import { rename, rm } from 'fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { randomUUID, createHash } from 'crypto';

// A second adapter for the same bucket must see writes already in progress.
const activeObjectWrites = new Map();
const identityFields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];

function retentionDeleteReason(object, expectedIdentity) {
    if (!object.safe) return 'unsafe';
    if (object.active) return 'active';
    if (!object.exists) return 'missing';
    if (!expectedIdentity || identityFields.some((field) =>
        !Number.isFinite(expectedIdentity[field]) || expectedIdentity[field] !== object.identity[field])) {
        return 'changed';
    }
    return null;
}

function readableValue(value) {
    if (value instanceof Blob) return Readable.fromWeb(value.stream());
    if (value instanceof ReadableStream) return Readable.fromWeb(value);
    if (value instanceof Readable) return value;
    if (value instanceof ArrayBuffer) return Readable.from([Buffer.from(value)]);
    if (value instanceof Uint8Array) {
        return Readable.from([Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
    }
    if (typeof value === 'string') return Readable.from([value]);
    throw new TypeError('Unsupported object body');
}

function validatePartNumber(partNumber) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        throw new Error('Invalid multipart part number');
    }
}

export class LocalR2Storage {
    constructor(basePath) {
        mkdirSync(basePath, { recursive: true });
        this.basePath = realpathSync(basePath);
        this._uploadOperations = new Map();
    }

    _assertSafePath(filePath) {
        const local = relative(this.basePath, filePath);
        if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
            throw new Error('Invalid storage path');
        }
        let current = this.basePath;
        for (const segment of ['', ...local.split(sep)]) {
            if (segment) current = join(current, segment);
            try {
                if (lstatSync(current).isSymbolicLink()) throw new Error('Storage path contains a symbolic link');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }

    _filePath(key) {
        if (typeof key !== 'string' || !key || isAbsolute(key) || /[\\\0]/.test(key) ||
            key.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
            key.split('/')[0] === '_multipart') {
            throw new Error('Invalid object key');
        }
        const filePath = resolve(this.basePath, key);
        this._assertSafePath(filePath);
        return filePath;
    }

    /** 获取文件，支持 Range 请求。 */
    async get(key, options) {
        const filePath = this._filePath(key);
        if (!existsSync(filePath)) return null;

        const size = statSync(filePath).size;
        let body;
        let range;
        if (options && options.range) {
            const offset = options.range.offset || 0;
            const length = options.range.length || (size - offset);
            body = Readable.toWeb(createReadStream(filePath, { start: offset, end: offset + length - 1 }));
            range = { offset, length };
        } else {
            body = Readable.toWeb(createReadStream(filePath));
        }
        return { body, size, range, httpMetadata: {}, writeHttpMetadata() {} };
    }

    async _writeAtomic(filePath, value, { signal, beforeCommit } = {}) {
        this._assertSafePath(filePath);
        mkdirSync(dirname(filePath), { recursive: true });
        const temporary = join(dirname(filePath), `.r2-${randomUUID()}.tmp`);
        const hash = createHash('sha256');
        let size = 0;
        const measure = new Transform({
            transform(chunk, encoding, callback) {
                size += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            }
        });
        try {
            await pipeline(readableValue(value), measure, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
            signal?.throwIfAborted();
            this._assertSafePath(filePath);
            beforeCommit?.();
            await rename(temporary, filePath);
            return { size, etag: hash.digest('hex') };
        } finally {
            await rm(temporary, { force: true });
        }
    }

    /** options.signal 可取消写入；失败时保留之前的完整对象。 */
    async put(key, value, options = {}) {
        await this._withObjectWrite(key, (filePath) => this._writeAtomic(filePath, value, options));
    }

    async _withObjectWrite(key, action) {
        const filePath = this._filePath(key);
        activeObjectWrites.set(filePath, (activeObjectWrites.get(filePath) || 0) + 1);
        try {
            return await action(filePath);
        } finally {
            const remaining = activeObjectWrites.get(filePath) - 1;
            if (remaining) activeObjectWrites.set(filePath, remaining);
            else activeObjectWrites.delete(filePath);
        }
    }

    _hasMultipartUpload(key) {
        const root = join(this.basePath, '_multipart');
        try {
            this._assertSafePath(root);
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                // Unknown session state is not evidence that an object is idle.
                if (entry.isSymbolicLink()) return true;
                if (!entry.isDirectory()) continue;
                const keyPath = join(root, entry.name, '_key');
                try {
                    this._assertSafePath(keyPath);
                    if (!lstatSync(keyPath).isFile()) return true;
                    if (readFileSync(keyPath, 'utf8') === key) return true;
                } catch (error) {
                    if (error.code !== 'ENOENT') return true;
                }
            }
            return false;
        } catch (error) {
            return error.code !== 'ENOENT';
        }
    }

    /** Retention only inspects regular published objects, without following links. */
    inspectForRetention(key) {
        const object = { exists: false, safe: false, active: false, identity: null, size: 0, mtimeMs: null };
        let filePath;
        try {
            filePath = this._filePath(key);
            if (key.split('/').some((segment) => /^\.r2-.*\.tmp$/.test(segment))) return object;
        } catch {
            return object;
        }
        object.active = activeObjectWrites.has(filePath) || this._hasMultipartUpload(key);
        try {
            const stat = lstatSync(filePath);
            object.exists = true;
            if (!stat.isFile()) return object;
            object.safe = true;
            object.identity = Object.fromEntries(identityFields.map((field) => [field, stat[field]]));
            object.size = stat.size;
            object.mtimeMs = stat.mtimeMs;
        } catch (error) {
            if (error.code === 'ENOENT') object.safe = true;
        }
        return object;
    }

    /** No await may separate version/activity checks, the database guard and unlink. */
    deleteForRetention(key, expectedIdentity, beforeDelete) {
        let reason = retentionDeleteReason(this.inspectForRetention(key), expectedIdentity);
        if (reason) return { deleted: false, reason };
        if (beforeDelete) {
            const result = beforeDelete();
            if (result && typeof result.then === 'function') {
                // Avoid an unhandled rejection from a mistakenly asynchronous guard.
                Promise.resolve(result).catch(() => {});
                throw new TypeError('Retention beforeDelete guard must be synchronous');
            }
            if (result === false) throw new Error('Retention beforeDelete guard rejected deletion');
            reason = retentionDeleteReason(this.inspectForRetention(key), expectedIdentity);
            if (reason) return { deleted: false, reason };
        }
        try {
            unlinkSync(this._filePath(key));
        } catch (error) {
            if (error.code === 'ENOENT') return { deleted: false, reason: 'missing' };
            throw error;
        }
        return { deleted: true, reason: 'deleted' };
    }

    async delete(key) {
        const filePath = this._filePath(key);
        if (existsSync(filePath)) unlinkSync(filePath);
    }

    _uploadDir(uploadId) {
        if (typeof uploadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uploadId)) {
            throw new Error('Invalid multipart upload id');
        }
        const uploadDir = join(this.basePath, '_multipart', uploadId);
        this._assertSafePath(uploadDir);
        return uploadDir;
    }

    _validateUpload(key, uploadId) {
        this._filePath(key);
        const uploadDir = this._uploadDir(uploadId);
        const keyPath = join(uploadDir, '_key');
        this._assertSafePath(keyPath);
        if (!existsSync(keyPath) || readFileSync(keyPath, 'utf8') !== key) {
            throw new Error('Multipart upload does not exist or key does not match');
        }
        return uploadDir;
    }

    async createMultipartUpload(key) {
        this._filePath(key);
        const uploadId = randomUUID();
        const uploadDir = this._uploadDir(uploadId);
        mkdirSync(uploadDir, { recursive: true });
        writeFileSync(join(uploadDir, '_key'), key, { flag: 'wx' });
        return { uploadId, key, ...this._createMultipartMethods(key, uploadId) };
    }

    resumeMultipartUpload(key, uploadId) {
        this._filePath(key);
        this._uploadDir(uploadId);
        return { uploadId, key, ...this._createMultipartMethods(key, uploadId) };
    }

    async _withUploadOperation(uploadId, signal, action) {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(signal.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        let finish;
        const operation = { controller, done: new Promise((resolve) => { finish = resolve; }) };
        const operations = this._uploadOperations.get(uploadId) || new Set();
        this._uploadOperations.set(uploadId, operations);
        operations.add(operation);
        try {
            return await action(controller.signal);
        } finally {
            signal?.removeEventListener('abort', forwardAbort);
            operations.delete(operation);
            if (operations.size === 0) this._uploadOperations.delete(uploadId);
            finish();
        }
    }

    _createMultipartMethods(key, uploadId) {
        const self = this;
        const partFile = (uploadDir, number) => join(uploadDir, `part_${String(number).padStart(6, '0')}`);
        return {
            async uploadPart(partNumber, data, options = {}) {
                validatePartNumber(partNumber);
                const uploadDir = self._validateUpload(key, uploadId);
                return self._withUploadOperation(uploadId, options.signal, async (signal) => {
                    const result = await self._writeAtomic(partFile(uploadDir, partNumber), data, {
                        signal,
                        beforeCommit: () => self._validateUpload(key, uploadId),
                    });
                    return { etag: result.etag, partNumber };
                });
            },

            async complete(parts, options = {}) {
                const uploadDir = self._validateUpload(key, uploadId);
                if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10000) {
                    throw new Error('Invalid multipart manifest');
                }
                const seen = new Set();
                for (const part of parts) {
                    validatePartNumber(part?.partNumber);
                    if (seen.has(part.partNumber) || typeof part.etag !== 'string' || !part.etag) {
                        throw new Error('Invalid multipart entry or etag');
                    }
                    seen.add(part.partNumber);
                    const partPath = partFile(uploadDir, part.partNumber);
                    self._assertSafePath(partPath);
                    if (!existsSync(partPath) || !statSync(partPath).isFile()) throw new Error('Multipart part is missing');
                }
                const sortedParts = parts.map((part) => ({ ...part })).sort((a, b) => a.partNumber - b.partNumber);
                async function* readParts() {
                    for (const part of sortedParts) {
                        const partPath = partFile(uploadDir, part.partNumber);
                        self._assertSafePath(partPath);
                        const hash = createHash('sha256');
                        for await (const chunk of createReadStream(partPath)) {
                            hash.update(chunk);
                            yield chunk;
                        }
                        // Uploads persisted by older Docker versions returned
                        // deterministic etag_N values. Their session key and
                        // every referenced file were validated above.
                        const legacyEtag = `etag_${part.partNumber}`;
                        if (hash.digest('hex') !== part.etag && part.etag !== legacyEtag) {
                            throw new Error('Multipart part etag does not match');
                        }
                    }
                }
                return self._withObjectWrite(key, (filePath) => self._withUploadOperation(uploadId, options.signal, async (signal) => {
                    await self._writeAtomic(filePath, Readable.from(readParts()), {
                        signal,
                        beforeCommit: () => self._validateUpload(key, uploadId),
                    });
                    self._cleanupDir(uploadDir);
                }));
            },

            async abort() {
                const uploadDir = self._uploadDir(uploadId);
                if (existsSync(uploadDir)) self._validateUpload(key, uploadId);
                const operations = [...(self._uploadOperations.get(uploadId) || [])];
                for (const operation of operations) operation.controller.abort();
                self._cleanupDir(uploadDir);
                await Promise.all(operations.map((operation) => operation.done));
            }
        };
    }

    _cleanupDir(dir) {
        this._assertSafePath(dir);
        rmSync(dir, { recursive: true, force: true });
    }
}
