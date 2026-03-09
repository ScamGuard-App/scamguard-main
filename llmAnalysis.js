const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// LLM Configuration
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama'; // 'ollama' or 'gemini'
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
const PDF_TEXT_MAX_CHARS = Number(process.env.PDF_TEXT_MAX_CHARS || 6000);
const PDF_MAX_FILES = Number(process.env.PDF_MAX_FILES || 3);
const IMAGE_MAX_FILES = Number(process.env.IMAGE_MAX_FILES || 6);
const RISK_SCORE_BIAS = Number(process.env.RISK_SCORE_BIAS ?? -10);
const RISK_SOFT_CAP_NO_EVIDENCE = Number(process.env.RISK_SOFT_CAP_NO_EVIDENCE ?? 78);
const RISK_SOFT_CAP_WEAK_SIGNALS = Number(process.env.RISK_SOFT_CAP_WEAK_SIGNALS ?? 65);

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
        'webp': 'image/webp',
        'pdf': 'application/pdf',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function countStrongSignals(text) {
    const normalized = String(text || '').toLowerCase();
    const patterns = [
        /gift\s*card/, /crypto|bitcoin|usdt|wallet/, /wire\s*transfer|bank\s*transfer/,
        /otp|one[-\s]*time\s*password|verification\s*code/, /remote\s*access|anydesk|teamviewer/,
        /impersonat|pretend(s|ing)?\s+to\s+be/, /urgent|act\s+now|immediately/,
        /romance\s+scam|investment\s+scam|tech\s*support/, /refund\s+scam|account\s+locked/
    ];
    return patterns.reduce((count, rx) => count + (rx.test(normalized) ? 1 : 0), 0);
}

function buildEvidenceContext(evidencePaths) {
    if (!Array.isArray(evidencePaths) || evidencePaths.length === 0) {
        return {
            total: 0,
            imageCount: 0,
            pdfCount: 0,
            otherCount: 0,
            fileNames: [],
        };
    }

    let imageCount = 0;
    let pdfCount = 0;
    let otherCount = 0;
    const fileNames = [];

    for (const path of evidencePaths) {
        const mediaType = getMediaType(path);
        const fileName = String(path || '').split('/').pop();
        if (fileName) fileNames.push(fileName);

        if (mediaType.startsWith('image/')) imageCount += 1;
        else if (mediaType === 'application/pdf') pdfCount += 1;
        else otherCount += 1;
    }

    return {
        total: evidencePaths.length,
        imageCount,
        pdfCount,
        otherCount,
        fileNames,
    };
}

