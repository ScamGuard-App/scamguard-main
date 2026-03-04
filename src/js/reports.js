import supabase from './supabase.js';

let allReports = [];
let usernameCache = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadReports();
    setupEventListeners();
});

function setupEventListeners() {
    document.getElementById('searchBtn').addEventListener('click', performSearch);
    document.getElementById('refreshBtn').addEventListener('click', resetAndReload);
    document.getElementById('searchInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performSearch();
    });
    document.getElementById('typeFilter').addEventListener('change', performSearch);
}

async function loadReports() {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error loading reports:', error);
            showNoResults('Failed to load reports');
            return;
        }

        allReports = data || [];
        
        // Pre-fetch usernames
        const userIds = [...new Set(allReports.map(r => r.user_id))];
        await fetchUsernames(userIds);
        
        performSearch();
    } catch (err) {
        console.error('Error:', err);
        showNoResults('An error occurred while loading reports');
    }
}

async function fetchUsernames(userIds) {
    try {
        const { data, error } = await supabase.auth.admin.listUsers();
        
        if (error) {
            console.warn('Could not fetch usernames (non-admin context):', error);
            // Fallback: use user_id as display name
            userIds.forEach(id => {
                usernameCache[id] = id.substring(0, 8) + '...';
            });
            return;
        }

        data?.users?.forEach(user => {
            usernameCache[user.id] = user.user_metadata?.username || user.email?.split('@')[0] || 'Anonymous';
        });
    } catch (err) {
        console.warn('Could not fetch usernames:', err);
        userIds.forEach(id => {
            usernameCache[id] = 'Anonymous';
        });
    }
}

function fuzzyScore(searchTerm, text) {
    // Simple fuzzy matching: score based on substring match position and length ratio
    if (!text || !searchTerm) return 0;
    
    const searchLower = searchTerm.toLowerCase();
    const textLower = text.toLowerCase();
    
    // Exact match
    if (textLower === searchLower) return 1000;
    
    // Contains match
    if (textLower.includes(searchLower)) {
        return 500 + (textLower.length - searchLower.length);
    }
    
    // Levenshtein-like scoring: check character-by-character similarity
    let score = 0;
    let textIdx = 0;
    for (let i = 0; i < searchLower.length && textIdx < textLower.length; i++) {
        while (textIdx < textLower.length && searchLower[i] !== textLower[textIdx]) {
            textIdx++;
        }
        if (textIdx < textLower.length) {
            score += 1;
            textIdx++;
        }
    }
    
    if (score === 0) return 0;
    
    // Normalize by search term length
    return (score / searchLower.length) * 100;
}

