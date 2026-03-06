/**
 * analysisClient.js - Frontend utility for interacting with LLM analysis endpoints
 * 
 * Usage:
 * import { AnalysisClient } from './analysisClient.js';
 * 
 * const analysis = new AnalysisClient();
 * const status = await analysis.checkStatus(reportId);
 * const unsubscribe = await analysis.pollStatus(reportId, (status) => {
 *   console.log('Analysis:', status.analysis);
 * });
 */

export class AnalysisClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.pollIntervals = new Map();
    }

    /**
     * Check current analysis status
     * @param {string} reportId - Report ID
     * @returns {Promise<object>} Status object
     */
    async checkStatus(reportId) {
        try {
            const response = await fetch(`${this.baseUrl}/analysis-status/${reportId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            console.error(`[AnalysisClient] Status check failed for ${reportId}:`, err);
            throw err;
        }
    }

    /**
     * Get all analyses for a report
     * @param {string} reportId - Report ID
     * @returns {Promise<object[]>} Array of analyses
     */
    async getAnalyses(reportId) {
        try {
            const response = await fetch(`${this.baseUrl}/analyses/${reportId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return data.analyses || [];
        } catch (err) {
            console.error(`[AnalysisClient] Get analyses failed for ${reportId}:`, err);
            throw err;
        }
    }

    /**
     * Poll for analysis status until completion
     * @param {string} reportId - Report ID
     * @param {function} callback - Called when status updates
     * @param {number} interval - Poll interval in ms (default: 2000)
     * @returns {Promise<function>} Unsubscribe function
     */
    async pollStatus(reportId, callback, interval = 2000) {
        const poll = async () => {
            try {
                const status = await this.checkStatus(reportId);
                callback(status);

                // Stop polling when complete or failed
                if (status.status === 'completed' || status.status === 'failed') {
                    this.stopPolling(reportId);
                }
            } catch (err) {
                console.error(`[AnalysisClient] Polling error:`, err);
            }
        };

        // Initial check immediately
        await poll();

        // Then poll at interval
        const intervalId = setInterval(poll, interval);
        this.pollIntervals.set(reportId, intervalId);

        // Return unsubscribe function
        return () => this.stopPolling(reportId);
    }

    /**
     * Stop polling for a report
     * @param {string} reportId - Report ID
     */
    stopPolling(reportId) {
        if (this.pollIntervals.has(reportId)) {
            clearInterval(this.pollIntervals.get(reportId));
            this.pollIntervals.delete(reportId);
        }
    }

    /**
     * Format risk score as color and label
     * @param {number} score - Risk score 0-100
     * @returns {object} { color, label, emoji }
     */
    static getRiskLevel(score) {
        if (score === null || score === undefined) return { color: 'gray', label: 'Pending', emoji: '⏳' };
        if (score >= 80) return { color: 'red', label: 'Critical', emoji: '🔴' };
        if (score >= 60) return { color: 'orange', label: 'High', emoji: '🟠' };
        if (score >= 40) return { color: 'yellow', label: 'Moderate', emoji: '🟡' };
        if (score >= 20) return { color: 'lightblue', label: 'Low', emoji: '🔵' };
        return { color: 'green', label: 'Safe', emoji: '🟢' };
    }

    /**
     * Format analysis JSON for display
     * @param {object} analysis - Analysis JSON
     * @returns {string} Formatted HTML
     */
    static formatAnalysisHTML(analysis) {
        if (!analysis) return '<p>No analysis available</p>';

        const {
            risk_score,
            incident_summary,
            evidence_analysis,
            red_flags = [],
            confidence,
            recommendations = [],
        } = analysis;

        const riskLevel = this.getRiskLevel(risk_score);

        return `
            <div class="analysis-result">
                <div class="risk-header">
                    <h3>Risk Assessment</h3>
                    <div class="risk-score" style="background-color: ${riskLevel.color};">
                        <span class="score-value">${risk_score}</span>
                        <span class="score-label">${riskLevel.label} ${riskLevel.emoji}</span>
                    </div>
                </div>

                <div class="analysis-section">
                    <h4>Incident Summary</h4>
                    <p>${this.escapeHtml(incident_summary)}</p>
                </div>

                ${evidence_analysis ? `
                    <div class="analysis-section">
                        <h4>Evidence Analysis</h4>
                        <p>${this.escapeHtml(evidence_analysis)}</p>
                    </div>
                ` : ''}

                ${red_flags.length > 0 ? `
                    <div class="analysis-section">
                        <h4>Red Flags Identified</h4>
                        <ul class="red-flags">
                            ${red_flags.map(flag => `<li>${this.escapeHtml(flag)}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}

                ${confidence ? `
                    <div class="analysis-section confidence">
                        <label>Analysis Confidence:</label>
                        <div class="confidence-bar">
                            <div class="confidence-fill" style="width: ${confidence}%"></div>
                        </div>
                        <span>${confidence}%</span>
                    </div>
                ` : ''}

                ${recommendations.length > 0 ? `
                    <div class="analysis-section">
                        <h4>Recommendations</h4>
                        <ol class="recommendations">
                            ${recommendations.map(rec => `<li>${this.escapeHtml(rec)}</li>`).join('')}
                        </ol>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Escape HTML to prevent XSS
     */
    static escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

export default AnalysisClient;
