import { TestBed } from '@angular/core/testing';
import { SUPABASE } from '../supabase/supabase.client';
import { TenantContextService } from './tenant-context.service';

const tenant = (id: string) => ({ tenant_id: id, slug: id, name: id, name_ar: null, status: 'active', is_owner: true, subscription_status: 'trialing', trial_ends_at: null, plan_code: 'professional' });

function fakeClient(tenants: ReturnType<typeof tenant>[], calls: { fn: string; args?: unknown }[]) {
  return {
    rpc: async (fn: string, args?: { p_tenant?: string }) => {
      calls.push({ fn, args });
      if (fn === 'get_my_tenants') return { data: tenants, error: null };
      if (fn === 'get_tenant_context') {
        if (!tenants.some((t) => t.tenant_id === args?.p_tenant)) return { data: null, error: { code: '42501', message: 'FORBIDDEN' } };
        return {
          data: {
            tenant: { id: args?.p_tenant, name: 'X' },
            settings: { timezone: 'Asia/Muscat' },
            membership: { id: 'm', is_owner: false, all_branches: false, job_title: null },
            roles: [],
            permissions: ['dashboard.view'],
            modules: ['dashboard'],
            branches: [{ id: 'b1', code: 'MAIN', name_en: 'Main', name_ar: null, is_main: true, is_active: true, timezone: 'Asia/Muscat' }],
            subscription: null,
            operational: true,
            is_platform_admin: false,
          },
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
}

function setup(tenants: ReturnType<typeof tenant>[]) {
  const calls: { fn: string; args?: unknown }[] = [];
  TestBed.configureTestingModule({ providers: [{ provide: SUPABASE, useValue: fakeClient(tenants, calls) }] });
  return { ctx: TestBed.inject(TenantContextService), calls };
}

describe('TenantContextService', () => {
  beforeEach(() => localStorage.clear());

  it('routes users without businesses to onboarding', async () => {
    const { ctx } = setup([]);
    expect(await ctx.ensure()).toBe('no-tenants');
  });

  it('auto-selects the only business and its only branch', async () => {
    const { ctx } = setup([tenant('t1')]);
    expect(await ctx.ensure()).toBe('ok');
    expect(ctx.tenantId()).toBe('t1');
    expect(ctx.branchId()).toBe('b1');
    expect(ctx.can('dashboard.view')).toBe(true);
    expect(ctx.can('settings.manage')).toBe(false);
  });

  it('asks the user to choose when several businesses exist and none is remembered', async () => {
    const { ctx } = setup([tenant('t1'), tenant('t2')]);
    expect(await ctx.ensure()).toBe('choose');
  });

  it('ignores a remembered tenant id the user no longer belongs to', async () => {
    localStorage.setItem('sz.tenant', 'someone-elses-tenant');
    const { ctx, calls } = setup([tenant('t1'), tenant('t2')]);
    expect(await ctx.ensure()).toBe('choose');
    expect(calls.some((c) => c.fn === 'get_tenant_context')).toBe(false);
  });

  it('restores a valid remembered tenant', async () => {
    localStorage.setItem('sz.tenant', 't2');
    const { ctx } = setup([tenant('t1'), tenant('t2')]);
    expect(await ctx.ensure()).toBe('ok');
    expect(ctx.tenantId()).toBe('t2');
  });

  it('drops a remembered branch that is no longer accessible', async () => {
    localStorage.setItem('sz.branch', 'old-branch');
    const { ctx } = setup([tenant('t1')]);
    await ctx.ensure();
    expect(ctx.branchId()).toBe('b1');
  });
});
