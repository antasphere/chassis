import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  invitations,
  workspaceMembers,
  user as userTable,
  type Db,
  type Invitation
} from '@antasphere/chassis-db';

/**
 * Token-bearing invitations; the database holds only sha256 hashes.
 * Acceptance works with zero SMTP — the copyable link is the primary path,
 * mail is a bonus.
 *
 * Each invitation carries TWO independent tokens for one row (ADR 009):
 * `token` is the copyable link handed to the inviter (always in the create
 * response), `emailToken` appears ONLY inside the invitation email. Both
 * redeem the same invitation, but which one was presented tells the accept
 * flow whether the accepter demonstrably controls the invited mailbox — the
 * admin-visible link never proves that, the emailed token does.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A live invitation plus which of its two tokens the caller presented. */
export interface InvitationMatch {
  invitation: Invitation;
  /** True when the presented token is the one that ONLY the email carried. */
  viaEmailToken: boolean;
}

export class InvitationService {
  constructor(private readonly db: Db) {}

  async create(opts: {
    workspaceId: string;
    email: string;
    role: 'owner' | 'admin' | 'member';
    invitedBy: string;
  }): Promise<{ invitation: Invitation; token: string; emailToken: string }> {
    const email = opts.email.toLowerCase().trim();

    // Refuse duplicates: an active member or an open invitation.
    const [existingMember] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(userTable.email, email),
          eq(workspaceMembers.workspaceId, opts.workspaceId),
          eq(workspaceMembers.isActive, true)
        )
      )
      .limit(1);
    if (existingMember) throw new InvitationError('already_member', 'This email is already an active member');

    const [open] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email),
          eq(invitations.workspaceId, opts.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          sql`${invitations.expiresAt} > now()`
        )
      )
      .limit(1);
    if (open)
      throw new InvitationError('already_invited', 'An open invitation for this email already exists');

    const token = randomBytes(32).toString('base64url');
    const emailToken = randomBytes(32).toString('base64url');
    const [invitation] = await this.db
      .insert(invitations)
      .values({
        workspaceId: opts.workspaceId,
        email,
        role: opts.role,
        tokenHash: hashToken(token),
        emailTokenHash: hashToken(emailToken),
        invitedBy: opts.invitedBy,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS)
      })
      .returning();
    if (!invitation) throw new Error('invitation insert failed');
    return { invitation, token, emailToken };
  }

  /**
   * Find a live (unaccepted, unrevoked, unexpired) invitation by raw token —
   * either the copyable-link token or the emailed one — and report which.
   */
  async findLiveByToken(token: string): Promise<InvitationMatch | null> {
    const hash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          or(eq(invitations.tokenHash, hash), eq(invitations.emailTokenHash, hash)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt)
        )
      )
      .limit(1);
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return { invitation: row, viaEmailToken: row.emailTokenHash === hash };
  }

  /**
   * Join: create the membership and stamp acceptance atomically enough that
   * a token cannot be redeemed twice (the accepted_at guard is the gate).
   */
  async accept(invitation: Invitation, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(invitations)
        .set({ acceptedAt: sql`now()` })
        .where(
          and(
            eq(invitations.id, invitation.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > now()`
          )
        )
        .returning({ id: invitations.id });
      if (updated.length === 0) return false; // redeemed, revoked, or expired meanwhile

      // Rejoin after deactivation reactivates the existing row.
      const [existing] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, userId))
        )
        .limit(1);
      if (existing) {
        await tx
          .update(workspaceMembers)
          .set({ isActive: true, role: invitation.role, invitedBy: invitation.invitedBy })
          .where(eq(workspaceMembers.id, existing.id));
      } else {
        await tx.insert(workspaceMembers).values({
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
          invitedBy: invitation.invitedBy
        });
      }
      return true;
    });
  }
}

export class InvitationError extends Error {
  constructor(
    public readonly code: 'already_member' | 'already_invited',
    message: string
  ) {
    super(message);
  }
}
