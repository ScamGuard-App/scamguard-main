/*
  Public Supabase client config for browser usage.
  This file is safe to commit with ANON key only; never place service-role keys here.
*/

const SUPABASE_URL = "https://xqxffysambxngnqjzfwt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxeGZmeXNhbWJ4bmducWp6Znd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NjE0MDksImV4cCI6MjA4ODAzNzQwOX0.Eq-A3JOsZDukx7Zu-Fjt7PtJ7amP9H7wxkb9plh0rE8";

let supabaseClient = null;

if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
    (async () => {
        let attempts = 0;
        while (!window.supabase && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            attempts++;
        }
        if (window.supabase && !supabaseClient) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            window.dispatchEvent(new Event('supabase-ready'));
        }
    })();
}

async function ensureSupabase() {
    if (supabaseClient) return supabaseClient;

    return new Promise((resolve) => {
        if (supabaseClient) {
            resolve(supabaseClient);
            return;
        }

        window.addEventListener('supabase-ready', () => {
            resolve(supabaseClient);
        }, { once: true });

        setTimeout(() => resolve(supabaseClient), 5000);
    });
}

export { ensureSupabase };
export default supabaseClient;
