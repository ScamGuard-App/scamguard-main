require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const { analyzeReport } = require('./llmAnalysis.js');

const app = express();
app.use(cors());
app.use(express.json());

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

        // Keep the latest analysis per report_id.
        const analysisMap = {};
        for (const analysis of (analyses || [])) {
            if (!analysisMap[analysis.report_id]) {
                analysisMap[analysis.report_id] = analysis;
            }
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

// fallback: serve index.html for any unmatched routes (SPA support)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend listening on port ${port}`));
