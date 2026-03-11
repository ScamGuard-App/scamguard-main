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
    'https://scamguard-app.github.io',
];
const configuredAllowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const allowedOrigins = configuredAllowedOrigins.length > 0
    ? configuredAllowedOrigins
    : defaultAllowedOrigins;
const USE_REDIS_QUEUE = String(process.env.USE_REDIS_QUEUE || 'true').toLowerCase() !== 'false';
const ENABLE_INLINE_ANALYSIS_FALLBACK = String(process.env.ENABLE_INLINE_ANALYSIS_FALLBACK || 'true').toLowerCase() !== 'false';
const INLINE_ADMIN_RERUN_MAX = Number(process.env.INLINE_ADMIN_RERUN_MAX || 25);
const LLM_PROVIDER = String(process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const OLLAMA_URL = String(process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');

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

const isProd = process.env.NODE_ENV === 'production';

// use helmet for security headers, with a strict content security policy
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // can remove later?
        "https://cdnjs.cloudflare.com"
      ],
      imgSrc: ["'self'", "data:"],
      connectSrc: [
        "'self'",
        process.env.SUPABASE_URL,
        "https://scamguard-main.onrender.com"
      ].filter(Boolean),
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: "no-referrer" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  xDnsPrefetchControl: { allow: false },
  noSniff: true,
  frameguard: { action: "deny" }
}));

// serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Redis queue for report analysis (now handled by render)
const reportAnalysisQueue = USE_REDIS_QUEUE
    ? new Queue('report-analysis', {
        redis: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: process.env.REDIS_PORT || 6379,
        },
    })
    : null;

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

