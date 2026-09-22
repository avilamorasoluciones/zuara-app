// ZUARA APP — configuración pública para GitHub Pages + Supabase.
// IMPORTANTE: aquí solo va la Publishable key (sb_publishable_...) o la antigua anon.
// NUNCA coloques una sb_secret_... ni service_role en este archivo.
// La seguridad real está en Supabase Auth + RLS + Edge Functions.
//
// Completa estos dos valores cuando esté creado el proyecto Supabase de ZUARA.
const SUPABASE_URL = 'REEMPLAZAR_CON_SUPABASE_URL_DE_ZUARA';
const SUPABASE_PUBLISHABLE_KEY = 'REEMPLAZAR_CON_SUPABASE_PUBLISHABLE_KEY_DE_ZUARA';

// Se mantiene el nombre usado por el resto de la migración.
const SUPABASE_ANON_KEY = SUPABASE_PUBLISHABLE_KEY;
