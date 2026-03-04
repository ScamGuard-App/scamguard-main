import supabase, { ensureSupabase } from './supabase.js';
import { escapeHtml, getTimeAgo } from './utils.js';

// element references
const showSignUp = document.getElementById('showSignUp');
const showLogin = document.getElementById('showLogin');
const signUpForm = document.getElementById('signUpForm');
const loginForm = document.getElementById('loginForm');

// messages/errors
const signUpMsg = document.getElementById('signUpMsg');
const signUpError = document.getElementById('signUpError');
const loginMsg = document.getElementById('loginMsg');
const loginError = document.getElementById('loginError');

function clearAuthMessages() {
    signUpMsg.textContent = '';
    signUpError.textContent = '';
    loginMsg.textContent = '';
    loginError.textContent = '';
}

function switchTo(signup) {
    clearAuthMessages();
    if (signup) {
        signUpForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        showSignUp.classList.add('active');
        showLogin.classList.remove('active');
    } else {
        signUpForm.classList.add('hidden');
        loginForm.classList.remove('hidden');
        showSignUp.classList.remove('active');
        showLogin.classList.add('active');
    }
}

showSignUp.addEventListener('click', () => switchTo(true));
showLogin.addEventListener('click', () => switchTo(false));

// signup handler – write metadata and handle confirmation notice
signUpForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearAuthMessages();

    const username = document.getElementById('signupUsername').value;
    const email    = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;

    try {
        const sb = await ensureSupabase();
        if (!sb) {
            signUpError.textContent = 'Unable to connect to auth service';
            return;
        }

        const { data, error } = await sb.auth.signUp({
            email,
            password,
            options: { data: { username } }        // stored in user_metadata
        });
        if (error) throw error;

        // the new user is created but may be unconfirmed
        signUpMsg.textContent =
            'Registration successful! Check your inbox to confirm before logging in.';
        // optionally: await sb.auth.updateUser({ data:{ username } });
        
        // Create a profile row in `profiles` table if the user object is available
        try {
            const newUser = data?.user;
            if (newUser && newUser.id) {
                const profilePayload = {
                    id: newUser.id,
                    username: username || newUser.user_metadata?.username || null,
                    email: email || null,
                    avatar_url: null
                };
                await sb.from('profiles').upsert(profilePayload, { returning: 'minimal' });
            }
        } catch (profErr) {
            console.warn('Could not create profile row after signup', profErr);
        }
    } catch (err) {
        console.error('signup error', err);
        signUpError.textContent = err.message || 'Unable to register.';
    }
});

// login handler – give a more helpful message for un‑confirmed accounts
loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearAuthMessages();

    const sb = await ensureSupabase();
    if (!sb) {
        loginError.textContent = 'Unable to connect to auth service';
        return;
    }

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
            // 400 is the “invalid login credentials / unconfirmed email” case
            if (error.status === 400 && error.message.includes('invalid login')) {
                loginError.textContent = 'Invalid credentials – have you confirmed your email?';
            } else {
                throw error;
            }
            return;
        }
        loginMsg.textContent = 'Logged in successfully!';
        // stay on account page if already there, otherwise send user home
        if (!window.location.pathname.endsWith('account.html')) {
            window.location.href = 'index.html';
        } else {
            // reload profile info
            loadProfile();
        }
    } catch (err) {
        console.error('login error', err);
        loginError.textContent = err.message || 'Login failed.';
    }
});

// profile management elements
const profileSection = document.getElementById('profileSection');
const profileUsername = document.getElementById('profileUsername');
const profileEmail = document.getElementById('profileEmail');
const profilePassword = document.getElementById('profilePassword');
const profileAvatarInput = document.getElementById('profileAvatar');
const avatarPreview = document.getElementById('avatarPreview');
const avatarPlaceholder = document.getElementById('avatarPlaceholder');
const removeAvatarBtn = document.getElementById('removeAvatarBtn');
const profileMsg = document.getElementById('profileMsg');
const profileError = document.getElementById('profileError');
const updateProfileBtn = document.getElementById('updateProfileBtn');
const deleteAccountBtn = document.getElementById('deleteAccountBtn');

