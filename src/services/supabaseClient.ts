import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// DEBUG - Add this
console.log('🔍 Supabase Config Check:');
console.log('URL:', supabaseUrl);
console.log('KEY:', supabaseKey);
console.log('Is Configured:', Boolean(supabaseUrl && supabaseKey));

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder-key'
);