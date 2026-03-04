import supabase, { ensureSupabase } from './supabase.js';
import { escapeHtml } from './utils.js';

// only allow access if user is admin
document.addEventListener('DOMContentLoaded', async () => {
    const sb = await ensureSupabase();
    if (!sb) return;
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user) {
        window.location.href = 'index.html';
        return;
    }
    // check admin flag in profiles
    const { data: profile } = await sb.from('profiles').select('is_admin').eq('id', session.user.id).maybeSingle();
    if (!profile || !profile.is_admin) {
        const alertEl = document.getElementById('adminAlert');
        alertEl.textContent = 'Access denied: you are not an administrator.';
        alertEl.style.display = 'block';
        // hide rest of main content so only the warning is visible
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
        // optionally redirect after a moment
        setTimeout(() => { window.location.href = 'index.html'; }, 3000);
        return;
    }

    // load reports
    loadAllReports(sb);
});

async function loadAllReports(sb) {
    const container = document.getElementById('adminReportsContainer');
    if (!container) return;
    container.innerHTML = '<p style="grid-column:1/-1; text-align:center;">Loading...</p>';
    try {
        const { data, error } = await sb.from('reports').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        const reports = data || [];
        if (reports.length === 0) {
            container.innerHTML = '<p style="grid-column:1/-1; text-align:center;">No reports found.</p>';
            return;
        }
        container.innerHTML = '';
        reports.forEach(r => {
            const card = document.createElement('div');
            card.className = 'scam-card';
            const dateStr = new Date(r.created_at).toLocaleString();
            card.innerHTML = `
                <div class="scam-header">
                    <h3>${escapeHtml(r.type || 'Unknown')}</h3>
                    <span class="report-date">${dateStr}</span>
                </div>
                <div class="scam-details">
                    <div class="detail-row"><span class="label">Contact:</span><span class="value">${escapeHtml(r.phone||r.email||r.contact_info||'')}</span></div>
                    <div class="detail-row"><span class="label">Reporter:</span><span class="value">${escapeHtml(r.user_id)}</span></div>
                </div>
                <div style="margin-top:1rem; text-align:right;">
                    <button class="btn btn-reset delete-report" data-id="${r.id}">Delete</button>
                </div>
            `;
            container.appendChild(card);
        });
        // attach delete handlers
        container.querySelectorAll('button.delete-report').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                if (!confirm('Remove this report?')) return;
                try {
                    const { error } = await sb.from('reports').delete().eq('id', id);
                    if (error) throw error;
                    loadAllReports(sb);
                } catch (e) {
                    console.error('delete error', e);
                    alert('Failed to delete report.');
                }
            });
        });
    } catch (err) {
        console.error('admin load error', err);
        container.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:#e74c3c;">Error loading reports.</p>';
    }
}

