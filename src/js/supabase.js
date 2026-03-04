/*
  WARNING: This file must NOT contain secret keys in version control.
  Copy `supabase.example.js` to `js/supabase.js` and fill in your
  `SUPABASE_URL` and `SUPABASE_ANON_KEY` locally before running.
*/

const SUPABASE_URL = "REPLACE_WITH_YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "REPLACE_WITH_YOUR_SUPABASE_ANON_KEY";

const supabase = window.supabase?.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

export default supabase;