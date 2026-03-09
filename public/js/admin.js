import supabase, { ensureSupabase } from './supabase.js';
import { escapeHtml } from './utils.js';
import { buildApiUrl, getApiCandidates } from './api.js';

const endpoints = {
    dashboard: getApiCandidates('/admin/dashboard-data'),
    rerun: [buildApiUrl('/admin/rerun-ai')],
    users: getApiCandidates('/admin/users'),
    reports: getApiCandidates('/admin/reports'),
};

let adminSupabase = null;
let adminAccessToken = null;

document.addEventListener('DOMContentLoaded', async () => {
    const sb = await ensureSupabase();
    if (!sb) return;
    adminSupabase = sb;

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

    if (!profile || !profile.is_admin) {
        showAlert('Access denied: you are not an administrator.');
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
        setTimeout(() => { window.location.href = 'index.html'; }, 3000);
        return;
    }

    bindActions();
    await Promise.all([
        loadDashboardStats(),
        loadReportsTable(),
        loadUsersTable(),
    ]);
});

function bindActions() {
    document.getElementById('rerunMissingAI')?.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await triggerAiRerun('missing');
    });

    document.getElementById('rerunAllAI')?.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const yes = window.confirm('Re-run AI for ALL reports? This may take a while and consume API quota.');
        if (!yes) return;
        await triggerAiRerun('all');
    });

    document.getElementById('refreshReportsBtn')?.addEventListener('click', async () => {
        await loadReportsTable();
        await loadDashboardStats();
    });

    document.getElementById('refreshUsersBtn')?.addEventListener('click', async () => {
        await loadUsersTable();
        await loadDashboardStats();
    });
}

