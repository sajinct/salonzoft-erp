export interface Environment {
  production: boolean;
  /** Public base URL of this Angular app (used for auth redirects & invite links). */
  appUrl: string;
  supabaseUrl: string;
  /**
   * Supabase *publishable* (anon) key. Safe to ship to browsers — every query is
   * still subject to RLS. NEVER put the service-role / secret key here.
   */
  supabasePublishableKey: string;
}
