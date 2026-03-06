require('dotenv').config();
const Queue = require('bull');
const { createClient } = require('@supabase/supabase-js');
const { analyzeReport } = require('./llmAnalysis.js');

// Initialize Redis queue
const reportAnalysisQueue = new Queue('report-analysis', {
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
    },
});

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Process report analysis job (concurrency: 1 to respect Gemini rate limits)
 * Free tier: 5 requests/minute, so process sequentially
 */
reportAnalysisQueue.process(1, async (job) => {
    const { reportId } = job.data;

    try {
        console.log(`[Worker] Processing analysis for report ${reportId}`);

        // Fetch report data from Supabase
        const { data: reportData, error: reportError } = await supabase
            .from('reports')
            .select('*')
            .eq('report_id', reportId)
            .single();

        if (reportError || !reportData) {
            console.error(`[Worker] Report query error:`, reportError);
            throw new Error(`Report not found: ${reportError?.message || 'No data'}`);
        }

        console.log(`[Worker] Found report, analyzing...`);

        // Parse evidence paths
        let evidencePaths = [];
        if (reportData.evidence_url) {
            try {
                evidencePaths = JSON.parse(reportData.evidence_url);
            } catch (e) {
                console.warn('[Worker] Failed to parse evidence_url:', e);
                evidencePaths = [];
            }
        }

        // Analyze report using Claude
        const analysisResult = await analyzeReport(reportId, reportData, evidencePaths);
        console.log(`[Worker] Analysis result:`, analysisResult);

        // Store analysis in ai_analysis table
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
            console.error(`[Worker] Update error:`, updateError);
            throw new Error(`Failed to update ai_analysis: ${updateError.message}`);
        }

        console.log(`[Worker] Analysis completed for report ${reportId}`);
        return { success: true, reportId, riskScore: analysisResult.risk_score };
    } catch (err) {
        console.error(`[Worker] Error processing report ${job.data.reportId}:`, err);

        // Update ai_analysis with error status
        try {
            const { error: errorUpdateError } = await supabase
                .from('ai_analysis')
                .update({
                    analysis_json: {
                        error: err.message,
                        status: 'failed',
                    },
                })
                .eq('report_id', reportId);
        } catch (updateErr) {
            console.error('[Worker] Failed to update error status:', updateErr);
        }

        throw err;
    }
});

// Queue event handlers
reportAnalysisQueue.on('completed', (job, result) => {
    console.log(`[Queue] Job ${job.id} completed:`, result);
});

reportAnalysisQueue.on('failed', (job, err) => {
    console.error(`[Queue] Job ${job.id} failed:`, err.message);
});

reportAnalysisQueue.on('error', (err) => {
    console.error('[Queue] Error:', err);
});

console.log('[Worker] Report analysis worker started. Waiting for jobs...');

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('[Worker] Shutting down gracefully...');
    await reportAnalysisQueue.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Worker] Shutting down gracefully...');
    await reportAnalysisQueue.close();
    process.exit(0);
});