async function fetchWithFallback(urls, options = {}) {
    let lastError = null;
    const method = String(options.method || 'GET').toUpperCase();
    const isMutatingRequest = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    const headers = {
        ...(options.headers || {}),
    };
    if (adminAccessToken) {
        headers.Authorization = `Bearer ${adminAccessToken}`;
    }

    for (const endpoint of urls) {
        // For mutating requests, never hit relative fallback URLs on the static host.
        if (isMutatingRequest && endpoint.startsWith('/')) {
            continue;
        }

        try {
            const response = await fetch(endpoint, {
                ...options,
                headers,
            });
            if ((response.status === 404 || response.status === 405) && endpoint.startsWith('/')) {
                continue;
            }

            const contentType = response.headers.get('content-type') || '';
            if (endpoint.startsWith('/') && !contentType.includes('application/json')) {
                continue;
            }

            const payload = await response.json().catch(() => ({}));
            return { response, payload, endpoint };
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No admin endpoint available');
}

async function loadDashboardStats() {
    try {
        const { response, payload } = await fetchWithFallback(endpoints.dashboard);
        if (!response.ok) throw new Error(payload.error || 'Failed to load dashboard data');

        const totals = payload.totals || {};
        setText('kpiReports', Number(totals.reports || 0).toLocaleString());
        setText('kpiReportsWithoutAI', Number(totals.reportsWithoutAI || 0).toLocaleString());
        setText('kpiUsers', Number(totals.users || 0).toLocaleString());
    } catch (err) {
        console.error('dashboard stats error', err);
        showAlert('Could not load admin dashboard metrics.');
    }
}

async function triggerAiRerun(mode) {
    const statusEl = document.getElementById('aiOpsStatus');
    const limitValue = Number(document.getElementById('rerunLimit')?.value || 0);
    const body = { mode };
    if (Number.isFinite(limitValue) && limitValue > 0) {
        body.limit = Math.floor(limitValue);
    }

    if (statusEl) {
        statusEl.textContent = 'Queueing AI jobs...';
    }

    try {
        const { response, payload } = await fetchWithFallback(endpoints.rerun, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
        });

        if (!response.ok) throw new Error(payload.error || 'Failed to queue AI rerun');

        if (statusEl) {
            const executionMode = payload.executionMode || payload.mode || 'queued';
            statusEl.textContent = `Queued ${payload.queued}/${payload.totalCandidates} reports for AI re-run (${mode}). Mode: ${executionMode}. Failed: ${payload.failed}.`;
        }

        await loadDashboardStats();
    } catch (err) {
        console.error('rerun ai error', err);
        if (statusEl) {
            statusEl.textContent = `Failed to queue AI jobs: ${err.message}`;
        }
    }
}

async function loadUsersTable() {
    const bodyEl = document.getElementById('adminUsersTableBody');
    if (!bodyEl) return;
    bodyEl.innerHTML = '<tr><td colspan="4" class="admin-empty">Loading users...</td></tr>';

    try {
        const { response, payload } = await fetchWithFallback(endpoints.users);
        if (!response.ok) throw new Error(payload.error || 'Failed to fetch users');

        const users = payload.users || [];
        if (users.length === 0) {
            bodyEl.innerHTML = '<tr><td colspan="4" class="admin-empty">No users found.</td></tr>';
            return;
        }

        bodyEl.innerHTML = users.map((u) => {
            const created = u.created_at ? new Date(u.created_at).toLocaleDateString() : 'N/A';
            return `
                <tr>
                    <td>${escapeHtml(u.email || 'N/A')}</td>
                    <td>${escapeHtml(u.username || 'N/A')}</td>
                    <td>${escapeHtml(created)}</td>
                    <td>
                        <button class="btn btn-reset admin-delete-user" data-user-id="${escapeHtml(u.id)}">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        bodyEl.querySelectorAll('.admin-delete-user').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const userId = btn.getAttribute('data-user-id');
                if (!userId) return;

                const yes = window.confirm('Delete this user account? This action cannot be undone.');
                if (!yes) return;

                try {
                    const { response, payload } = await fetchWithFallback(endpoints.users.map((url) => `${url}/${userId}`), {
                        method: 'DELETE',
                    });

                    if (!response.ok) throw new Error(payload.error || 'Failed to delete user');
                    await loadUsersTable();
                    await loadDashboardStats();
                } catch (err) {
                    console.error('delete user error', err);
                    showAlert(`Failed to delete user: ${err.message}`);
                }
            });
        });
    } catch (err) {
        console.error('load users error', err);
        bodyEl.innerHTML = '<tr><td colspan="4" class="admin-empty">Error loading users.</td></tr>';
    }
}

async function loadReportsTable() {
    const bodyEl = document.getElementById('adminReportsTableBody');
    if (!bodyEl) return;
    bodyEl.innerHTML = '<tr><td colspan="5" class="admin-empty">Loading reports...</td></tr>';

    try {
        const { response, payload } = await fetchWithFallback(endpoints.reports);
        if (!response.ok) throw new Error(payload.error || 'Failed to fetch reports');
        const reports = payload.reports || [];

        if (reports.length === 0) {
            bodyEl.innerHTML = '<tr><td colspan="5" class="admin-empty">No reports found.</td></tr>';
            return;
        }

        bodyEl.innerHTML = reports.map((r) => {
            const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'N/A';
            return `
                <tr>
                    <td>${escapeHtml(r.title || 'Untitled')}</td>
                    <td>${escapeHtml(r.type || 'N/A')}</td>
                    <td>${escapeHtml(r.user_id || 'N/A')}</td>
                    <td>${escapeHtml(date)}</td>
                    <td>
                        <button class="btn btn-reset admin-delete-report" data-report-id="${escapeHtml(String(r.report_id || ''))}">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        bodyEl.querySelectorAll('.admin-delete-report').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const reportId = btn.getAttribute('data-report-id');
                if (!reportId) return;

                const yes = window.confirm('Remove this report?');
                if (!yes) return;

                try {
                    const { response, payload } = await fetchWithFallback(endpoints.reports.map((url) => `${url}/${encodeURIComponent(reportId)}`), {
                        method: 'DELETE',
                    });

                    if (!response.ok) throw new Error(payload.error || 'Failed to delete report');
                    await loadReportsTable();
                    await loadDashboardStats();
                } catch (err) {
                    console.error('delete report error', err);
                    showAlert('Failed to delete report.');
                }
            });
        });
    } catch (err) {
        console.error('load reports error', err);
        bodyEl.innerHTML = '<tr><td colspan="5" class="admin-empty">Error loading reports.</td></tr>';
    }
}

function showAlert(message) {
    const alertEl = document.getElementById('adminAlert');
    if (!alertEl) return;
    alertEl.textContent = message;
    alertEl.style.display = 'block';
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

