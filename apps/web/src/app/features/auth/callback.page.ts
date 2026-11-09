import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { StatePanel } from '../../shared/components/ui';
import { safeNext } from './auth-shared';

/** OAuth / email-confirmation landing. supabase-js exchanges the PKCE code automatically. */
@Component({
  selector: 'sz-callback-page',
  imports: [StatePanel, TranslatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (failed()) {
      <sz-state icon="circle-alert" [heading]="'auth.callbackFailed' | t">
        <a routerLink="/auth/login" class="btn-primary">{{ 'auth.signIn' | t }}</a>
      </sz-state>
    } @else {
      <sz-state [loading]="true" [message]="'auth.completingSignIn' | t" />
    }
  `,
})
export class CallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly next = input<string>();
  protected readonly failed = signal(false);

  async ngOnInit(): Promise<void> {
    await this.auth.ready;
    if (this.auth.isSignedIn()) await this.router.navigateByUrl(safeNext(this.next()), { replaceUrl: true });
    else this.failed.set(true);
  }
}
