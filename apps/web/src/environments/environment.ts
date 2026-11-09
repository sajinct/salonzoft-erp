import { Environment } from './environment.model';

// Local development: values printed by `npx supabase status` (API URL + publishable/anon key).
export const environment: Environment = {
  production: false,
  appUrl: 'http://localhost:4200',
  supabaseUrl: 'http://127.0.0.1:54321',
  supabasePublishableKey: 'REPLACE_WITH_LOCAL_PUBLISHABLE_KEY',
};
