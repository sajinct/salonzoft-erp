import { Injectable, computed, inject, signal } from '@angular/core';
import { unwrap } from '../supabase/app-error';
import { SUPABASE } from '../supabase/supabase.client';
import { MyTenant, TenantContext } from './tenant.models';

const TENANT_KEY = 'sz.tenant';
const BRANCH_KEY = 'sz.branch';

export type ContextResolution = 'ok' | 'no-tenants' | 'choose';

function store(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Active business (tenant) + branch for the signed-in user.
 *
 * SECURITY NOTE: the remembered tenant/branch id is only a UI preference. It is
 * re-validated against get_my_tenants() on load, and every query is enforced
 * by RLS on the server — sending another tenant's id simply returns nothing.
 * Permissions here drive navigation/visibility only.
 */
@Injectable({ providedIn: 'root' })
export class TenantContextService {
  private readonly sb = inject(SUPABASE);

  readonly tenants = signal<MyTenant[] | null>(null);
  readonly context = signal<TenantContext | null>(null);
  /** null = all accessible branches. */
  readonly branchId = signal<string | null>(read(BRANCH_KEY));

  readonly tenantId = computed(() => this.context()?.tenant.id ?? null);
  readonly permissions = computed(() => new Set(this.context()?.permissions ?? []));
  readonly modules = computed(() => new Set(this.context()?.modules ?? []));
  readonly branches = computed(() => this.context()?.branches ?? []);
  readonly isOwner = computed(() => this.context()?.membership.is_owner ?? false);
  readonly activeBranch = computed(() => this.branches().find((b) => b.id === this.branchId()) ?? null);

  private loading: Promise<ContextResolution> | null = null;

  can(permission: string): boolean {
    return this.permissions().has(permission);
  }

  canAny(permissions: readonly string[]): boolean {
    const set = this.permissions();
    return permissions.some((p) => set.has(p));
  }

  hasModule(module: string): boolean {
    return this.modules().has(module);
  }

  /** Load tenants and the active context once; used by the tenant guard. */
  ensure(): Promise<ContextResolution> {
    if (this.context()) return Promise.resolve('ok');
    this.loading ??= this.resolve().finally(() => (this.loading = null));
    return this.loading;
  }

  async loadTenants(): Promise<MyTenant[]> {
    const tenants = unwrap(await this.sb.rpc('get_my_tenants')) ?? [];
    this.tenants.set(tenants);
    return tenants;
  }

  async select(tenantId: string): Promise<void> {
    const raw = unwrap(await this.sb.rpc('get_tenant_context', { p_tenant: tenantId }));
    const ctx = raw as unknown as TenantContext;
    this.context.set(ctx);
    store(TENANT_KEY, tenantId);
    // Keep the branch preference only if still accessible.
    const branch = this.branchId();
    if (branch && !ctx.branches.some((b) => b.id === branch)) this.setBranch(null);
    if (!this.branchId() && ctx.branches.length === 1) this.setBranch(ctx.branches[0].id);
  }

  /** Re-fetch the active context (after settings, roles or branch changes). */
  async refresh(): Promise<void> {
    const id = this.tenantId();
    if (id) await this.select(id);
  }

  setBranch(branchId: string | null): void {
    this.branchId.set(branchId);
    store(BRANCH_KEY, branchId);
  }

  clear(): void {
    this.tenants.set(null);
    this.context.set(null);
    this.setBranch(null);
    store(TENANT_KEY, null);
  }

  private async resolve(): Promise<ContextResolution> {
    const tenants = await this.loadTenants();
    if (tenants.length === 0) return 'no-tenants';
    const remembered = read(TENANT_KEY);
    const target = tenants.find((t) => t.tenant_id === remembered) ?? (tenants.length === 1 ? tenants[0] : null);
    if (!target) return 'choose';
    await this.select(target.tenant_id);
    return 'ok';
  }
}
