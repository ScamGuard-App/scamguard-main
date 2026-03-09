// Public runtime config for backend API base URL.
// Set this to your deployed backend origin (no trailing slash) when hosting on GitHub Pages.
// Example: const API_BASE_URL = 'https://scamguard-api.onrender.com';
const API_BASE_URL = 'https://scamguard-main.onrender.com';

function normalizeBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    return baseUrl.trim().replace(/\/+$/, '');
}

function isLocalHost() {
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
}

function resolveApiBaseUrl() {
    const runtimeBase = normalizeBaseUrl(window.SCAMGUARD_API_BASE_URL || '');
    if (runtimeBase) return runtimeBase;

    const staticBase = normalizeBaseUrl(API_BASE_URL);
    if (staticBase) return staticBase;

    return '';
}

const RESOLVED_API_BASE_URL = resolveApiBaseUrl();

function buildApiUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return RESOLVED_API_BASE_URL
        ? `${RESOLVED_API_BASE_URL}${normalizedPath}`
        : normalizedPath;
}

function getApiCandidates(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const candidates = [];

    if (RESOLVED_API_BASE_URL) {
        candidates.push(`${RESOLVED_API_BASE_URL}${normalizedPath}`);
        if (isLocalHost()) {
            candidates.push(normalizedPath);
        }
    } else {
        candidates.push(normalizedPath);
        if (isLocalHost()) {
            candidates.push(`http://localhost:3000${normalizedPath}`);
        }
    }

    return [...new Set(candidates)];
}

export { RESOLVED_API_BASE_URL, buildApiUrl, getApiCandidates };
