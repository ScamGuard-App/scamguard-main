require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const { analyzeReport } = require('./llmAnalysis.js');

function parseAllowedOrigins(raw) {
    return String(raw || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

const app = express();
const defaultAllowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
];
const configuredAllowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const allowedOrigins = configuredAllowedOrigins.length > 0
    ? configuredAllowedOrigins
    : defaultAllowedOrigins;

app.use(cors({
    origin: (origin, callback) => {
        // Allow server-to-server calls and tools that do not send an Origin header.
        if (!origin) {
            callback(null, true);
            return;
        }

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));

// serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Redis queue for report analysis
const reportAnalysisQueue = new Queue('report-analysis', {
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
    },
});

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function parseEvidencePaths(evidenceUrl) {
    if (!evidenceUrl) return [];

    try {
        if (Array.isArray(evidenceUrl)) return evidenceUrl;
        if (typeof evidenceUrl === 'string' && evidenceUrl.startsWith('[')) {
            return JSON.parse(evidenceUrl);
        }
        if (typeof evidenceUrl === 'string') return [evidenceUrl];
    } catch (err) {
        console.warn('[Server] Failed to parse evidence_url:', err.message);
    }

    return [];
}

async function withTimeout(promise, ms, timeoutMessage) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function parseAnalysisJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch (_err) {
            return null;
        }
    }
    return null;
}

function normalizeAnalysisRecord(record) {
    if (!record) return null;
    return {
        ...record,
        analysis_json: parseAnalysisJson(record.analysis_json),
    };
}

function scoreAnalysisRecord(record) {
    if (!record) return -1;

    const riskScore = Number(record.risk_score);
    const hasRiskScore = Number.isFinite(riskScore);
    const analysisJson = record.analysis_json || {};
    const status = String(analysisJson.status || '').toLowerCase();
    const hasSummary = Boolean(`${record.summary || ''}${analysisJson.incident_summary || ''}`.trim());
    const hasError = Boolean(analysisJson.error);

    let rank = 0;
    if (hasRiskScore) rank += 100;
    if (hasSummary) rank += 10;
    if (status === 'completed') rank += 5;
    if (status === 'pending' || status === 'not_started') rank -= 2;
    if (hasError) rank -= 5;

    return rank;
}

function pickBestAnalysisRecord(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;

    const currentRank = scoreAnalysisRecord(current);
    const candidateRank = scoreAnalysisRecord(candidate);

    if (candidateRank > currentRank) return candidate;
    if (candidateRank < currentRank) return current;

    const currentTime = new Date(current.created_at || 0).getTime();
    const candidateTime = new Date(candidate.created_at || 0).getTime();
    return candidateTime >= currentTime ? candidate : current;
}

function hasUsableAnalysis(record) {
    if (!record) return false;
    const analysis = record.analysis_json || {};
    const summaryText = `${record.summary || ''}${analysis.incident_summary || ''}${analysis.evidence_analysis || ''}`.trim();
    const risk = Number(record.risk_score);
    const status = String(analysis.status || '').toLowerCase();
    const hasError = Boolean(analysis.error);
    const hasNarrative = summaryText.length >= 25;
    const redFlags = Array.isArray(analysis.red_flags) ? analysis.red_flags.length : 0;
    const recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations.length : 0;

    if (hasError) return false;
    if (status === 'pending' || status === 'not_started') return false;
    if (hasNarrative || redFlags > 0 || recommendations > 0) return true;
    if (Number.isFinite(risk) && risk > 0) return true;
    if (Number.isFinite(risk) && risk === 0 && status === 'completed' && hasNarrative) return true;

    return false;
}

async function requireAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length).trim()
            : '';

        if (!token) {
            return res.status(401).json({ error: 'Missing bearer token' });
        }

        const { data: authData, error: authError } = await supabase.auth.getUser(token);
        if (authError || !authData?.user) {
            return res.status(401).json({ error: 'Invalid auth token' });
        }

        const userId = authData.user.id;
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', userId)
            .maybeSingle();

        if (profileError) {
            console.error('[Server] Admin guard profile error:', profileError);
            return res.status(500).json({ error: 'Failed to validate admin access' });
        }

        if (!profile?.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        req.adminUserId = userId;
        next();
    } catch (err) {
        console.error('[Server] Admin guard error:', err);
        return res.status(500).json({ error: 'Admin guard failure' });
    }
}

