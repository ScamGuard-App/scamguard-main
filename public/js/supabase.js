/*
  Fill in your `SUPABASE_URL` and `SUPABASE_ANON_KEY` locally before running.
*/

const SUPABASE_URL = "FILL_HERE";
const SUPABASE_ANON_KEY = "FILL_HERE";

let supabaseClient = null;

// Create the client if window.supabase is available, otherwise set up listeners
if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  // Wait for supabase to be available
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

// Helper to ensure supabase is ready
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
    
    // Timeout fallback
    setTimeout(() => resolve(supabaseClient), 5000);
  });
}

export { ensureSupabase };
export default supabaseClient;