function clearProfileMessages() {
    profileMsg.textContent = '';
    profileError.textContent = '';
}

async function loadProfile() {
    const sb = await ensureSupabase();
    if (!sb) return;

    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) {
        document.querySelector('.auth-toggle')?.classList.add('hidden');
        showSignUp.classList.add('hidden');
        showLogin.classList.add('hidden');
        signUpForm.classList.add('hidden');
        loginForm.classList.add('hidden');

        // show profile section and potentially admin portal button
        profileSection.classList.remove('hidden');
        profileEmail.value = session.user.email || '';
        profileUsername.value = session.user.user_metadata?.username || '';

        // load profile row from `profiles` table (if exists) to get avatar_url and canonical username/email
        try {
            const { data: profile, error } = await sb
                .from('profiles')
                .select('*')
                .eq('id', session.user.id)
                .maybeSingle();
            if (error) throw error;
            if (profile) {
                // prefer profile values when present
                profileUsername.value = profile.username || profileUsername.value;
                profileEmail.value = profile.email || profileEmail.value;
                if (profile.avatar_url) {
                    // attempt to create a signed URL for preview (1 hour)
                    try {
                        const { data: signed, error: errSigned } = await sb.storage.from('avatars').createSignedUrl(profile.avatar_url, 3600);
                        if (!errSigned && signed?.signedUrl) {
                            avatarPreview.src = signed.signedUrl;
                        } else {
                            // fallback to public url
                            const { data: pub } = sb.storage.from('avatars').getPublicUrl(profile.avatar_url);
                            avatarPreview.src = pub.publicUrl || '';
                        }
                        avatarPreview.classList.remove('hidden');
                    } catch (e) {
                        console.warn('Could not load avatar preview', e);
                    }
                }
            }
        } catch (err) {
            console.warn('Could not fetch profile row:', err);
        }

        // load the user's reports for dashboard
        loadUserReports(session.user.id, sb);
        // reveal admin portal button if appropriate
        const adminBtn = document.getElementById('adminPortalBtn');
        if (profile?.is_admin && adminBtn) {
            adminBtn.classList.remove('hidden');
            adminBtn.addEventListener('click', () => { window.location.href = 'admin.html'; });
        }
    } else {
        profileSection.classList.add('hidden');
    }
}

document.addEventListener('DOMContentLoaded', loadProfile);