function performSearch() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    const selectedType = document.getElementById('typeFilter').value;

    let filtered = allReports;

    // Filter by type
    if (selectedType) {
        filtered = filtered.filter(report => report.type === selectedType);
    }

    // Filter by search term (fuzzy match across multiple fields)
    if (searchTerm) {
        filtered = filtered.map(report => {
            const titleScore = fuzzyScore(searchTerm, report.title || '');
            const scammerScore = fuzzyScore(searchTerm, report.scammer_name || '');
            const descScore = fuzzyScore(searchTerm, report.desc || '');
            const phoneScore = fuzzyScore(searchTerm, report.phone?.toString() || '');
            
            const maxScore = Math.max(titleScore, scammerScore, descScore, phoneScore);
            return { report, score: maxScore };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(item => item.report);
    } else if (selectedType) {
        // Keep original order when only filtering by type
        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    renderResults(filtered);
}

function renderResults(results) {
    const tableBody = document.getElementById('tableBody');

    if (results.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: #9ca3af;">No reports found. Try adjusting your search.</td></tr>';
        return;
    }

    tableBody.innerHTML = results.map(report => {
        const date = new Date(report.created_at).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
        const username = usernameCache[report.user_id] || 'Anonymous';
        const hasEvidence = report.evidence_url && (typeof report.evidence_url === 'string' || Object.keys(report.evidence_url || {}).length > 0);

        return `
            <tr style="cursor: pointer;" onclick="openReportModal('${escapeAttr(report.report_id)}')">
                <td style="max-width: 200px; word-break: break-word;">${escapeHtml(report.title || 'N/A')}</td>
                <td><span style="background: rgba(196, 28, 59, 0.3); padding: 4px 8px; border-radius: 4px; display: inline-block; font-size: 12px;">${escapeHtml(report.type || 'Other')}</span></td>
                <td>${escapeHtml(report.scammer_name || 'N/A')}</td>
                <td>${escapeHtml(username)}</td>
                <td>${date}</td>
                <td style="pointer-events: auto;" onclick="event.stopPropagation();">
                    ${hasEvidence ? `<button class="evidence-btn" onclick="event.stopPropagation(); openReportModal('${escapeAttr(report.report_id)}')"><i class="fas fa-file-alt"></i> View</button>` : '<span style="color: #6b7280;">None</span>'}
                </td>
            </tr>
        `;
    }).join('');
}

window.openReportModal = function(reportId) {
    const report = allReports.find(r => r.report_id === reportId);
    if (!report) return;

    // Map scam type to display name
    const typeMap = {
        'phishing': 'Phishing Scam',
        'tech-support': 'Tech Support Fraud',
        'romance': 'Romance Scam',
        'lottery': 'Lottery & Prize Scam',
        'identity-theft': 'Identity Theft',
        'cryptocurrency': 'Cryptocurrency Scam',
        'job-offer': 'Job Offer Scam',
        'fake-website': 'Fake Website',
        'social-media': 'Social Media Scam',
        'auction': 'Auction Fraud',
        'other': 'Other'
    };

    const date = new Date(report.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    const username = usernameCache[report.user_id] || 'Anonymous';

    // Populate modal fields
    document.getElementById('modalType').textContent = typeMap[report.type] || report.type;
    document.getElementById('modalTitle').textContent = escapeHtml(report.title || 'Untitled');
    document.getElementById('modalScammerName').textContent = escapeHtml(report.scammer_name || 'Not specified');
    document.getElementById('modalDescription').textContent = escapeHtml(report.desc || 'No description provided');
    document.getElementById('modalReporter').textContent = username;
    document.getElementById('modalDate').textContent = date;
    
    const phoneEl = document.getElementById('modalPhone');
    if (report.phone) {
        phoneEl.textContent = `Phone: ${escapeHtml(report.phone?.toString() || 'N/A')}`;
    } else {
        phoneEl.textContent = 'Phone: Not provided';
    }

    // Handle evidence
    const evidenceSection = document.getElementById('evidenceSection');
    const evidenceList = document.getElementById('evidenceList');
    
    let evidencePaths = [];
    try {
        if (report.evidence_url) {
            if (typeof report.evidence_url === 'string' && report.evidence_url.startsWith('[')) {
                evidencePaths = JSON.parse(report.evidence_url);
            } else if (typeof report.evidence_url === 'string') {
                evidencePaths = [report.evidence_url];
            }
        }
    } catch (e) {
        console.error('Error parsing evidence paths:', e);
    }

    if (evidencePaths.length > 0) {
        evidenceSection.style.display = 'block';
        evidenceList.innerHTML = evidencePaths.map((path, idx) => {
            const filename = path.split('/').pop();
            return `
                <div class="evidence-item">
                    <div class="evidence-item-name"><i class="fas fa-file"></i> ${escapeHtml(filename)}</div>
                    <div class="evidence-item-actions">
                        <button class="evidence-btn-small" onclick="downloadEvidence('${escapeAttr(path)}', '${escapeAttr(filename)}')">Download</button>
                        <button class="evidence-btn-small" onclick="openEvidence('${escapeAttr(path)}')">View</button>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        evidenceSection.style.display = 'none';
    }

    // Show modal
    document.getElementById('reportModal').classList.add('active');
};

window.closeReportModal = function() {
    document.getElementById('reportModal').classList.remove('active');
};

window.downloadEvidence = async function(path, filename) {
    try {
        // Create signed URL for download (1 hour expiration)
        const { data, error } = await supabase.storage
            .from('evidence')
            .createSignedUrl(path, 3600);

        if (error) {
            console.error('Error creating signed URL:', error);
            alert('Could not download file');
            return;
        }

        // Trigger download
        const link = document.createElement('a');
        link.href = data.signedUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        console.error('Error downloading evidence:', err);
        alert('Could not download file');
    }
};

window.openEvidence = async function(path) {
    try {
        // Create signed URL for viewing (1 hour expiration)
        const { data, error } = await supabase.storage
            .from('evidence')
            .createSignedUrl(path, 3600);

        if (error) {
            console.error('Error creating signed URL:', error);
            alert('Could not open file');
            return;
        }

        // Open in new tab
        window.open(data.signedUrl, '_blank');
    } catch (err) {
        console.error('Error opening evidence:', err);
        alert('Could not open file');
    }
};

// Close modal when clicking outside content
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('reportModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeReportModal();
            }
        });
    }
});

function showNoResults(message) {
    const tableBody = document.getElementById('tableBody');
    tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: #9ca3af;">${escapeHtml(message)}</td></tr>`;
}

function resetAndReload() {
    document.getElementById('searchInput').value = '';
    document.getElementById('typeFilter').value = '';
    performSearch();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return String(text).replace(/"/g, '&quot;');
}
