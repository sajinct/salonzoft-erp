import { Environment } from './environment.model';

// GitHub Pages build (https://sajinct.github.io/salonzoft-erp/).
// The Pages workflow replaces the Supabase placeholders from repository
// variables SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY when they are set.
export const environment: Environment = {
  production: true,
  appUrl: 'https://sajinct.github.io/salonzoft-erp',
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabasePublishableKey: 'REPLACE_WITH_PUBLISHABLE_KEY',
};
