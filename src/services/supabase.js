import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ||
  "https://ahattpqrjmhkzsmnbdzs.supabase.co";

const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "sb_publishable_DOYQQCgscKWJGYXZ64BKkQ_yvk_ZNW3";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
