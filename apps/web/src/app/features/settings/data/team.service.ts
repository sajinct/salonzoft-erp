import { Injectable, inject } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { Database, Tables } from '../../../core/supabase/database.types';
import { unwrap } from '../../../core/supabase/app-error';
import { SUPABASE } from '../../../core/supabase/supabase.client';

export type TeamMember = Database['public']['Functions']['list_tenant_members']['Returns'][number];
export type Invitation = Pick<
  Tables<'tenant_invitations'>,
  'id' | 'email' | 'role_ids' | 'branch_ids' | 'all_branches' | 'status' | 'expires_at' | 'created_at'
>;

export interface InviteInput {
  email: string;
  roleIds: string[];
  allBranches: boolean;
  branchIds: string[];
}

export interface CreatedInvitation {
  invitation_id: string;
  token: string;
  email: string;
  expires_at: string;
  url: string;
}

export interface MemberAccessInput {
  roleIds: string[];
  allBranches: boolean;
  branchIds: string[];
  jobTitle: string | null;
}

/** Team membership data access. All writes go through audited, permission-checked RPCs. */
@Injectable({ providedIn: 'root' })
export class TeamService {
  private readonly sb = inject(SUPABASE);

  async listMembers(tenantId: string): Promise<TeamMember[]> {
    return unwrap(await this.sb.rpc('list_tenant_members', { p_tenant: tenantId })) ?? [];
  }

  async listPendingInvitations(tenantId: string): Promise<Invitation[]> {
    return unwrap(
      await this.sb
        .from('tenant_invitations')
        .select('id, email, role_ids, branch_ids, all_branches, status, expires_at, created_at')
        .eq('tenant_id', tenantId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    );
  }

  async invite(tenantId: string, input: InviteInput): Promise<CreatedInvitation> {
    const result = unwrap(
      await this.sb.rpc('create_invitation', {
        p_tenant: tenantId,
        p_email: input.email,
        p_role_ids: input.roleIds,
        p_all_branches: input.allBranches,
        p_branch_ids: input.allBranches ? [] : input.branchIds,
      }),
    ) as unknown as Omit<CreatedInvitation, 'url'>;
    return { ...result, url: `${environment.appUrl}/accept-invite?token=${result.token}` };
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    unwrap(await this.sb.rpc('revoke_invitation', { p_invitation_id: invitationId }));
  }

  async acceptInvitation(token: string): Promise<{ tenant_id: string; membership_id: string }> {
    return unwrap(await this.sb.rpc('accept_invitation', { p_token: token })) as unknown as {
      tenant_id: string;
      membership_id: string;
    };
  }

  async updateAccess(membershipId: string, input: MemberAccessInput): Promise<void> {
    unwrap(
      await this.sb.rpc('update_member_access', {
        p_membership_id: membershipId,
        p_role_ids: input.roleIds,
        p_all_branches: input.allBranches,
        p_branch_ids: input.allBranches ? [] : input.branchIds,
        p_job_title: input.jobTitle ?? '',
      }),
    );
  }

  async setStatus(membershipId: string, status: 'active' | 'suspended'): Promise<void> {
    unwrap(await this.sb.rpc('set_member_status', { p_membership_id: membershipId, p_status: status }));
  }
}
