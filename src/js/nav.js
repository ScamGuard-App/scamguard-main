import supabase, { ensureSupabase } from './supabase.js';

// ensure navigation links reflect auth state
export async function updateNav() {
    // simple re-entrancy guard to avoid concurrent runs creating duplicates
    if (!window.__navUpdateLock) window.__navUpdateLock = false;
    if (window.__navUpdateLock) return;
    window.__navUpdateLock = true;
    try {
        // Ensure supabase is initialized
        const sb = await ensureSupabase();
        if (!sb) {
            console.warn('Supabase client not available');
            window.__navUpdateLock = false;
            return;
        }

        const { data: { session } } = await sb.auth.getSession();
    const linksDiv = document.querySelector('nav .links');
    const navEl = document.querySelector('nav');
    if (!linksDiv || !navEl) return;

    // ensure nav layout has a single user area on the right
    // Use an explicit id so we can reliably find/reuse the element and avoid duplicates
    let userArea = document.getElementById('nav-user-area');
    // remove any stray .nav-user elements that don't use the canonical id
    Array.from(navEl.querySelectorAll('.nav-user')).forEach(el => {
        if (el.id !== 'nav-user-area') el.remove();
    });
    if (!userArea) {
        userArea = document.createElement('div');
        userArea.id = 'nav-user-area';
        userArea.className = 'nav-user';
        navEl.appendChild(userArea);
    }
    // ensure layout styles are consistent when created dynamically
    userArea.style.marginLeft = 'auto';
    userArea.style.display = 'flex';
    userArea.style.alignItems = 'center';
    userArea.style.gap = '10px';

    // helper: mark active link matching pathname
    function markActive() {
        let path = window.location.pathname.split('/').pop();
        if (!path) path = 'index.html';
        linksDiv.querySelectorAll('.nav-link').forEach(el => {
            el.classList.remove('active');
            if (el.getAttribute('href') === path) {
                el.classList.add('active');
            }
        });
    }

    // remove any previously generated transient links inside linksDiv
    linksDiv.querySelectorAll('[data-generated="true"]').forEach(n => n.remove());
    // clear userArea contents (reuse the same element)
    userArea.innerHTML = '';

    // ensure account link exists
    // Keep any static account link in markup for non-authenticated users.
    let accountLink = linksDiv.querySelector('a[href="account.html"]');

    // mark active now and later
    markActive();

    if (session) {
        // logged in: show sign‑out button/link after account
        // remove any static account link from the left links to avoid duplication
        if (accountLink) accountLink.remove();
            // if admin flag present, add admin link to left
            if (profile?.is_admin) {
                let adminLink = linksDiv.querySelector('a[href="admin.html"]');
                if (!adminLink) {
                    adminLink = document.createElement('a');
                    adminLink.href = 'admin.html';
                    adminLink.className = 'nav-link';
                    adminLink.textContent = 'Admin';
                    adminLink.setAttribute('data-generated','true');
                    // insert at start of linksDiv
                    linksDiv.prepend(adminLink);
                }
            }
        // fetch profile for avatar/username and populate userArea
        try {
            const { data: profile } = await sb.from('profiles').select('username, avatar_url, is_admin').eq('id', session.user.id).maybeSingle();
            const displayName = profile?.username || session.user.user_metadata?.username || (session.user.email ? session.user.email.split('@')[0] : 'Account');
            const avatarPath = profile?.avatar_url;

            // avatar image
            const avatarImg = document.createElement('img');
            avatarImg.style.width = '36px';
            avatarImg.style.height = '36px';
            avatarImg.style.borderRadius = '50%';
            avatarImg.style.objectFit = 'cover';
            avatarImg.alt = displayName;
            avatarImg.src = 'https://via.placeholder.com/36/1f2937/ffffff?text=%20';

            if (avatarPath) {
                try {
                    const { data: signed, error } = await sb.storage.from('avatars').createSignedUrl(avatarPath, 3600);
                    if (!error && signed?.signedUrl) avatarImg.src = signed.signedUrl;
                    else {
                        const { data: pub } = sb.storage.from('avatars').getPublicUrl(avatarPath);
                        avatarImg.src = pub.publicUrl || avatarImg.src;
                    }
                } catch (e) {
                    console.warn('avatar load failed', e);
                }
            }

            const nameLink = document.createElement('a');
            nameLink.href = 'account.html';
            nameLink.className = 'nav-link nav-user-name';
            nameLink.textContent = displayName;
            nameLink.style.color = '#e5e7eb';
            nameLink.style.fontSize = '14px';
            nameLink.style.marginLeft = '8px';

            const signOutLink = document.createElement('a');
            signOutLink.href = '#';
            signOutLink.id = 'signOutLink';
            signOutLink.className = 'nav-link';
            signOutLink.textContent = 'Sign Out';
            signOutLink.style.marginLeft = '10px';
            signOutLink.addEventListener('click', async e => {
                e.preventDefault();
                await sb.auth.signOut();
                window.location.href = 'index.html';
            });

            // append elements once the avatar/load is ready
            userArea.appendChild(avatarImg);
            userArea.appendChild(nameLink);
            userArea.appendChild(signOutLink);
        } catch (e) {
            console.warn('Could not load profile for nav', e);
            const signOutLink = document.createElement('a');
            signOutLink.href = '#';
            signOutLink.id = 'signOutLink';
            signOutLink.className = 'nav-link';
            signOutLink.textContent = 'Sign Out';
            signOutLink.addEventListener('click', async ev => { ev.preventDefault(); await sb.auth.signOut(); window.location.href = 'index.html'; });
            userArea.appendChild(signOutLink);
        }
        markActive();
    } else {
        // not logged in: ensure an 'Account' link appears in the left links (create if missing)
        if (!accountLink) {
            const acct = document.createElement('a');
            acct.href = 'account.html';
            acct.className = 'nav-link';
            acct.textContent = 'Account';
            acct.setAttribute('data-generated', 'true');
            linksDiv.appendChild(acct);
        }
        // clear any userArea content
        userArea.innerHTML = '';
    }
    } finally {
        // release lock so future updates can run
        window.__navUpdateLock = false;
    }
}

// keep nav reactive when auth state changes
(async () => {
    const sb = await ensureSupabase();
    if (sb) {
        sb.auth.onAuthStateChange((event, session) => {
            updateNav();
        });
    }
})();

// run on page load
document.addEventListener('DOMContentLoaded', updateNav);
