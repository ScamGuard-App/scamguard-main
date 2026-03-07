/*
  Copy this file to `supabase.js` and fill in your project values.
*/

const SUPABASE_URL = "https://your-project-ref.supabase.co";
const SUPABASE_ANON_KEY = "your_supabase_anon_key";

let supabaseClient = null;

if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  (async () => {
    let attempts = 0;
    while (!window.supabase && attempts < 100) {
      await new Promise(resolve => setTimeout(resolve, 50));
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