updateProfileBtn.addEventListener('click', async e => {
    e.preventDefault();
    clearProfileMessages();
    const newEmail = profileEmail.value;
    const newPassword = profilePassword.value;
    const newUsername = profileUsername.value;
    const avatarFile = profileAvatarInput.files && profileAvatarInput.files[0];

    try {
        const sb = await ensureSupabase();
        if (!sb) {
            profileError.textContent = 'Service unavailable';
            return;
        }

        const opts = {};
        if (newEmail) opts.email = newEmail;
        if (newPassword) opts.password = newPassword;
        if (newUsername) opts.data = { username: newUsername };
        const { data, error } = await sb.auth.updateUser(opts);
        if (error) throw error;

        // Update profile row and upload avatar if present
        try {
            const user = (await sb.auth.getUser()).data.user;
            let avatarPath = null;
            if (avatarFile && user) {
                const timestamp = Date.now();
                const safeName = `${timestamp}_${avatarFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                const path = `${user.id}/${safeName}`;
                const { error: upErr } = await sb.storage.from('avatars').upload(path, avatarFile, { upsert: true });
                if (upErr) throw upErr;
                avatarPath = path;
            }

            // Upsert into profiles table
            const profilePayload = { id: user.id, username: newUsername || undefined, email: newEmail || undefined };
            if (avatarPath) profilePayload.avatar_url = avatarPath;
            const { error: pErr } = await sb.from('profiles').upsert(profilePayload, { returning: 'minimal' });
            if (pErr) throw pErr;
        } catch (profErr) {
            console.warn('Profile update/upload error', profErr);
            // non-fatal: continue
        }
        
        profileMsg.textContent = 'Account updated successfully.';
        profilePassword.value = '';
    } catch (err) {
        console.error('update profile error', err);
        profileError.textContent = err.message || 'Could not update account.';
    }
});

// avatar preview handler
if (profileAvatarInput) {
    profileAvatarInput.addEventListener('change', () => {
        const file = profileAvatarInput.files && profileAvatarInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            avatarPreview.src = e.target.result;
            avatarPreview.classList.remove('hidden');
            if (avatarPlaceholder) avatarPlaceholder.style.display = 'none';
        };
        reader.readAsDataURL(file);
    });
}

// --- user reports ---
async function loadUserReports(userId, sb) {
    const container = document.getElementById('userReportsContainer');
    if (!container) return;
    container.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:#9ca3af;">Loading your reports...</p>';
    try {
        const { data, error } = await sb.from('reports').select('*').eq('user_id', userId).order('created_at', { ascending: false });
        if (error) throw error;
        const reports = data || [];
        if (reports.length === 0) {
            container.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:#9ca3af;">You have not submitted any reports.</p>';
            return;
        }
        container.innerHTML = '';
        reports.forEach(r => {
            const card = document.createElement('div');
            card.className = 'scam-card';
            const timeAgo = getTimeAgo(new Date(r.created_at));
            card.innerHTML = `
                <div class="scam-header">
                    <h3>${escapeHtml(r.scammer_name || 'Unknown')}</h3>
                    <span class="report-date">${timeAgo}</span>
                </div>
                <div class="scam-details">
                    <div class="detail-row"><span class="label">Type:</span><span class="value">${escapeHtml(r.type || 'Unknown')}</span></div>
                    <div class="detail-row"><span class="label">Contact:</span><span class="value">${escapeHtml(r.phone||r.email||r.contact_info||'N/A')}</span></div>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (err) {
        console.error('Error loading user reports', err);
        container.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:#e74c3c;">Unable to load reports.</p>';
    }
}

// Remove avatar handler
if (removeAvatarBtn) {
    removeAvatarBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('Remove your avatar? This will delete the file from storage.')) return;
        try {
            const user = (await supabase.auth.getUser()).data.user;
            if (!user) throw new Error('Not authenticated');
            // fetch profile to get path
            const { data: profile, error: pErr } = await supabase.from('profiles').select('avatar_url').eq('id', user.id).maybeSingle();
            if (pErr) throw pErr;
            const avatarPath = profile?.avatar_url;
            if (avatarPath) {
                const { error: delErr } = await supabase.storage.from('avatars').remove([avatarPath]);
                if (delErr) console.warn('Error deleting avatar file:', delErr);
            }
            // update profiles row
            const { error: upErr } = await supabase.from('profiles').upsert({ id: user.id, avatar_url: null }, { returning: 'minimal' });
            if (upErr) throw upErr;
            avatarPreview.src = '';
            avatarPreview.classList.add('hidden');
            if (avatarPlaceholder) avatarPlaceholder.style.display = 'block';
            alert('Avatar removed');
        } catch (err) {
            console.error('Could not remove avatar:', err);
            profileError.textContent = 'Unable to remove avatar';
        }
    });
}

deleteAccountBtn.addEventListener('click', async e => {
    e.preventDefault();
    if (!confirm('Are you sure you want to permanently delete your account? This cannot be undone.')) {
        return;
    }
    clearProfileMessages();
    try {
        const user = (await supabase.auth.getUser()).data.user;
        const res = await fetch('/delete-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: user.id })
        });
        if (!res.ok) throw new Error('Server rejected deletion');
        alert('Your account has been deleted.');
        window.location.href = 'index.html';
    } catch (err) {
        console.error('delete account error', err);
        profileError.textContent = 'Unable to delete account from client. Please contact support or use a server endpoint.';
    }
});
