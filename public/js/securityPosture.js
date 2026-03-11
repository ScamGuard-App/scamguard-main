import { ensureSupabase } from './supabase.public.js';
import { getApiCandidates } from './api.js';
import { escapeHtml } from './utils.js';

const endpoints = {
    posture: getApiCandidates('/admin/security-posture'),
    diagnostics: getApiCandidates('/admin/ai-diagnostics'),
    dashboard: getApiCandidates('/admin/dashboard-data'),
};

let adminAccessToken = null;

document.addEventListener('DOMContentLoaded', async () => {
    const sb = await ensureSupabase();
    if (!sb) {
        showStatus('Supabase client failed to initialize.');
        return;
    }

    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user) {
        window.location.href = 'index.html';
        return;
    }

    adminAccessToken = session.access_token || null;

    const { data: profile } = await sb
        .from('profiles')
        .select('is_admin')
        .eq('id', session.user.id)
        .maybeSingle();

    if (!profile?.is_admin) {
        showStatus('Access denied: admin privileges required. Redirecting...');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 2200);
        return;
    }

    document.getElementById('refreshPostureBtn')?.addEventListener('click', loadSecurityPosture);
    await loadSecurityPosture();
});

function showStatus(message) {
    const statusEl = document.getElementById('postureStatus');
    if (statusEl) statusEl.textContent = message;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
}

function statusLabel(status) {
    if (status === 'pass') return 'PASS';
    if (status === 'warn') return 'WARN';
    if (status === 'fail') return 'FAIL';
    return 'INFO';
}

function renderRuntimeMeta(environment, generatedAt) {
    const target = document.getElementById('postureMeta');
    if (!target) return;

    const items = [
        ['Generated', generatedAt ? new Date(generatedAt).toLocaleString() : 'Unknown'],
        ['Node Env', environment?.nodeEnv || 'Unknown'],
        ['LLM Provider', environment?.llmProvider || 'Unknown'],
        ['Redis Queue Enabled', environment?.useRedisQueue ? 'Yes' : 'No'],
        ['Queue Reachable', environment?.queueReady ? 'Yes' : 'No'],
        ['Inline AI Fallback', environment?.inlineFallbackEnabled ? 'Yes' : 'No'],
        ['Allowed Origins', environment?.allowedOriginsCount ?? 'Unknown'],
    ];

    target.innerHTML = items.map(([label, value]) => `
        <article class="security-meta-item">
            <div class="security-meta-label">${escapeHtml(label)}</div>
            <div class="security-meta-value">${escapeHtml(String(value))}</div>
        </article>
    `).join('');
}

function renderChecklist(items) {
    const target = document.getElementById('postureChecklist');
    if (!target) return;

    if (!Array.isArray(items) || items.length === 0) {
        target.innerHTML = '<div class="admin-empty">No controls found.</div>';
        return;
    }

    target.innerHTML = items.map((item) => {
        const status = String(item.status || '').toLowerCase();
        return `
            <article class="posture-item posture-${escapeHtml(status)}">
                <header class="posture-item-header">
                    <h3>${escapeHtml(item.title || 'Unnamed control')}</h3>
                    <span class="posture-pill posture-pill-${escapeHtml(status)}">${statusLabel(status)}</span>
                </header>
                <p>${escapeHtml(item.details || 'No details provided.')}</p>
            </article>
        `;
    }).join('');
}

async function fetchWithFallback(urls) {
    let lastError = null;
    const tried = [];

    for (const endpoint of urls) {
        tried.push(endpoint);
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    Authorization: adminAccessToken ? `Bearer ${adminAccessToken}` : '',
                },
            });

            if ((response.status === 404 || response.status === 405) && endpoint.startsWith('/')) {
                continue;
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                continue;
            }

            const payload = await response.json().catch(() => ({}));
            return { response, payload, endpoint };
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError) throw lastError;
    throw new Error(`No JSON endpoint available. Tried: ${tried.join(', ')}`);
}

