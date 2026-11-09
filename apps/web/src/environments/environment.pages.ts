import { Environment } from './environment.model';

// GitHub Pages build, served at the custom domain https://erp.salonzoft.com/
// (Cloudflare DNS → GitHub Pages; set under repo Settings → Pages).
// The Pages workflow replaces the Supabase placeholders from repository
// variables SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY when they are set.
export const environment: Environment = {
  production: true,
  appUrl: 'https://erp.salonzoft.com',
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabasePublishableKey: 'REPLACE_WITH_PUBLISHABLE_KEY',
};
