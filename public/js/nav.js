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
        let userArea = document.getElementById('nav-user-area');
        Array.from(navEl.querySelectorAll('.nav-user')).forEach(el => {
            if (el.id !== 'nav-user-area') el.remove();
        });
        if (!userArea) {
            userArea = document.createElement('div');
            userArea.id = 'nav-user-area';
            userArea.className = 'nav-user';
            navEl.appendChild(userArea);
        }
        userArea.style.marginLeft = 'auto';
        userArea.style.display = 'flex';
        userArea.style.alignItems = 'center';
        userArea.style.gap = '10px';

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

        linksDiv.querySelectorAll('[data-generated="true"]').forEach(n => n.remove());
        userArea.innerHTML = '';

        let accountLink = linksDiv.querySelector('a[href="account.html"]');
        markActive();

        // fetch profile early so we can use it when building links/user area
        let profile = null;
        if (session) {
            try {
                const { data, error } = await sb.from('profiles')
                    .select('username, avatar_url, is_admin')
                    .eq('id', session.user.id)
                    .maybeSingle();
                if (error) throw error;
                profile = data;
            } catch (e) {
                console.warn('Could not fetch profile for nav', e);
            }
        }

        if (session) {
            if (accountLink) accountLink.remove();
            if (profile?.is_admin) {
                let adminLink = linksDiv.querySelector('a[href="admin.html"]');
                if (!adminLink) {
                    adminLink = document.createElement('a');
                    adminLink.href = 'admin.html';
                    adminLink.className = 'nav-link';
                    adminLink.textContent = 'Admin';
                    adminLink.setAttribute('data-generated','true');
                    linksDiv.prepend(adminLink);
                }
            }

            // populate user area using already-fetched profile
            const displayName = profile?.username || session.user.user_metadata?.username ||
                (session.user.email ? session.user.email.split('@')[0] : 'Account');
            const avatarPath = profile?.avatar_url;

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

            userArea.appendChild(avatarImg);
            userArea.appendChild(nameLink);
            userArea.appendChild(signOutLink);
            markActive();
        } else {
            if (!accountLink) {
                const acct = document.createElement('a');
                acct.href = 'account.html';
                acct.className = 'nav-link';
                acct.textContent = 'Account';
                acct.setAttribute('data-generated', 'true');
                linksDiv.appendChild(acct);
            }
            userArea.innerHTML = '';
        }
    } finally {
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