function calibrateRiskScore(analysisData, reportData, evidenceContext) {
    const calibrated = { ...analysisData };
    const rawScore = toFiniteNumber(analysisData?.risk_score, 50);
    let score = rawScore + RISK_SCORE_BIAS;

    const redFlags = Array.isArray(analysisData?.red_flags) ? analysisData.red_flags : [];
    const textCorpus = [
        reportData?.title,
        reportData?.desc,
        analysisData?.incident_summary,
        analysisData?.evidence_analysis,
        redFlags.join(' '),
    ].join(' ');

    const strongSignals = countStrongSignals(textCorpus);
    const hasEvidence = evidenceContext.total > 0;
    const confidence = toFiniteNumber(analysisData?.confidence, 50);

    if (!hasEvidence) {
        score = Math.min(score, RISK_SOFT_CAP_NO_EVIDENCE);
    }

    if (strongSignals <= 1 && redFlags.length <= 2) {
        score = Math.min(score, RISK_SOFT_CAP_WEAK_SIGNALS);
    }

    if (confidence < 45 && score > 75) {
        score = 75;
    }

    if (strongSignals >= 3 && score < 60) {
        score = 60;
    }

    const hasReportText = Boolean(`${reportData?.title || ''}${reportData?.desc || ''}`.trim());
    if (hasReportText && score <= 0) {
        score = strongSignals >= 1 ? 25 : 15;
    }

    calibrated.risk_score = clamp(Math.round(score), 0, 100);
    calibrated.calibration = {
        raw_score: clamp(Math.round(rawScore), 0, 100),
        final_score: calibrated.risk_score,
        strong_signals: strongSignals,
        evidence_count: evidenceContext.total,
        applied_bias: RISK_SCORE_BIAS,
    };

    return calibrated;
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

async function blobToBuffer(fileData) {
    if (!fileData) return null;
    if (Buffer.isBuffer(fileData)) return fileData;
    if (typeof fileData.arrayBuffer === 'function') {
        const arr = await fileData.arrayBuffer();
        return Buffer.from(arr);
    }
    if (fileData instanceof ArrayBuffer) return Buffer.from(fileData);
    return null;
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function prepareOllamaEvidence(evidencePaths) {
    const imageBase64List = [];
    const imageFileNames = [];
    const pdfExtracts = [];

    if (!Array.isArray(evidencePaths) || evidencePaths.length === 0) {
        return { imageBase64List, imageFileNames, pdfExtracts };
    }

    let imageCount = 0;
    let pdfCount = 0;

    for (const filePath of evidencePaths) {
        const mediaType = getMediaType(filePath);
        const fileName = String(filePath || '').split('/').pop() || filePath;

        if (mediaType.startsWith('image/')) {
            if (imageCount >= IMAGE_MAX_FILES) continue;
            const fileData = await downloadEvidenceFile('evidence', filePath);
            const buffer = await blobToBuffer(fileData);
            if (!buffer) {
                console.warn(`[LLM] Could not read image evidence ${filePath}`);
                continue;
            }

            imageBase64List.push(buffer.toString('base64'));
            imageFileNames.push(fileName);
            imageCount += 1;
            continue;
        }

        if (mediaType === 'application/pdf') {
            if (pdfCount >= PDF_MAX_FILES) continue;
            const fileData = await downloadEvidenceFile('evidence', filePath);
            const buffer = await blobToBuffer(fileData);
            if (!buffer) {
                console.warn(`[LLM] Could not read PDF evidence ${filePath}`);
                continue;
            }

            try {
                const parsed = await pdfParse(buffer);
                const extractedText = normalizeWhitespace(parsed?.text || '');
                if (!extractedText) {
                    pdfExtracts.push({ fileName, text: '[No extractable text found. File may be scanned/image-only.]' });
                } else {
                    pdfExtracts.push({ fileName, text: extractedText.slice(0, PDF_TEXT_MAX_CHARS) });
                }
                pdfCount += 1;
            } catch (err) {
                console.warn(`[LLM] Failed to parse PDF ${filePath}: ${err.message}`);
                pdfExtracts.push({ fileName, text: `[PDF extraction failed: ${err.message}]` });
            }
        }
    }

    return { imageBase64List, imageFileNames, pdfExtracts };
}


/**
 * Analyze a report using local Ollama or cloud Gemini (with fallback)
 */
async function analyzeReport(reportId, reportData, evidencePaths) {
    try {
        console.log(`[LLM] Starting analysis for report ${reportId} using ${LLM_PROVIDER}`);

        let analysisData;
        const evidenceContext = buildEvidenceContext(evidencePaths);

        // Try primary provider
        try {
            if (LLM_PROVIDER === 'ollama') {
                analysisData = await analyzeWithOllama(reportId, reportData, evidencePaths);
            } else {
                analysisData = await analyzeWithGemini(reportId, reportData, evidencePaths);
            }
            analysisData = calibrateRiskScore(analysisData, reportData, evidenceContext);
            console.log(`[LLM] Analysis complete for report ${reportId}, risk_score: ${analysisData.risk_score}`);
            return analysisData;
        } catch (primaryErr) {
            console.error(`[LLM] Primary provider (${LLM_PROVIDER}) failed:`, primaryErr.message);

            // If primary fails and it's Ollama, try Gemini as fallback
            if (LLM_PROVIDER === 'ollama' && GEMINI_API_KEY) {
                console.log(`[LLM] Attempting fallback to Gemini API...`);
                try {
                    analysisData = await analyzeWithGemini(reportId, reportData, evidencePaths);
                    analysisData = calibrateRiskScore(analysisData, reportData, evidenceContext);
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

    const evidenceContext = buildEvidenceContext(evidencePaths);
    const preparedEvidence = await prepareOllamaEvidence(evidencePaths);
    const prompt = buildAnalysisPrompt(reportData, evidenceContext, {
        evidenceInspectionMode: 'hybrid_local_pdf_text',
        imageFileNames: preparedEvidence.imageFileNames,
        pdfExtracts: preparedEvidence.pdfExtracts,
    });

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
                images: preparedEvidence.imageBase64List,
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
        const evidenceContext = buildEvidenceContext(evidencePaths);
        const prompt = buildAnalysisPrompt(reportData, evidenceContext, {
            evidenceInspectionMode: 'full',
        });

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
                
                if (mediaType.startsWith('image/') || mediaType === 'application/pdf') {
                    console.log(`[LLM] Adding evidence file ${filePath} (${mediaType})`);
                    content.push({
                        inlineData: {
                            mimeType: mediaType,
                            data: Buffer.from(fileBuffer).toString('base64'),
                        },
                    });
                } else {
                    console.log(`[LLM] Skipping ${filePath} (unsupported media type: ${mediaType})`);
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
function buildAnalysisPrompt(reportData, evidenceContext, options = {}) {
    const mode = options.evidenceInspectionMode || 'full';
    const imageFileNames = Array.isArray(options.imageFileNames) ? options.imageFileNames : [];
    const pdfExtracts = Array.isArray(options.pdfExtracts) ? options.pdfExtracts : [];
    const evidenceHeader = evidenceContext.total > 0
        ? `Evidence files: ${evidenceContext.total} total (${evidenceContext.imageCount} images, ${evidenceContext.pdfCount} pdfs, ${evidenceContext.otherCount} other).`
        : 'Evidence files: none provided.';
    const evidenceNames = evidenceContext.fileNames.length > 0
        ? `Evidence filenames: ${evidenceContext.fileNames.join(', ')}`
        : '';
    const imageEvidenceLine = imageFileNames.length > 0
        ? `Image evidence passed directly to model: ${imageFileNames.join(', ')}`
        : 'Image evidence passed directly to model: none';
    const pdfEvidenceBlock = pdfExtracts.length > 0
        ? `\n\nExtracted PDF text snippets:\n${pdfExtracts
            .map((pdf, index) => `PDF ${index + 1} (${pdf.fileName}):\n${pdf.text}`)
            .join('\n\n')}`
        : '';
    const evidenceInstruction = mode === 'metadata_only'
        ? 'You cannot directly inspect attachment binaries in this run. Do not overstate certainty from evidence; explicitly lower confidence when evidence cannot be inspected.'
        : mode === 'hybrid_local_pdf_text'
            ? 'You can inspect image evidence directly. PDF files are provided as extracted text snippets (not full visual layout). Base your evidence analysis on both sources and mention uncertainty if extraction quality appears weak.'
        : 'You can inspect provided image/PDF evidence. Reference specific evidence observations and avoid generic statements.';

    return `Please analyze this scam report with the provided evidence:

**Report Title:** ${reportData.title || 'N/A'}
**Report Type:** ${reportData.type || 'N/A'}
**Description:** ${reportData.desc || 'N/A'}
${reportData.scammer_name ? `**Scammer Name:** ${reportData.scammer_name}` : ''}
${reportData.phone ? `**Phone Number:** ${reportData.phone}` : ''}
${evidenceHeader}
${evidenceNames}
${imageEvidenceLine}
${pdfEvidenceBlock}

Scoring rubric (important):
- Start from 40 as a neutral baseline.
- Weak signals alone (weird username, odd phone formatting, short/vague text) should usually stay under 60.
- Use 60-79 only when there are multiple concrete scam indicators.
- Use 80-100 only when evidence strongly supports fraud (clear impersonation, payment coercion, OTP theft, remote-access abuse, repeated strong red flags).
- If evidence is missing/unclear, lower confidence and avoid extreme scores.

Evidence handling requirement:
${evidenceInstruction}

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
                analysisData.risk_score = clamp(Math.round(toFiniteNumber(analysisData.risk_score, 50)), 0, 100);
                analysisData.confidence = clamp(Math.round(toFiniteNumber(analysisData.confidence, 50)), 0, 100);
                console.log(`[LLM] Successfully parsed JSON from markdown block`);
                return analysisData;
            } catch (parseErr) {
                console.warn('[LLM] Failed to parse JSON from markdown block');
            }
        }

        // Try direct JSON parse
        try {
            analysisData = JSON.parse(responseText);
            analysisData.risk_score = clamp(Math.round(toFiniteNumber(analysisData.risk_score, 50)), 0, 100);
            analysisData.confidence = clamp(Math.round(toFiniteNumber(analysisData.confidence, 50)), 0, 100);
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
