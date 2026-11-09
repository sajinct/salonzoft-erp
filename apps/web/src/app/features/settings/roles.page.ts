import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LucideDynamicIcon } from '@lucide/angular';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/services/toast.service';
import { TenantContextService } from '../../core/tenant/tenant-context.service';
import { ConfirmService, PageHeader, StatePanel } from '../../shared/components/ui';
import { Module, Permission, Role, RolesService } from './data/settings.services';

/** Role list + permission matrix. Writes go straight to RLS-protected tables (anti-escalation enforced in SQL). */
@Component({
  selector: 'sz-roles-page',
  imports: [ReactiveFormsModule, TranslatePipe, LucideDynamicIcon, PageHeader, StatePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <sz-page-header [heading]="'settings.roles' | t" [subtitle]="'roles.subtitle' | t" />
    <p class="mb-4 text-xs text-muted">{{ 'roles.ownerNote' | t }}</p>

    @if (loading()) {
      <div class="card"><sz-state [loading]="true" /></div>
    } @else {
      <div class="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <div class="space-y-3">
          <div class="card divide-y divide-line">
            @for (role of roles(); track role.id) {
              <button type="button" class="flex w-full items-center gap-2 px-4 py-3 text-start text-sm hover:bg-surface-2" [class.!bg-primary-soft]="role.id === selectedId()" (click)="selectedId.set(role.id)">
                <span class="flex-1 font-medium">{{ i18n.pick(role.name_en, role.name_ar) }}</span>
                <span [class]="role.is_system ? 'badge-muted' : 'badge-primary'">{{ (role.is_system ? 'roles.system' : 'roles.custom') | t }}</span>
              </button>
            }
          </div>
          @if (canManage()) {
            <form class="card space-y-3 p-4" [formGroup]="newRole" (ngSubmit)="create()" novalidate>
              <p class="text-sm font-semibold">{{ 'roles.addCustom' | t }}</p>
              <input class="input" formControlName="name_en" [placeholder]="'roles.nameEn' | t" />
              <input class="input" formControlName="name_ar" [placeholder]="'roles.nameAr' | t" dir="rtl" lang="ar" />
              <button type="submit" class="btn-secondary btn-sm w-full"><svg lucideIcon="plus" [size]="14"></svg>{{ 'common.create' | t }}</button>
            </form>
          }
        </div>

        @if (selected(); as role) {
          <div class="card p-6">
            <div class="mb-4 flex items-center justify-between gap-3">
              <h2 class="text-lg font-semibold">{{ i18n.pick(role.name_en, role.name_ar) }}</h2>
              @if (canManage() && !role.is_system) {
                <button type="button" class="btn-ghost btn-sm text-danger" (click)="remove(role)"><svg lucideIcon="trash-2" [size]="14"></svg>{{ 'common.delete' | t }}</button>
              }
            </div>
            <div class="space-y-5">
              @for (group of groups(); track group.module.code) {
                <section>
                  <h3 class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    {{ i18n.pick(group.module.name_en, group.module.name_ar) }}
                    @if (!ctx.hasModule(group.module.code)) { <span class="badge-warning normal-case">{{ 'roles.moduleNotInPlan' | t }}</span> }
                  </h3>
                  <div class="grid gap-2 sm:grid-cols-2">
                    @for (p of group.permissions; track p.code) {
                      <label
                        class="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm"
                        [class.opacity-50]="!canToggle(p.code)"
                        [title]="canToggle(p.code) ? '' : ('roles.cannotGrant' | t)"
                      >
                        <input type="checkbox" class="checkbox" [checked]="has(role.id, p.code)" [disabled]="!canToggle(p.code) || pending()" (change)="toggle(role, p.code)" />
                        <span class="flex-1">{{ i18n.pick(p.name_en, p.name_ar) }}</span>
                        <code class="hidden text-[10px] text-muted xl:inline" dir="ltr">{{ p.code }}</code>
                      </label>
                    }
                  </div>
                </section>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class RolesPage implements OnInit {
  private readonly service = inject(RolesService);
  protected readonly ctx = inject(TenantContextService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly pending = signal(false);
  protected readonly roles = signal<Role[]>([]);
  protected readonly permissions = signal<Permission[]>([]);
  protected readonly modules = signal<Module[]>([]);
  protected readonly grants = signal<Set<string>>(new Set());
  protected readonly selectedId = signal<string | null>(null);

  protected readonly canManage = computed(() => this.ctx.can('roles.manage'));
  protected readonly selected = computed(() => this.roles().find((r) => r.id === this.selectedId()) ?? null);
  protected readonly groups = computed(() =>
    this.modules()
      .map((module) => ({ module, permissions: this.permissions().filter((p) => p.module_code === module.code) }))
      .filter((g) => g.permissions.length > 0),
  );

  protected readonly newRole = inject(NonNullableFormBuilder).group({
    name_en: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(60)]],
    name_ar: [''],
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    try {
      const data = await this.service.load(tenantId);
      this.roles.set(data.roles);
      this.permissions.set(data.permissions);
      this.modules.set(data.modules);
      this.grants.set(new Set(data.rolePermissions.map((rp) => `${rp.role_id}:${rp.permission_code}`)));
      if (!this.selected()) this.selectedId.set(data.roles[0]?.id ?? null);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.loading.set(false);
    }
  }

  protected has(roleId: string, permission: string): boolean {
    return this.grants().has(`${roleId}:${permission}`);
  }

  /** Mirrors the SQL policy: roles.manage + you must hold the permission yourself. */
  protected canToggle(permission: string): boolean {
    return this.canManage() && this.ctx.can(permission);
  }

  async toggle(role: Role, permission: string): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId) return;
    const key = `${role.id}:${permission}`;
    const granted = this.grants().has(key);
    this.pending.set(true);
    try {
      if (granted) await this.service.revoke(role.id, permission);
      else await this.service.grant(tenantId, role.id, permission);
      this.grants.update((set) => {
        const next = new Set(set);
        if (granted) next.delete(key);
        else next.add(key);
        return next;
      });
      await this.ctx.refresh(); // own permissions may have changed
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.pending.set(false);
    }
  }

  async create(): Promise<void> {
    const tenantId = this.ctx.tenantId();
    if (!tenantId || this.newRole.invalid) {
      this.newRole.markAllAsTouched();
      return;
    }
    const { name_en, name_ar } = this.newRole.getRawValue();
    const code = `custom_${name_en.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'role'}_${Date.now().toString(36).slice(-4)}`;
    try {
      const role = await this.service.createRole(tenantId, { code, name_en: name_en.trim(), name_ar: name_ar.trim() || null });
      this.newRole.reset();
      await this.load();
      this.selectedId.set(role.id);
    } catch (err) {
      this.toast.error(err);
    }
  }

  async remove(role: Role): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('common.delete'),
      message: this.i18n.t('roles.confirmDelete', { name: this.i18n.pick(role.name_en, role.name_ar) }),
      confirmLabel: this.i18n.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.service.deleteRole(role.id);
      this.selectedId.set(null);
      await this.load();
    } catch (err) {
      this.toast.error(err);
    }
  }
}
