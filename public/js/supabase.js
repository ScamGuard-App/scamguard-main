/*
  Fill in your `SUPABASE_URL` and `SUPABASE_ANON_KEY` locally before running.
*/

const SUPABASE_URL = "https://xqxffysambxngnqjzfwt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxeGZmeXNhbWJ4bmducWp6Znd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NjE0MDksImV4cCI6MjA4ODAzNzQwOX0.Eq-A3JOsZDukx7Zu-Fjt7PtJ7amP9H7wxkb9plh0rE8";

const supabase = window.supabase?.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

export default supabase;
