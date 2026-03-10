// Common utilities shared across modules

export function escapeHtml(text) {
    // Uses the browser's own text escaping rules (safer than manual replace chains).
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function getTimeAgo(date) {
    // Keep this intentionally simple/readable since it is used in many UI cards.
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    // Bit messy but works lol
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + ' years ago';

    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + ' months ago';

    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + ' days ago';

    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + ' hours ago';

    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + ' minutes ago';

    return Math.floor(seconds) + ' seconds ago';
}
