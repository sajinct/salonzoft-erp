import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { StatePanel } from '../../shared/components/ui';

@Component({
  selector: 'sz-forbidden-page',
  imports: [StatePanel, TranslatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <sz-state icon="lock" [heading]="'errors.forbiddenTitle' | t" [message]="'errors.forbiddenBody' | t">
        <a routerLink="/" class="btn-secondary">{{ 'errors.goHome' | t }}</a>
      </sz-state>
    </div>
  `,
})
export class ForbiddenPage {}

@Component({
  selector: 'sz-not-found-page',
  imports: [StatePanel, TranslatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid min-h-screen place-items-center p-6">
      <sz-state icon="circle-alert" [heading]="'errors.notFoundTitle' | t" [message]="'errors.notFoundBody' | t">
        <a routerLink="/" class="btn-primary">{{ 'errors.goHome' | t }}</a>
      </sz-state>
    </div>
  `,
})
export class NotFoundPage {}