function buildFallbackPostureFromLegacy(diagnosticsPayload, dashboardPayload) {
    const diagnostics = diagnosticsPayload?.diagnostics || {};
    const totals = dashboardPayload?.totals || {};
    const queueReady = Boolean(diagnostics.queueReady);
    const provider = diagnostics.provider || 'unknown';

    const checklist = [
        {
            id: 'admin-auth-guard',
            title: 'Admin API Authorization Guard',
            status: 'pass',
            details: 'Admin APIs are reachable with bearer token and admin check.',
        },
        {
            id: 'cors-allowlist-review',
            title: 'CORS Allowlist Review Needed',
            status: 'warn',
            details: 'Legacy fallback cannot inspect live CORS headers. Verify explicit allowlist on backend.',
        },
        {
            id: 'security-headers-review',
            title: 'Security Headers Review Needed',
            status: 'warn',
            details: 'Legacy fallback cannot confirm CSP/HSTS/XFO headers. Deploy updated /admin/security-posture endpoint.',
        },
        {
            id: 'xss-sqli-probes',
            title: 'XSS/SQLi Probe Coverage',
            status: 'warn',
            details: 'Legacy fallback cannot run server-side probes. Deploy updated endpoint to enable these checks.',
        },
        {
            id: 'security-monitoring-signal',
            title: 'Operational Signal Coverage',
            status: Number(totals.reportsWithoutAI || 0) > 0 ? 'warn' : 'pass',
            details: `Current unresolved analysis backlog: ${Number(totals.reportsWithoutAI || 0).toLocaleString()} (indirect resilience indicator).`,
        },
        {
            id: 'runtime-hardening-caveat',
            title: 'Runtime Hardening Visibility',
            status: queueReady ? 'pass' : 'warn',
            details: queueReady
                ? 'Runtime health endpoint reachable; partial hardening telemetry available.'
                : 'Runtime queue health degraded; verify availability and abuse controls.',
        },
    ];

    const pass = checklist.filter((item) => item.status === 'pass').length;
    const warn = checklist.filter((item) => item.status === 'warn').length;
    const fail = checklist.filter((item) => item.status === 'fail').length;

    return {
        generatedAt: diagnostics.checkedAt || new Date().toISOString(),
        environment: {
            nodeEnv: 'unknown',
            llmProvider: provider,
            useRedisQueue: queueReady,
            inlineFallbackEnabled: Boolean(diagnostics.inlineFallbackEnabled),
            queueReady,
            allowedOriginsCount: 'unknown',
        },
        totals: {
            pass,
            warn,
            fail,
            score: Math.round((pass / checklist.length) * 100),
        },
        checklist,
    };
}

async function loadSecurityPosture() {
    showStatus('Refreshing posture snapshot...');

    try {
        let payload;
        let endpoint;

        try {
            const primary = await fetchWithFallback(endpoints.posture);
            if (!primary.response.ok) {
                throw new Error(primary.payload.error || `Security posture request failed (${primary.response.status})`);
            }
            payload = primary.payload;
            endpoint = primary.endpoint;
        } catch (_primaryErr) {
            // Backward-compatible fallback if backend deploy has not picked up /admin/security-posture yet.
            const [diag, dash] = await Promise.all([
                fetchWithFallback(endpoints.diagnostics),
                fetchWithFallback(endpoints.dashboard),
            ]);

            if (!diag.response.ok) {
                throw new Error(diag.payload.error || `Diagnostics request failed (${diag.response.status})`);
            }
            if (!dash.response.ok) {
                throw new Error(dash.payload.error || `Dashboard request failed (${dash.response.status})`);
            }

            payload = buildFallbackPostureFromLegacy(diag.payload, dash.payload);
            endpoint = `${diag.endpoint} + ${dash.endpoint}`;
        }

        const totals = payload.totals || {};
        const passCount = Number(totals.pass || 0);
        const warnCount = Number(totals.warn || 0);
        const failCount = Number(totals.fail || 0);
        const score = Number(totals.score || 0);

        setText('postureScore', `${score}%`);
        setText('posturePass', passCount);
        setText('postureRisk', `${warnCount} / ${failCount}`);

        renderRuntimeMeta(payload.environment || {}, payload.generatedAt);
        renderChecklist(payload.checklist || []);

        showStatus(`Loaded ${passCount + warnCount + failCount} controls from ${endpoint}.`);
    } catch (err) {
        console.error('security posture load error', err);
        showStatus(`Failed to load posture: ${err.message}`);
    }
}
