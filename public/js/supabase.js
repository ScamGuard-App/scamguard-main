/*
  Fill in your `SUPABASE_URL` and `SUPABASE_ANON_KEY` locally before running.
*/

const SUPABASE_URL = "https://xqxffysambxngnqjzfwt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxeGZmeXNhbWJ4bmducWp6Znd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NjE0MDksImV4cCI6MjA4ODAzNzQwOX0.Eq-A3JOsZDukx7Zu-Fjt7PtJ7amP9H7wxkb9plh0rE8";

let supabaseClient = null;

// In some page loads the CDN script arrives after this module; handle both timings.
if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  // Poll briefly, then fire a custom event once the client is finally ready.
  (async () => {
    let attempts = 0;
    while (!window.supabase && attempts < 100) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
    if (window.supabase && !supabaseClient) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      // Trigger a custom event to notify listeners that supabase is ready
      window.dispatchEvent(new Event('supabase-ready'));
    }
  })();
}

// Shared awaitable helper so call sites don't race the CDN load order.
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
    
    // Fail soft after a short wait; caller can decide how to handle null.
    setTimeout(() => resolve(supabaseClient), 5000);
  });
}

export { ensureSupabase };
export default supabaseClient;



