// Shared by Workers and the Docker downloader. Never include a source URL or
// an upstream exception in public errors: either can contain signed secrets.
export class ImportError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'ImportError';
        this.code = code;
        this.status = status;
    }
}

function ipv4(value) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(n => n <= 255) ? parts : null;
}

export function isPublicAddress(address) {
    const value = String(address).toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = ipv4(value);
    if (v4) {
        const [a, b, c] = v4;
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113));
    }
    if (!/^[0-9a-f:]+$/.test(value) || !value.includes(':')) return false;
    const halves = value.split('::');
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    if (![...left, ...right].every(part => /^[0-9a-f]{1,4}$/.test(part))) return false;
    if (halves.length === 1 && left.length !== 8) return false;
    if (halves.length === 2 && left.length + right.length >= 8) return false;
    const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(part => parseInt(part, 16));
    // Only ordinary global unicast. Exclude transition, mapped, documentation,
    // benchmarking and special-protocol ranges, including embedded IPv4 paths.
    return words[0] >= 0x2000 && words[0] <= 0x3fff &&
        words[0] !== 0x2002 && !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
        !(words[0] === 0x3fff && words[1] <= 0xfff);
}

export function assertPublicSourceURL(value) {
    let url;
    try { url = new URL(value); } catch { throw new ImportError('invalid_url', 'Invalid source URL'); }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !host || host === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
        (!host.includes('.') && !host.includes(':')) ||
        ((host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) && !isPublicAddress(host))) {
        throw new ImportError('blocked_source', 'Only public HTTP or HTTPS source addresses are allowed');
    }
    url.hash = '';
    return url;
}

// Docker injects a resolver-pinned adapter. Workers cannot override a socket's
// DNS result; validate all public DNS answers and retain Workers' public-network
// fetch boundary. Every redirect is separately checked by the caller.
export async function workerSourceFetch(value, options) {
    const url = assertPublicSourceURL(value);
    if (!isPublicAddress(url.hostname)) {
        const answers = await Promise.all(['A', 'AAAA'].map(async type => {
            const dns = new URL('https://cloudflare-dns.com/dns-query');
            dns.searchParams.set('name', url.hostname);
            dns.searchParams.set('type', type);
            let response;
            try { response = await fetch(dns, { headers: { Accept: 'application/dns-json' }, signal: options.signal }); }
            catch { throw new ImportError('source_dns', 'Source DNS lookup failed', 502); }
            if (!response.ok) throw new ImportError('source_dns', 'Source DNS lookup failed', 502);
            const result = await response.json();
            if (result.Status !== 0 && result.Status !== 3) throw new ImportError('source_dns', 'Source DNS lookup failed', 502);
            return (result.Answer || []).filter(item => item.type === 1 || item.type === 28).map(item => item.data);
        }));
        const addresses = answers.flat();
        if (!addresses.length || addresses.some(address => !isPublicAddress(address))) {
            throw new ImportError('blocked_source', 'Source address is not allowed');
        }
    }
    return fetch(url, options);
}

export function publicImportError(error, signal) {
    if (signal?.aborted) return signal.reason instanceof ImportError ? signal.reason : new ImportError('canceled', 'Import canceled', 499);
    return error instanceof ImportError ? error : new ImportError('import_failed', 'Media import failed', 502);
}
