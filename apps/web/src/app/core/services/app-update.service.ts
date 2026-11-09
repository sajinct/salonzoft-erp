import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';
import { APP_VERSION } from '../../../environments/version';

const CHECK_EVERY_MS = 15 * 60_000;

/**
 * Keeps browser tabs and installed (PWA) copies on the latest deploy.
 *
 * The service worker downloads a new version in the background; it is then
 * applied at a moment that cannot lose work — the next route change (the page
 * being left is gone anyway) — or straight away from the update banner. We
 * check on start, every 15 minutes and whenever the app returns to the
 * foreground, because installed apps can stay open for days.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly current = APP_VERSION;
  /** A newer version is downloaded and waiting to be applied. */
  readonly ready = signal(false);
  /** Version label of the waiting update, when the build stamped one. */
  readonly next = signal<string | null>(null);
  private started = false;
  private applying = false;

  start(): void {
    if (this.started || !this.sw.isEnabled) return;
    this.started = true;

    this.sw.versionUpdates.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.type === 'VERSION_READY') {
        const data = e.latestVersion.appData as { version?: string; commit?: string } | undefined;
        this.next.set(data?.version ? `${data.version}${data.commit ? ' · ' + data.commit : ''}` : null);
        this.ready.set(true);
      }
    });
    // The cached app is broken beyond repair (e.g. files evicted): start fresh.
    this.sw.unrecoverable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.reload());

    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.ready()) void this.apply();
      });

    const onVisible = () => {
      if (this.document.visibilityState === 'visible') void this.check();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.document.removeEventListener('visibilitychange', onVisible);
    });
    void this.check();
  }

  /** Ask the server for a newer version (no-op when offline). */
  async check(): Promise<boolean> {
    if (!this.sw.isEnabled) return false;
    try {
      return await this.sw.checkForUpdate();
    } catch {
      return false;
    }
  }

  /** Switch to the downloaded version now. */
  async apply(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      await this.sw.activateUpdate();
    } catch {
      /* already active or worker gone — a reload still loads the newest files */
    }
    this.reload();
  }

  /** Separate so tests can observe it. */
  protected reload(): void {
    this.document.location.reload();
  }
}