function isUuid(value) {
    const normalized = String(value || '').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
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

async function isQueueReady() {
    if (!reportAnalysisQueue) return false;

    try {
        await withTimeout(
            reportAnalysisQueue.isReady(),
            1500,
            'Redis queue readiness check timed out'
        );
        return true;
    } catch (_err) {
        return false;
    }
}

async function processAnalysisInline(reportId) {
    const { data: reportData, error: reportFetchError } = await supabase
        .from('reports')
        .select('*')
        .eq('report_id', reportId)
        .single();

    if (reportFetchError || !reportData) {
        throw new Error(`Inline analysis could not fetch report: ${reportFetchError?.message || 'No data'}`);
    }

    const evidencePaths = parseEvidencePaths(reportData.evidence_url);
    const analysisResult = await analyzeReport(reportId, reportData, evidencePaths);

    const { error: updateError } = await supabase
        .from('ai_analysis')
        .update({
            risk_score: analysisResult.risk_score || null,
            type: 'scam_analysis',
            summary: analysisResult.incident_summary || '',
            analysis_json: analysisResult,
        })
        .eq('report_id', reportId);

    if (updateError) {
        throw new Error(`Inline analysis update failed: ${updateError.message}`);
    }

    return analysisResult;
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
    if (!isUuid(report_id)) return res.status(400).json({ error: 'invalid report_id format' });

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
        const { data: existingRows, error: checkError } = await supabase
            .from('ai_analysis')
            .select('id')
            .eq('report_id', report_id)
            .order('created_at', { ascending: false })
            .limit(1);

        const existing = (existingRows && existingRows.length > 0) ? existingRows[0] : null;

        console.log('[Server] Existing analysis check:', existing, checkError);

        if (checkError) {
            throw checkError;
        }

        // Only insert if no analysis row exists yet.
        if (!existing) {
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

        const queueReady = await isQueueReady();

        if (queueReady) {
            const job = await withTimeout(
                reportAnalysisQueue.add({ reportId: report_id }, {
                    attempts: 1,
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
        }

        if (!ENABLE_INLINE_ANALYSIS_FALLBACK) {
            return res.status(503).json({
                success: false,
                error: 'AI queue unavailable and inline analysis fallback is disabled',
            });
        }

        console.warn('[Server] Queue unavailable, running analysis inline in background');
        setImmediate(async () => {
            try {
                await processAnalysisInline(report_id);
            } catch (inlineErr) {
                console.error(`[Server] Inline analysis failed for ${report_id}:`, inlineErr.message);
                await supabase
                    .from('ai_analysis')
                    .update({
                        analysis_json: {
                            status: 'failed',
                            error: inlineErr.message,
                        },
                    })
                    .eq('report_id', report_id);
            }
        });

        return res.status(202).json({
            success: true,
            mode: 'inline-background',
            reportId: report_id,
        });
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
    if (!isUuid(report_id)) {
        return res.status(400).json({ error: 'Invalid report_id format' });
    }

    try {
        const { data, error } = await supabase
            .from('ai_analysis')
            .select('*')
            .eq('report_id', report_id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            return res.json({
                status: 'not_started',
                report_id,
            });
        }

        let best = null;
        for (const row of data) {
            best = pickBestAnalysisRecord(best, normalizeAnalysisRecord(row));
        }

        // Determine status based on content
        let status = 'pending';
        if (best?.analysis_json?.error) {
            status = 'failed';
        } else if (hasUsableAnalysis(best)) {
            status = 'completed';
        }

        res.json({
            status,
            report_id,
            analysis: best,
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
    if (!isUuid(report_id)) {
        return res.status(400).json({ error: 'Invalid report_id format' });
    }

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

        const runRerunInBackground = async () => {
            const queueReady = await isQueueReady();

            if (queueReady) {
                for (const report of candidates) {
                    try {
                        await ensureAnalysisRowForReport(report.report_id);
                        await reportAnalysisQueue.add({ reportId: report.report_id }, {
                            attempts: 1,
                            removeOnComplete: false,
                        });
                    } catch (queueErr) {
                        console.error(`[Server] Background queue rerun failed for ${report.report_id}:`, queueErr.message);
                    }
                }
                return;
            }

            if (!ENABLE_INLINE_ANALYSIS_FALLBACK) {
                console.warn('[Server] Skipping background inline rerun: fallback disabled');
                return;
            }

            const cap = Number.isFinite(INLINE_ADMIN_RERUN_MAX) && INLINE_ADMIN_RERUN_MAX > 0
                ? Math.floor(INLINE_ADMIN_RERUN_MAX)
                : 25;
            const selected = candidates.slice(0, cap);

            for (const report of selected) {
                try {
                    await ensureAnalysisRowForReport(report.report_id);
                    await processAnalysisInline(report.report_id);
                } catch (inlineErr) {
                    console.error(`[Server] Inline admin rerun failed for ${report.report_id}:`, inlineErr.message);
                    await supabase
                        .from('ai_analysis')
                        .update({
                            analysis_json: {
                                status: 'failed',
                                error: inlineErr.message,
                            },
                        })
                        .eq('report_id', report.report_id);
                }
            }
        };

        // Always return quickly so frontend navigation does not cancel long-running rerun requests.
        setImmediate(() => {
            runRerunInBackground().catch((bgErr) => {
                console.error('[Server] admin rerun-ai background task failed:', bgErr);
            });
        });

        return res.status(202).json({
            success: true,
            mode,
            executionMode: 'background',
            queued: candidates.length,
            totalCandidates: candidates.length,
            failed: 0,
            note: 'AI rerun accepted and started in background.',
        });
    } catch (err) {
        console.error('[Server] admin rerun-ai error:', err);
        res.status(500).json({ error: 'Failed to queue AI reruns' });
    }
});

/**
 * Admin: AI diagnostics snapshot (provider config, reachability, queue state, recent errors).
 */
app.get('/admin/ai-diagnostics', requireAdmin, async (req, res) => {
    try {
        const diagnostics = {
            provider: LLM_PROVIDER,
            queueReady: false,
            inlineFallbackEnabled: ENABLE_INLINE_ANALYSIS_FALLBACK,
            providerReachable: null,
            providerMessage: '',
            recentFailures: [],
            checkedAt: new Date().toISOString(),
        };

        diagnostics.queueReady = await isQueueReady();

        if (LLM_PROVIDER === 'ollama') {
            try {
                const response = await withTimeout(
                    fetch(`${OLLAMA_URL}/api/tags`),
                    5000,
                    'Ollama connectivity check timed out'
                );
                diagnostics.providerReachable = response.ok;
                diagnostics.providerMessage = response.ok
                    ? `Ollama reachable at ${OLLAMA_URL}`
                    : `Ollama returned HTTP ${response.status} at ${OLLAMA_URL}`;
            } catch (err) {
                diagnostics.providerReachable = false;
                diagnostics.providerMessage = `Ollama check failed at ${OLLAMA_URL}: ${err.message}`;
            }
        } else if (LLM_PROVIDER === 'gemini') {
            const hasKey = Boolean(process.env.GOOGLE_API_KEY);
            diagnostics.providerReachable = hasKey;
            diagnostics.providerMessage = hasKey
                ? 'Gemini selected and GOOGLE_API_KEY is present'
                : 'Gemini selected but GOOGLE_API_KEY is missing';
        } else {
            diagnostics.providerReachable = false;
            diagnostics.providerMessage = `Unknown LLM_PROVIDER: ${LLM_PROVIDER}`;
        }

        // Pull recent analysis rows and surface failed/error records.
        const { data: analyses, error: analysisError } = await supabase
            .from('ai_analysis')
            .select('report_id, created_at, analysis_json')
            .order('created_at', { ascending: false })
            .limit(80);

        if (analysisError) throw analysisError;

        const failedRows = (analyses || [])
            .map((row) => {
                const parsed = parseAnalysisJson(row.analysis_json) || {};
                const status = String(parsed.status || '').toLowerCase();
                const errMessage = String(parsed.error || '').trim();
                if (status !== 'failed' && !errMessage) return null;
                return {
                    report_id: row.report_id,
                    created_at: row.created_at,
                    status: status || 'failed',
                    error: errMessage || 'Unknown analysis error',
                };
            })
            .filter(Boolean)
            .slice(0, 8);

        const ids = [...new Set(failedRows.map((r) => r.report_id).filter(Boolean))];
        const reportTitles = {};
        if (ids.length > 0) {
            const { data: reports, error: reportError } = await supabase
                .from('reports')
                .select('report_id, title')
                .in('report_id', ids);
            if (!reportError) {
                (reports || []).forEach((r) => {
                    reportTitles[r.report_id] = r.title || null;
                });
            }
        }

        diagnostics.recentFailures = failedRows.map((row) => ({
            ...row,
            title: reportTitles[row.report_id] || null,
        }));

        res.json({ success: true, diagnostics });
    } catch (err) {
        console.error('[Server] admin ai-diagnostics error:', err);
        res.status(500).json({ error: `Failed to run AI diagnostics: ${err.message}` });
    }
});

/**
 * Admin: security posture snapshot (high-level controls + quick signals).
 */
app.get('/admin/security-posture', requireAdmin, async (req, res) => {
    try {
        const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
        const hasAnonKey = Boolean(process.env.SUPABASE_ANON_KEY);
        const hasSupabaseUrl = Boolean(process.env.SUPABASE_URL);
        const hasBackendSupabaseConfig = hasServiceRole && hasSupabaseUrl;
        const corsUsesEnvAllowlist = configuredAllowedOrigins.length > 0;
        const hasWildcardCors = allowedOrigins.includes('*');

        const listenPort = process.env.PORT || 3000;
        const inferredBaseUrl = `${req.protocol}://${req.get('host')}`;
        const baseUrlCandidates = [
            `http://127.0.0.1:${listenPort}`,
            inferredBaseUrl,
        ];

        async function safeFetch(pathname) {
            let lastError = null;

            for (const baseUrl of baseUrlCandidates) {
                const url = `${baseUrl}${pathname}`;
                try {
                    return await fetch(url, {
                        method: 'GET',
                        headers: {
                            Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                        },
                    });
                } catch (err) {
                    lastError = err;
                }
            }

            throw lastError || new Error('Self-check request failed');
        }

        async function runHeaderChecks() {
            const response = await safeFetch('/');
            const csp = response.headers.get('content-security-policy');
            const xfo = response.headers.get('x-frame-options');
            const xcto = response.headers.get('x-content-type-options');
            const referrer = response.headers.get('referrer-policy');
            const hsts = response.headers.get('strict-transport-security');

            return {
                csp: Boolean(csp),
                xfo: Boolean(xfo),
                xcto: Boolean(xcto),
                referrerPolicy: Boolean(referrer),
                hsts: Boolean(hsts),
            };
        }

        async function runUnauthorizedAdminCheck() {
            const response = await safeFetch('/admin/dashboard-data');
            return response.status === 401 || response.status === 403;
        }

        async function runSqliProbe() {
            const probe = encodeURIComponent("' OR '1'='1");
            const response = await safeFetch(`/analysis-status/${probe}`);
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            // Probe should never trigger a server error regardless of path payload.
            return response.status < 500 && contentType.includes('application/json');
        }

        async function runXssProbe() {
            const probe = encodeURIComponent('<script>alert(1)</script>');
            const response = await safeFetch(`/analysis-status/${probe}`);
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            // For this API route we expect strict JSON responses, not executable HTML.
            return contentType.includes('application/json');
        }

        const [headerChecks, unauthorizedAdminBlocked, sqliProbeSafe, xssProbeSafe] = await Promise.all([
            runHeaderChecks(),
            runUnauthorizedAdminCheck(),
            runSqliProbe(),
            runXssProbe(),
        ]);

        const missingHeaders = [
            headerChecks.csp ? null : 'CSP',
            headerChecks.xfo ? null : 'X-Frame-Options',
            headerChecks.xcto ? null : 'X-Content-Type-Options',
            headerChecks.referrerPolicy ? null : 'Referrer-Policy',
        ].filter(Boolean);

        const checklist = [
            {
                id: 'admin-auth-guard',
                title: 'Admin API Authorization Guard',
                status: unauthorizedAdminBlocked ? 'pass' : 'fail',
                details: unauthorizedAdminBlocked
                    ? 'Unauthenticated request to /admin/dashboard-data was blocked.'
                    : 'Unauthenticated request to /admin/dashboard-data was not blocked as expected.',
            },
            {
                id: 'cors-allowlist',
                title: 'Origin Allowlist (CORS)',
                status: hasWildcardCors ? 'fail' : (corsUsesEnvAllowlist ? 'pass' : 'warn'),
                details: hasWildcardCors
                    ? 'Wildcard CORS origin detected; use explicit allowlist only.'
                    : (corsUsesEnvAllowlist
                        ? 'CORS_ALLOWED_ORIGINS is configured via environment.'
                        : 'Using default allowlist. Configure CORS_ALLOWED_ORIGINS for production.'),
            },
            {
                id: 'security-headers',
                title: 'Security Headers Coverage',
                status: missingHeaders.length === 0 ? 'pass' : 'warn',
                details: missingHeaders.length === 0
                    ? 'CSP, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy were detected.'
                    : `Missing or undetected headers: ${missingHeaders.join(', ')}`,
            },
            {
                id: 'hsts-production',
                title: 'HSTS in Production',
                status: isProd ? (headerChecks.hsts ? 'pass' : 'warn') : 'warn',
                details: isProd
                    ? (headerChecks.hsts
                        ? 'Strict-Transport-Security header detected in production mode.'
                        : 'Production mode detected but Strict-Transport-Security header was not observed.')
                    : 'NODE_ENV is not production, so HSTS is advisory only in this environment.',
            },
            {
                id: 'service-role-storage',
                title: 'Service Role Key Kept Server-Side',
                status: hasServiceRole ? 'pass' : 'fail',
                details: hasServiceRole
                    ? 'SUPABASE_SERVICE_ROLE_KEY exists on backend environment.'
                    : 'SUPABASE_SERVICE_ROLE_KEY missing on backend environment.',
            },
            {
                id: 'supabase-runtime-config',
                title: 'Supabase Runtime Config Present',
                status: hasBackendSupabaseConfig ? 'pass' : 'fail',
                details: hasBackendSupabaseConfig
                    ? (hasAnonKey
                        ? 'Backend SUPABASE_URL + service-role config is present; ANON key also present.'
                        : 'Backend SUPABASE_URL + service-role config is present; ANON key is not required server-side.')
                    : 'Missing backend SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.',
            },
            {
                id: 'xss-probe',
                title: 'Basic Reflected XSS Probe (API)',
                status: xssProbeSafe ? 'pass' : 'warn',
                details: xssProbeSafe
                    ? 'Script-tag probe returned JSON response (not executable HTML).'
                    : 'Probe did not return JSON as expected. Review output encoding and response handling.',
            },
            {
                id: 'sqli-probe',
                title: 'Basic SQL Injection Probe (Path Param)',
                status: sqliProbeSafe ? 'pass' : 'warn',
                details: sqliProbeSafe
                    ? 'SQLi-like payload did not trigger server error on analysis-status route.'
                    : 'SQLi probe caused unexpected server behavior; inspect query/input handling paths.',
            },
            {
                id: 'rate-limit-awareness',
                title: 'Rate Limiting on Sensitive Routes',
                status: 'warn',
                details: 'No runtime assertion is present yet for rate limiting; recommended for auth/admin/report endpoints.',
            },
        ];

        const totals = {
            pass: checklist.filter((item) => item.status === 'pass').length,
            warn: checklist.filter((item) => item.status === 'warn').length,
            fail: checklist.filter((item) => item.status === 'fail').length,
            score: Math.round((checklist.filter((item) => item.status === 'pass').length / checklist.length) * 100),
        };

        res.json({
            generatedAt: new Date().toISOString(),
            environment: {
                nodeEnv: process.env.NODE_ENV || 'development',
                llmProvider: LLM_PROVIDER,
                useRedisQueue: USE_REDIS_QUEUE,
                inlineFallbackEnabled: ENABLE_INLINE_ANALYSIS_FALLBACK,
                allowedOriginsCount: allowedOrigins.length,
                inferredBaseUrl,
                selfCheckBaseCandidates: baseUrlCandidates,
            },
            totals,
            checklist,
        });
    } catch (err) {
        console.error('[Server] admin security-posture error:', err);
        res.status(500).json({ error: 'Failed to load security posture' });
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
    if (!isUuid(reportId)) return res.status(400).json({ error: 'Invalid report ID format' });

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
