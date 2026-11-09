import { InjectionToken } from '@angular/core';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';
import { Database } from './database.types';

export type SalonzoftClient = SupabaseClient<Database>;

/**
 * The single typed Supabase client. Uses only the *publishable* key; all
 * authorization is enforced server-side by RLS and RPC checks.
 * Feature code goes through data-access services, never directly from components.
 */
export const SUPABASE = new InjectionToken<SalonzoftClient>('SUPABASE', {
  providedIn: 'root',
  factory: () =>
    createClient<Database>(environment.supabaseUrl, environment.supabasePublishableKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'sz.auth',
      },
    }),
});