async function fetchAuthUsers() {
    const url = `${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`;
    const resp = await fetch(url, {
        method: 'GET',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Auth users fetch failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.users || [];
}

async function buildAdminAnalysisSnapshot() {
    const { data: reports, error: reportsError } = await supabase
        .from('reports')
        .select('report_id, user_id, title, type, created_at')
        .order('created_at', { ascending: false });

    if (reportsError) throw reportsError;

    const reportIds = (reports || []).map(r => r.report_id).filter(Boolean);
    const { data: analyses, error: analysesError } = reportIds.length
        ? await supabase
            .from('ai_analysis')
            .select('id, report_id, risk_score, summary, analysis_json, created_at')
            .in('report_id', reportIds)
            .order('created_at', { ascending: false })
        : { data: [], error: null };

    if (analysesError) throw analysesError;

    const analysisMap = {};
    for (const row of (analyses || [])) {
        const normalized = normalizeAnalysisRecord(row);
        analysisMap[row.report_id] = pickBestAnalysisRecord(analysisMap[row.report_id], normalized);
    }

    let missingAiCount = 0;
    for (const report of (reports || [])) {
        if (!hasUsableAnalysis(analysisMap[report.report_id])) {
            missingAiCount += 1;
        }
    }

    return {
        reports: reports || [],
        analysisMap,
        missingAiCount,
    };
}

async function ensureAnalysisRowForReport(reportId) {
    const { data, error } = await supabase
        .from('ai_analysis')
        .select('id')
        .eq('report_id', reportId)
        .limit(1);

    if (error) throw error;
    if ((data || []).length > 0) return;

    const { error: insertError } = await supabase
        .from('ai_analysis')
        .insert({
            report_id: reportId,
            type: 'scam_analysis',
            analysis_json: { status: 'pending' },
        });

    if (insertError) throw insertError;
}

// simple endpoint used by the client to delete the currently logged-in user.
// the request is POST /delete-account with JSON { user_id: '...' }.
// this handler uses the Supabase service-role key (read from .env) to call
// the admin Users API. Never expose the service key to the browser.
app.post('/delete-account', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'missing user_id' });

    try {
        const url = `${process.env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
        });
        if (!resp.ok) {
            const text = await resp.text();
            return res.status(resp.status).send(text);
        }
        res.sendStatus(204);
    } catch (err) {
        console.error('delete-user error', err);
        res.status(500).json({ error: 'server error' });
    }
});

/**
 * Queue report for LLM analysis
 * Call this after saving a report to the database
 * Request: POST /queue-analysis with JSON { report_id: '...' }
 */
app.post('/queue-analysis', async (req, res) => {
    const { report_id } = req.body;
    if (!report_id) return res.status(400).json({ error: 'missing report_id' });

    try {
        console.log('[Server] /queue-analysis called for report:', report_id);
        
        // First verify the report exists
        const { data: reportExists, error: reportError } = await supabase
            .from('reports')
            .select('report_id')
            .eq('report_id', report_id)
            .single();
        
        console.log('[Server] Report exists check:', reportExists, reportError);
        
        if (reportError || !reportExists) {
            console.error('[Server] Report not found:', report_id);
            return res.status(404).json({ error: 'Report not found' });
        }
        
        // Check if analysis already exists for this report
        const { data: existing, error: checkError } = await supabase
            .from('ai_analysis')
            .select('id')
            .eq('report_id', report_id)
            .single();

        console.log('[Server] Existing analysis check:', existing, checkError);

        // Only insert if it doesn't exist
        if (!existing && checkError?.code === 'PGRST116') {
            console.log('[Server] Creating new ai_analysis record for report:', report_id);
            const { error: insertError, data: insertData } = await supabase
                .from('ai_analysis')
                .insert({
                    report_id,
                    type: 'scam_analysis',
                    analysis_json: { status: 'pending' },
                })
                .select();

            console.log('[Server] Insert result:', insertData, insertError);
            
            if (insertError) {
                console.error('[Server] Insert error details:', insertError);
                throw insertError;
            }
        } else if (existing) {
            console.log('[Server] Analysis record already exists for report:', report_id);
        }

        // Add job to queue. If Redis/worker is unavailable, run analysis inline as fallback.
        try {
            const job = await withTimeout(
                reportAnalysisQueue.add({ reportId: report_id }, {
                    attempts: 1,  // No retries - rate limit errors shouldn't auto-retry
                    removeOnComplete: false,
                }),
                2000,
                'Queue add timed out (Redis unavailable)'
            );

            console.log(`[Server] Report ${report_id} queued for analysis, job ID: ${job.id}`);
            return res.json({
                success: true,
                mode: 'queued',
                jobId: job.id,
                reportId: report_id,
            });
        } catch (queueErr) {
            console.warn('[Server] Queue unavailable, falling back to inline analysis:', queueErr.message);

            const { data: reportData, error: reportFetchError } = await supabase
                .from('reports')
                .select('*')
                .eq('report_id', report_id)
                .single();

            if (reportFetchError || !reportData) {
                throw new Error(`Fallback failed to fetch report: ${reportFetchError?.message || 'No data'}`);
            }

            const evidencePaths = parseEvidencePaths(reportData.evidence_url);
            const analysisResult = await analyzeReport(report_id, reportData, evidencePaths);

            const { error: updateError } = await supabase
                .from('ai_analysis')
                .update({
                    risk_score: analysisResult.risk_score || null,
                    type: 'scam_analysis',
                    summary: analysisResult.incident_summary || '',
                    analysis_json: analysisResult,
                })
                .eq('report_id', report_id);

            if (updateError) {
                throw new Error(`Fallback update failed: ${updateError.message}`);
            }

            return res.json({
                success: true,
                mode: 'inline',
                reportId: report_id,
            });
        }
    } catch (err) {
        console.error('[Server] Queue analysis error:', err);
        res.status(500).json({ error: 'Failed to queue analysis' });
    }
});

/**
 * Check analysis status for a report
 * Request: GET /analysis-status/:report_id
 * Returns the ai_analysis record with current analysis status
 */
app.get('/analysis-status/:report_id', async (req, res) => {
    const { report_id } = req.params;

    try {
        const { data, error } = await supabase
            .from('ai_analysis')
            .select('*')
            .eq('report_id', report_id)
            .single();

        if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows found

        if (!data) {
            return res.json({
                status: 'not_started',
                report_id,
            });
        }

        // Determine status based on content
        let status = 'pending';
        if (data.analysis_json?.error) {
            status = 'failed';
        } else if (data.risk_score !== null && data.summary) {
            status = 'completed';
        }

        res.json({
            status,
            report_id,
            analysis: data,
        });
    } catch (err) {
        console.error('[Server] Analysis status error:', err);
        res.status(500).json({ error: 'Failed to retrieve analysis status' });
    }
});

/**
 * Get all analyses for a specific report (usually just one, but kept flexible)
 * Request: GET /analyses/:report_id
 */
app.get('/analyses/:report_id', async (req, res) => {
    const { report_id } = req.params;

    try {
        const { data, error } = await supabase
            .from('ai_analysis')
            .select('*')
            .eq('report_id', report_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ analyses: data });
    } catch (err) {
        console.error('[Server] Analyses fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch analyses' });
    }
});

/**
 * Get reports enriched with latest AI analysis per report.
 * Uses service role on backend to avoid frontend RLS visibility issues.
 */
app.get('/reports-with-analysis', async (req, res) => {
    try {
        const { data: reports, error: reportsError } = await supabase
            .from('reports')
            .select('*')
            .order('created_at', { ascending: false });

        if (reportsError) throw reportsError;

        const reportIds = (reports || []).map(r => r.report_id).filter(Boolean);
        if (reportIds.length === 0) {
            return res.json({ reports: [] });
        }

        const { data: analyses, error: analysesError } = await supabase
            .from('ai_analysis')
            .select('*')
            .in('report_id', reportIds)
            .order('created_at', { ascending: false });

        if (analysesError) throw analysesError;

        // Keep the most useful analysis per report_id (completed/scored beats pending/error).
        const analysisMap = {};
        for (const analysis of (analyses || [])) {
            const normalized = normalizeAnalysisRecord(analysis);
            analysisMap[analysis.report_id] = pickBestAnalysisRecord(analysisMap[analysis.report_id], normalized);
        }

        const enriched = (reports || []).map(report => ({
            ...report,
            aiAnalysis: analysisMap[report.report_id] || null,
        }));

        res.json({ reports: enriched });
    } catch (err) {
        console.error('[Server] reports-with-analysis error:', err);
        res.status(500).json({ error: 'Failed to load reports with analysis' });
    }
});

/**
 * Admin dashboard summary data.
 */
app.get('/admin/dashboard-data', requireAdmin, async (req, res) => {
    try {
        const [snapshot, users] = await Promise.all([
            buildAdminAnalysisSnapshot(),
            fetchAuthUsers(),
        ]);

        res.json({
            totals: {
                reports: snapshot.reports.length,
                users: users.length,
                reportsWithoutAI: snapshot.missingAiCount,
            },
        });
    } catch (err) {
        console.error('[Server] admin dashboard-data error:', err);
        res.status(500).json({ error: 'Failed to load admin dashboard data' });
    }
});

/**
 * Admin: queue AI reruns for reports.
 * Body: { mode: 'missing' | 'all', limit?: number, dryRun?: boolean }
 */
app.post('/admin/rerun-ai', requireAdmin, async (req, res) => {
    try {
        const mode = req.body?.mode === 'all' ? 'all' : 'missing';
        const dryRun = Boolean(req.body?.dryRun);
        const rawLimit = Number(req.body?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), 500)
            : null;

        const snapshot = await buildAdminAnalysisSnapshot();
        let candidates = snapshot.reports.filter((report) => {
            if (mode === 'all') return true;
            return !hasUsableAnalysis(snapshot.analysisMap[report.report_id]);
        });

        if (limit) {
            candidates = candidates.slice(0, limit);
        }

        if (dryRun) {
            return res.json({
                success: true,
                dryRun: true,
                mode,
                totalCandidates: candidates.length,
                reportIds: candidates.map(r => r.report_id),
            });
        }

        let queued = 0;
        const failures = [];
        for (const report of candidates) {
            try {
                await ensureAnalysisRowForReport(report.report_id);
                await reportAnalysisQueue.add({ reportId: report.report_id }, {
                    attempts: 1,
                    removeOnComplete: false,
                });
                queued += 1;
            } catch (queueErr) {
                failures.push({ reportId: report.report_id, error: queueErr.message });
            }
        }

        res.json({
            success: true,
            mode,
            queued,
            totalCandidates: candidates.length,
            failed: failures.length,
            failures,
        });
    } catch (err) {
        console.error('[Server] admin rerun-ai error:', err);
        res.status(500).json({ error: 'Failed to queue AI reruns' });
    }
});

/**
 * Admin: list users from Supabase Auth.
 */
app.get('/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await fetchAuthUsers();
        const shaped = users.map((u) => ({
            id: u.id,
            email: u.email,
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at,
            username: u.user_metadata?.username || null,
        }));

        res.json({ users: shaped });
    } catch (err) {
        console.error('[Server] admin users error:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * Admin: delete an auth user.
 */
app.delete('/admin/users/:userId', requireAdmin, async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'Missing user ID' });

    try {
        const url = `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
        });

        if (!resp.ok) {
            const text = await resp.text();
            return res.status(resp.status).send(text);
        }

        res.json({ success: true, userId });
    } catch (err) {
        console.error('[Server] admin user delete error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

/**
 * Admin: list reports using service role (bypasses frontend RLS issues).
 */
app.get('/admin/reports', requireAdmin, async (req, res) => {
    try {
        const rawLimit = Number(req.query.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), 500)
            : 200;

        const { data, error } = await supabase
            .from('reports')
            .select('report_id, title, type, user_id, created_at')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) {
        console.error('[Server] admin reports error:', err);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

/**
 * Admin: delete report and its related ai_analysis entries.
 */
app.delete('/admin/reports/:reportId', requireAdmin, async (req, res) => {
    const reportId = req.params.reportId;
    if (!reportId) return res.status(400).json({ error: 'Missing report ID' });

    try {
        const { data: reportRow, error: lookupError } = await supabase
            .from('reports')
            .select('report_id')
            .eq('report_id', reportId)
            .maybeSingle();

        if (lookupError) throw lookupError;
        if (!reportRow) return res.status(404).json({ error: 'Report not found' });

        const { error: deleteReportError } = await supabase
            .from('reports')
            .delete()
            .eq('report_id', reportId);

        if (deleteReportError) throw deleteReportError;

        if (reportRow.report_id) {
            const { error: deleteAiError } = await supabase
                .from('ai_analysis')
                .delete()
                .eq('report_id', reportRow.report_id);

            if (deleteAiError) {
                console.warn('[Server] Failed to delete related ai_analysis rows:', deleteAiError.message);
            }
        }

        res.json({ success: true, report_id: reportRow.report_id });
    } catch (err) {
        console.error('[Server] admin delete report error:', err);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

// fallback: serve index.html for any unmatched routes (SPA support)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
    console.log('[Server] Allowed CORS origins:', allowedOrigins.join(', '));
});
