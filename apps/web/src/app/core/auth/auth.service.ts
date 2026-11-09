import { Injectable, computed, inject, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';
import { Lang } from '../i18n/i18n.service';
import { toAppError, unwrap } from '../supabase/app-error';
import { SUPABASE } from '../supabase/supabase.client';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sb = inject(SUPABASE);

  readonly session = signal<Session | null>(null);
  readonly user = computed(() => this.session()?.user ?? null);
  readonly isSignedIn = computed(() => this.session() !== null);
  /** Resolves once the persisted session (or PKCE code in the URL) has been processed. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.sb.auth.getSession().then(({ data }) => this.session.set(data.session));
    this.sb.auth.onAuthStateChange((_event, session) => this.session.set(session));
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw toAppError(error);
  }

  /** Returns true when a session exists immediately (i.e. email confirmation is disabled). */
  async signUp(email: string, password: string, fullName: string, lang: Lang, next = '/'): Promise<boolean> {
    const data = unwrap(
      await this.sb.auth.signUp({
        email,
        password,
        options: {
          // Display-only metadata; never used for authorization.
          data: { full_name: fullName, preferred_language: lang },
          emailRedirectTo: `${environment.appUrl}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      }),
    );
    return data.session !== null;
  }

  async sendPasswordReset(email: string): Promise<void> {
    const { error } = await this.sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${environment.appUrl}/auth/reset-password`,
    });
    if (error) throw toAppError(error);
  }

  async updatePassword(password: string): Promise<void> {
    const { error } = await this.sb.auth.updateUser({ password });
    if (error) throw toAppError(error);
  }

  async signOut(): Promise<void> {
    await this.sb.auth.signOut();
    this.session.set(null);
  }
}
