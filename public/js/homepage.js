import { escapeHtml, getTimeAgo } from './utils.js';
import { getApiCandidates } from './api.js';

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadHomepageData();
    const searchBtn = document.getElementById('searchRedirect');
    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            window.location.href = 'reports.html';
        });
    }
});

async function loadHomepageData() {
    try {
        const reports = await fetchHomepageReports();

        if (!Array.isArray(reports)) {
            console.error('Error loading reports: invalid response payload');
            displayLoadError();
            return;
        }

        updateStatistics(reports);

        displayRecentReports(reports.slice(0, 4));

        renderTypeChart(reports);

        const searchBtn = document.getElementById('searchRedirect');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                window.location.href = 'reports.html';
            });
        }
    } catch (err) {
        console.error('Error:', err);
        displayLoadError();
    }
}

async function fetchHomepageReports() {
    const endpoints = getApiCandidates('/reports-with-analysis');
    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            });

            if ((response.status === 404 || response.status === 405) && endpoint.startsWith('/')) {
                continue;
            }

            if (!response.ok) {
                lastError = new Error(`Homepage reports request failed (${response.status})`);
                continue;
            }

            const payload = await response.json().catch(() => ({}));
            if (!Array.isArray(payload?.reports)) {
                lastError = new Error('Homepage reports payload missing reports array');
                continue;
            }

            return payload.reports;
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No homepage reports endpoint is reachable');
}

function updateStatistics(reports) {
    const totalReportsElement = document.querySelector('.card:nth-child(1) .stat');
    if (totalReportsElement) {
        totalReportsElement.textContent = reports.length.toLocaleString();
    }

    const topScamType = calculateTopScamType(reports);
    const topScamTypeElement = document.querySelector('.card:nth-child(2) .stat');
    if (topScamTypeElement) {
        topScamTypeElement.textContent = topScamType;
    }
}

// Render a Chart.js pie/bar of scam type distribution
let typeChartInstance = null;

function getBlueGreenGradient(steps) {
    const blue = [37, 99, 235];
    const green = [16, 185, 129];

    if (steps <= 1) {
        return [`rgb(${blue[0]}, ${blue[1]}, ${blue[2]})`];
    }

    return Array.from({ length: steps }, (_, i) => {
        const t = i / (steps - 1);
        const r = Math.round(blue[0] + (green[0] - blue[0]) * t);
        const g = Math.round(blue[1] + (green[1] - blue[1]) * t);
        const b = Math.round(blue[2] + (green[2] - blue[2]) * t);
        return `rgb(${r}, ${g}, ${b})`;
    });
}

function renderTypeChart(reports) {
    const ctx = document.getElementById('typeChart');
    if (!ctx) return;

    const counts = {};
    reports.forEach(r => {
        const t = r.type || 'Unknown';
        counts[t] = (counts[t] || 0) + 1;
    });

    const labels = Object.keys(counts);
    const data = labels.map(l => counts[l]);
    const backgroundColors = getBlueGreenGradient(labels.length);
    const chartBorderColor = '#0b1220';
    const chartBorderWidth = 3;

    // Reuse the existing Chart instance to avoid canvas leaks on refreshes.
    if (typeChartInstance) {
        typeChartInstance.data.labels = labels;
        typeChartInstance.data.datasets[0].data = data;
        typeChartInstance.data.datasets[0].backgroundColor = backgroundColors;
        typeChartInstance.data.datasets[0].borderColor = chartBorderColor;
        typeChartInstance.data.datasets[0].borderWidth = chartBorderWidth;
        typeChartInstance.update();
        return;
    }

    typeChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: backgroundColors,
                borderColor: chartBorderColor,
                borderWidth: chartBorderWidth,
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#e5e7eb' } }
            }
        }
    });
}

function calculateTopScamType(reports) {
    if (reports.length === 0) return 'N/A';

    const typeCounts = {};
    reports.forEach(report => {
        const type = report.type || 'Unknown';
        typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    // Find the max count
    let maxCount = 0;
    let topType = 'Unknown';

    // User first-in-list as a tie-breaker for equal counts
    const typeOrder = [];
    reports.forEach(report => {
        const type = report.type || 'Unknown';
        if (!typeOrder.includes(type)) {
            typeOrder.push(type);
        }
    });

    for (const type of typeOrder) {
        if (typeCounts[type] > maxCount) {
            maxCount = typeCounts[type];
            topType = type;
        }
    }

    return topType;
}

function displayRecentReports(recentReports) {
    const scamGrid = document.querySelector('.scam-grid');
    
    if (!scamGrid) return;

    // Clear existing cards
    scamGrid.innerHTML = '';

    if (recentReports.length === 0) {
        scamGrid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #9ca3af;">No reports yet.</p>';
        return;
    }

    recentReports.forEach(report => {
        const card = createScamCard(report);
        scamGrid.appendChild(card);
    });
}

function createScamCard(report) {
    const card = document.createElement('div');
    card.className = 'scam-card';

    const createdDate = new Date(report.created_at);
    const timeAgo = getTimeAgo(createdDate);

    const displayName = report.scammer_name || 'Anonymous Reporter';

    card.innerHTML = `
        <div class="scam-header">
            <h3>${escapeHtml(displayName)}</h3>
            <span class="report-date">${timeAgo}</span>
        </div>
        <div class="scam-details">
            <div class="detail-row">
                <span class="label">Website:</span>
                <span class="value">${escapeHtml(report.website || report.contact_info || report.phone || report.email || 'N/A')}</span>
            </div>
            <div class="detail-row">
                <span class="label">Scam Type:</span>
                <span class="value">${escapeHtml(report.type || 'Unknown')}</span>
            </div>
        </div>
    `;

    // Redirect to the report details on search page when clicking card
    if (report.report_id) {
        const targetUrl = `reports.html?reportId=${encodeURIComponent(String(report.report_id))}`;
        card.classList.add('recent-report-link');
        card.setAttribute('role', 'link');
        card.tabIndex = 0;
        card.addEventListener('click', () => {
            window.location.href = targetUrl;
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                window.location.href = targetUrl;
            }
        });
    }

    return card;
}

// Fallback error display if broken
function displayLoadError() {
    const totalReportsElement = document.querySelector('.card:nth-child(1) .stat');
    const topScamTypeElement = document.querySelector('.card:nth-child(2) .stat');
    const scamGrid = document.querySelector('.scam-grid');

    if (totalReportsElement) totalReportsElement.textContent = 'Error';
    if (topScamTypeElement) topScamTypeElement.textContent = 'Error';
    if (scamGrid) scamGrid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #e74c3c;">Failed to load reports.</p>';
}
