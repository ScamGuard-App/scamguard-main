require('dotenv').config();
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const reportAnalysisQueue = new Queue('report-analysis', {
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
    },
});

function parseArgs(argv) {
    const args = {
        dryRun: false,
        force: false,
        limit: null,
    };

    for (const raw of argv.slice(2)) {
        const arg = String(raw || '').trim();
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--force') args.force = true;
        else if (arg.startsWith('--limit=')) {
            const value = Number(arg.split('=')[1]);
            if (Number.isFinite(value) && value > 0) args.limit = Math.floor(value);
        }
    }

    return args;
}

function isUsableAnalysis(row) {
    if (!row) return false;

    const analysis = row.analysis_json;
    const risk = Number(row.risk_score);
    if (analysis && typeof analysis === 'object') {
        const status = String(analysis.status || '').toLowerCase();
        const hasError = Boolean(analysis.error);
        const summaryText = `${row.summary || ''}${analysis.incident_summary || ''}${analysis.evidence_analysis || ''}`.trim();
        const hasNarrative = summaryText.length >= 25;
        const hasFlags = Array.isArray(analysis.red_flags) && analysis.red_flags.length > 0;
        const hasRecommendations = Array.isArray(analysis.recommendations) && analysis.recommendations.length > 0;

        if (hasError) return false;
        if (status === 'pending' || status === 'not_started') return false;
        if (hasNarrative || hasFlags || hasRecommendations) return true;
        if (Number.isFinite(risk) && risk > 0) return true;
        if (Number.isFinite(risk) && risk === 0 && status === 'completed' && hasNarrative) return true;

        return false;
    }

    if (Number.isFinite(risk) && risk > 0) return true;

    return false;
}

async function fetchReports() {
    const { data, error } = await supabase
        .from('reports')
        .select('report_id, created_at')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function fetchAnalyses(reportIds) {
    if (!reportIds.length) return [];

    const chunkSize = 500;
    const all = [];

    for (let i = 0; i < reportIds.length; i += chunkSize) {
        const ids = reportIds.slice(i, i + chunkSize);
        const { data, error } = await supabase
            .from('ai_analysis')
            .select('id, report_id, risk_score, summary, analysis_json, created_at')
            .in('report_id', ids)
            .order('created_at', { ascending: false });

        if (error) throw error;
        all.push(...(data || []));
    }

    return all;
}

function buildAnalysisMap(rows) {
    const map = new Map();

    for (const row of rows) {
        const reportId = row.report_id;
        if (!reportId) continue;

        const normalized = {
            ...row,
            analysis_json: typeof row.analysis_json === 'string'
                ? (() => {
                    try { return JSON.parse(row.analysis_json); } catch (_err) { return null; }
                })()
                : row.analysis_json,
        };

        const current = map.get(reportId);
        if (!current) {
            map.set(reportId, normalized);
            continue;
        }

        const currentUsable = isUsableAnalysis(current);
        const candidateUsable = isUsableAnalysis(normalized);

        if (!currentUsable && candidateUsable) {
            map.set(reportId, normalized);
            continue;
        }

        if (currentUsable === candidateUsable) {
            const currentTs = new Date(current.created_at || 0).getTime();
            const candidateTs = new Date(normalized.created_at || 0).getTime();
            if (candidateTs > currentTs) map.set(reportId, normalized);
        }
    }

    return map;
}

async function ensureAnalysisRow(reportId) {
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

async function queueReport(reportId) {
    await reportAnalysisQueue.add(
        { reportId },
        {
            attempts: 1,
            removeOnComplete: false,
        }
    );
}

async function run() {
    const args = parseArgs(process.argv);
    console.log('[Backfill] Starting with options:', args);

    const reports = await fetchReports();
    const reportIds = reports.map(r => r.report_id).filter(Boolean);
    console.log(`[Backfill] Found ${reportIds.length} reports`);

    const analyses = await fetchAnalyses(reportIds);
    const analysisMap = buildAnalysisMap(analyses);

    let candidates = reportIds.filter(reportId => {
        if (args.force) return true;
        return !isUsableAnalysis(analysisMap.get(reportId));
    });

    if (args.limit) {
        candidates = candidates.slice(0, args.limit);
    }

    console.log(`[Backfill] Candidate reports: ${candidates.length}`);
    if (candidates.length === 0) {
        console.log('[Backfill] Nothing to queue.');
        return;
    }

    if (args.dryRun) {
        console.log('[Backfill] Dry run report IDs:', candidates);
        return;
    }

    let queued = 0;
    for (const reportId of candidates) {
        try {
            await ensureAnalysisRow(reportId);
            await queueReport(reportId);
            queued += 1;
            if (queued % 20 === 0) {
                console.log(`[Backfill] Queued ${queued}/${candidates.length}`);
            }
        } catch (err) {
            console.error(`[Backfill] Failed to queue ${reportId}:`, err.message);
        }
    }

    console.log(`[Backfill] Done. Queued ${queued} reports.`);
}

run()
    .catch((err) => {
        console.error('[Backfill] Fatal error:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await reportAnalysisQueue.close();
        } catch (_err) {
            // no-op
        }
    });
