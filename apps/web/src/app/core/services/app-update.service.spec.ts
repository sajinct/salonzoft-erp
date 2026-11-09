import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdateService } from './app-update.service';

function setup(enabled = true) {
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<{ type: 'UNRECOVERABLE_STATE'; reason: string }>();
  const events = new Subject<unknown>();
  const sw = {
    isEnabled: enabled,
    versionUpdates,
    unrecoverable,
    checkForUpdate: vi.fn().mockResolvedValue(false),
    activateUpdate: vi.fn().mockResolvedValue(true),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: sw },
      { provide: Router, useValue: { events } },
    ],
  });
  const service = TestBed.inject(AppUpdateService);
  const reload = vi.spyOn(service as unknown as { reload: () => void }, 'reload').mockImplementation(() => undefined);
  return { service, sw, versionUpdates, unrecoverable, events, reload };
}

const ready = (version = '1.0.1', commit = 'abc1234'): VersionEvent => ({
  type: 'VERSION_READY',
  currentVersion: { hash: 'old' },
  latestVersion: { hash: 'new', appData: { version, commit } },
});

describe('AppUpdateService', () => {
  it('checks for updates on start', () => {
    const { service, sw } = setup();
    service.start();
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits for the next navigation to apply a downloaded version', async () => {
    const { service, sw, versionUpdates, events, reload } = setup();
    service.start();
    versionUpdates.next(ready());
    expect(service.ready()).toBe(true);
    expect(service.next()).toBe('1.0.1 · abc1234');
    expect(reload).not.toHaveBeenCalled();

    events.next(new NavigationEnd(1, '/pos', '/pos'));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not reload on navigation when nothing is waiting', () => {
    const { service, events, reload } = setup();
    service.start();
    events.next(new NavigationEnd(1, '/', '/'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the cached app is unrecoverable', () => {
    const { service, unrecoverable, reload } = setup();
    service.start();
    unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'evicted' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the service worker is off (development)', async () => {
    const { service, sw } = setup(false);
    service.start();
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    expect(await service.check()).toBe(false);
  });
});
