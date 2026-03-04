// Example supabase config. DO NOT commit your real keys.
// Copy this file to `js/supabase.js` and fill values locally.

const SUPABASE_URL = "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = "your-public-anon-key";

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

export default supabase;
