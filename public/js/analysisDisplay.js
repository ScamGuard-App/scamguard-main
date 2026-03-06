/**
 * Example HTML component for displaying LLM analysis results
 * 
 * Add this to your HTML file where you want to show analysis:
 * <div id="analysisContainer"></div>
 * 
 * Then use in JavaScript:
 * import { AnalysisClient } from './analysisClient.js';
 * 
 * const client = new AnalysisClient();
 * displayAnalysis(reportId, 'analysisContainer');
 */

import { AnalysisClient } from './analysisClient.js';

/**
 * Display analysis results in a container
 * @param {string} reportId - Report ID
 * @param {string} containerId - HTML element ID to display in
 */
async function displayAnalysis(reportId, containerId = 'analysisContainer') {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Container #${containerId} not found`);
        return;
    }

    const client = new AnalysisClient();

    // Show loading state
    container.innerHTML = `
        <div class="analysis-loading">
            <div class="spinner"></div>
            <p>Analyzing report...</p>
        </div>
    `;

    try {
        // Start polling for analysis status
        await client.pollStatus(reportId, (status) => {
            if (status.status === 'pending' || status.status === 'not_started') {
                container.innerHTML = `
                    <div class="analysis-loading">
                        <div class="spinner"></div>
                        <p>Analysis in progress...</p>
                        <small>${status.status === 'not_started' ? 'Queuing analysis...' : 'Processing...'}</small>
                    </div>
                `;
            } else if (status.status === 'completed') {
                const analysisHtml = AnalysisClient.formatAnalysisHTML(status.analysis?.analysis_json);
                container.innerHTML = analysisHtml;
            } else if (status.status === 'failed') {
                container.innerHTML = `
                    <div class="analysis-error">
                        <h4>Analysis Failed</h4>
                        <p>Unfortunately, the analysis could not be completed. Please try again later.</p>
                    </div>
                `;
            }
        });
    } catch (err) {
        container.innerHTML = `
            <div class="analysis-error">
                <h4>Error Loading Analysis</h4>
                <p>${client.constructor.escapeHtml(err.message)}</p>
            </div>
        `;
    }
}

/**
 * Get a summary badge for quick display
 * @param {string} reportId - Report ID
 * @returns {Promise<string>} HTML string for badge
 */
async function getRiskBadge(reportId) {
    const client = new AnalysisClient();
    
    try {
        const status = await client.checkStatus(reportId);
        
        if (status.status === 'completed') {
            const score = status.analysis?.risk_score;
            const riskLevel = AnalysisClient.getRiskLevel(score);
            
            return `
                <span class="risk-badge" style="background-color: ${riskLevel.color};">
                    ${riskLevel.emoji} ${score} - ${riskLevel.label}
                </span>
            `;
        } else if (status.status === 'pending') {
            return `<span class="risk-badge-pending">⏳ Analysis pending...</span>`;
        } else if (status.status === 'failed') {
            return `<span class="risk-badge-error">❌ Analysis failed</span>`;
        }
        
        return `<span class="risk-badge-pending">⏳ Queuing...</span>`;
    } catch (err) {
        console.error('Error getting badge:', err);
        return `<span class="risk-badge-error">❌ Error</span>`;
    }
}

/**
 * Simple status indicator
 * @param {string} reportId - Report ID
 */
async function updateStatusIndicator(reportId, elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const badge = await getRiskBadge(reportId);
    element.innerHTML = badge;
}

export { displayAnalysis, getRiskBadge, updateStatusIndicator };
