const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// LLM Configuration
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama'; // 'ollama' or 'gemini'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY;

/**
 * Determine media type based on file extension
 */
function getMediaType(filePath) {
    const ext = filePath.toLowerCase().split('.').pop();
    const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'pdf': 'application/pdf',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Download file from Supabase storage
 */
async function downloadEvidenceFile(bucketName, filePath) {
    try {
        const { data, error } = await supabase.storage
            .from(bucketName)
            .download(filePath);

        if (error) throw error;
        return data;
    } catch (err) {
        console.error(`[LLM] Error downloading file ${filePath}:`, err);
        return null;
    }
}


/**
 * Analyze a report using local Ollama or cloud Gemini (with fallback)
 */
async function analyzeReport(reportId, reportData, evidencePaths) {
    try {
        console.log(`[LLM] Starting analysis for report ${reportId} using ${LLM_PROVIDER}`);

        let analysisData;

        // Try primary provider
        try {
            if (LLM_PROVIDER === 'ollama') {
                analysisData = await analyzeWithOllama(reportId, reportData, evidencePaths);
            } else {
                analysisData = await analyzeWithGemini(reportId, reportData, evidencePaths);
            }
            console.log(`[LLM] Analysis complete for report ${reportId}, risk_score: ${analysisData.risk_score}`);
            return analysisData;
        } catch (primaryErr) {
            console.error(`[LLM] Primary provider (${LLM_PROVIDER}) failed:`, primaryErr.message);

            // If primary fails and it's Ollama, try Gemini as fallback
            if (LLM_PROVIDER === 'ollama' && GEMINI_API_KEY) {
                console.log(`[LLM] Attempting fallback to Gemini API...`);
                try {
                    analysisData = await analyzeWithGemini(reportId, reportData, evidencePaths);
                    console.log(`[LLM] Fallback to Gemini succeeded`);
                    return analysisData;
                } catch (fallbackErr) {
                    console.error(`[LLM] Fallback to Gemini also failed:`, fallbackErr.message);
                    throw new Error(`Both ${LLM_PROVIDER} and Gemini failed: ${primaryErr.message}`);
                }
            }

            throw primaryErr;
        }
    } catch (err) {
        console.error(`[LLM] Analysis failed for report ${reportId}:`, err.message);
        throw err;
    }
}

/**
 * Analyze using local Ollama
 */
async function analyzeWithOllama(reportId, reportData, evidencePaths) {
    console.log(`[LLM] Querying Ollama at ${OLLAMA_URL}`);

    // Build prompt
    const prompt = buildAnalysisPrompt(reportData);

    try {
        // Test Ollama connection
        const healthCheck = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
        if (!healthCheck.ok) {
            throw new Error(`Ollama returned status ${healthCheck.status}`);
        }

        console.log(`[LLM] Ollama is reachable, sending request...`);

        // Query Ollama
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt: prompt,
                stream: false,
            }),
            timeout: 120000, // 2 min timeout for local LLM
        });

        if (!response.ok) {
            throw new Error(`Ollama API returned status ${response.status}`);
        }

        const result = await response.json();
        console.log(`[LLM] Ollama response received`);

        // Parse response
        let analysisData = parseAnalysisResponse(result.response);
        return analysisData;
    } catch (err) {
        console.error(`[LLM] Ollama error:`, err.message);
        if (err.message.includes('ECONNREFUSED') || err.message.includes('reachable')) {
            throw new Error(`Ollama unreachable at ${OLLAMA_URL} - is your home PC on and running Ollama?`);
        }
        throw err;
    }
}

/**
 * Analyze using cloud Gemini API (requires @google/generative-ai)
 */
async function analyzeWithGemini(reportId, reportData, evidencePaths) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    try {
        console.log(`[LLM] Querying Gemini API...`);

        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = buildAnalysisPrompt(reportData);

        // Build content array with text first
        const content = [{ text: prompt }];

        // Add evidence files (images only)
        if (evidencePaths && evidencePaths.length > 0) {
            console.log(`[LLM] Processing ${evidencePaths.length} evidence files`);
            
            for (const filePath of evidencePaths) {
                const fileBuffer = await downloadEvidenceFile('evidence', filePath);
                if (!fileBuffer) {
                    console.warn(`[LLM] Could not download ${filePath}, skipping`);
                    continue;
                }

                const mediaType = getMediaType(filePath);
                
                if (mediaType.startsWith('image/')) {
                    console.log(`[LLM] Adding image file ${filePath}`);
                    content.push({
                        inlineData: {
                            mimeType: mediaType,
                            data: Buffer.from(fileBuffer).toString('base64'),
                        },
                    });
                } else {
                    console.log(`[LLM] Skipping ${filePath} (PDF not supported)`);
                }
            }
        }

        const response = await model.generateContent(content);
        const responseText = response.response.text();
        console.log(`[LLM] Gemini response received`);

        let analysisData = parseAnalysisResponse(responseText);
        return analysisData;
    } catch (err) {
        console.error(`[LLM] Gemini error:`, err.message);
        if (err.message?.includes('quota') || err.message?.includes('429')) {
            throw new Error(`Gemini quota exceeded`);
        }
        throw err;
    }
}

/**
 * Build analysis prompt (shared between providers)
 */
function buildAnalysisPrompt(reportData) {
    return `Please analyze this scam report with the provided evidence:

**Report Title:** ${reportData.title || 'N/A'}
**Report Type:** ${reportData.type || 'N/A'}
**Description:** ${reportData.desc || 'N/A'}
${reportData.scammer_name ? `**Scammer Name:** ${reportData.scammer_name}` : ''}
${reportData.phone ? `**Phone Number:** ${reportData.phone}` : ''}

Please provide a response in JSON format with the following structure:
{
  "risk_score": <number 0-100>,
  "incident_summary": "<2-3 sentence summary>",
  "evidence_analysis": "<analysis of provided evidence>",
  "red_flags": ["<flag1>", "<flag2>"],
  "confidence": <number 0-100>,
  "recommendations": ["<recommendation1>", "<recommendation2>"]
}

Analyze the report and any evidence carefully.`;
}

/**
 * Parse analysis response (works for both Ollama and Gemini)
 */
function parseAnalysisResponse(responseText) {
    let analysisData = {
        risk_score: 50,
        incident_summary: 'Analysis completed',
        evidence_analysis: '',
        red_flags: [],
        confidence: 50,
        recommendations: [],
    };

    try {
        // Try extracting JSON from markdown code blocks
        const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
            try {
                analysisData = JSON.parse(jsonMatch[1]);
                console.log(`[LLM] Successfully parsed JSON from markdown block`);
                return analysisData;
            } catch (parseErr) {
                console.warn('[LLM] Failed to parse JSON from markdown block');
            }
        }

        // Try direct JSON parse
        try {
            analysisData = JSON.parse(responseText);
            console.log(`[LLM] Successfully parsed JSON directly`);
            return analysisData;
        } catch (parseErr) {
            console.warn('[LLM] Response was not valid JSON, using defaults');
            analysisData.incident_summary = responseText.substring(0, 500);
            return analysisData;
        }
    } catch (err) {
        console.error('[LLM] Error parsing response:', err);
        return analysisData;
    }
}

module.exports = {
    analyzeReport,
};
