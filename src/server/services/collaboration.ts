import { createHash, randomBytes } from 'node:crypto';

import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { DB, DBOrTx } from '../db/index.js';
import {
  documentCollaborators,
  documentInvitations,
  documents,
  teamMembers,
  users,
  type DocumentCollaborator,
  type DocumentInvitation,
  type User,
} from '../db/schema.js';
import { pruneDocumentWatches, resolveDocumentAccess } from './access.js';

export type CollaborationRole = 'viewer' | 'editor';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EDIT_REQUEST_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 60 * 60 * 1000;
const BURST_LIMITS = { invite: 20, resend: 10, editRequest: 5 } as const;

const bursts = new WeakMap<object, Map<string, number[]>>();

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: sha256hex(token) };
}

export function normalizeInvitationEmail(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).trim().toLowerCase();
}

export function isCollaborationRole(value: string): value is CollaborationRole {
  return value === 'viewer' || value === 'editor';
}

export function takeCollaborationRateLimit(
  db: DB,
  kind: keyof typeof BURST_LIMITS,
  actorId: string,
  now = new Date(),
): boolean {
  let perDb = bursts.get(db as object);
  if (!perDb) {
    perDb = new Map();
    bursts.set(db as object, perDb);
  }
  const key = `${kind}:${actorId}`;
  const cutoff = now.getTime() - BURST_WINDOW_MS;
  const recent = (perDb.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= BURST_LIMITS[kind]) {
    perDb.set(key, recent);
    return false;
  }
  recent.push(now.getTime());
  perDb.set(key, recent);
  return true;
}

function activeDocument(db: DBOrTx, slug: string) {
  const document = db.select().from(documents).where(eq(documents.id, slug)).get();
  if (!document) return undefined;
  const ownerActive = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, document.teamId), eq(teamMembers.userId, document.createdBy)))
    .get();
  return ownerActive ? document : undefined;
}

export function hasLiveDocumentInvitation(db: DBOrTx, email: string, now = new Date()): boolean {
  const normalized = normalizeInvitationEmail(email);
  if (!normalized) return false;
  const invitations = db
    .select({ documentId: documentInvitations.documentId })
    .from(documentInvitations)
    .where(
      and(
        eq(documentInvitations.email, normalized),
        eq(documentInvitations.status, 'pending'),
        gt(documentInvitations.expiresAt, now),
      ),
    )
    .all();
  return invitations.some((invitation) => activeDocument(db, invitation.documentId) !== undefined);
}

export interface CollaboratorView extends DocumentCollaborator {
  email: string;
}

export interface CollaborationState {
  invitations: DocumentInvitation[];
  collaborators: CollaboratorView[];
}

export function collaborationState(db: DBOrTx, documentId: string, now = new Date()): CollaborationState {
  const invitations = db
    .select()
    .from(documentInvitations)
    .where(eq(documentInvitations.documentId, documentId))
    .orderBy(asc(documentInvitations.createdAt))
    .all();

  const expiredIds = invitations
    .filter((invitation) => invitation.status === 'pending' && invitation.expiresAt.getTime() <= now.getTime())
    .map((invitation) => invitation.id);
  if (expiredIds.length > 0) {
    db.update(documentInvitations)
      .set({ status: 'expired', updatedAt: now })
      .where(inArray(documentInvitations.id, expiredIds))
      .run();
    for (const invitation of invitations) {
      if (expiredIds.includes(invitation.id)) {
        invitation.status = 'expired';
        invitation.updatedAt = now;
      }
    }
  }

  const collaborators = db
    .select({
      documentId: documentCollaborators.documentId,
      userId: documentCollaborators.userId,
      role: documentCollaborators.role,
      grantedBy: documentCollaborators.grantedBy,
      createdAt: documentCollaborators.createdAt,
      updatedAt: documentCollaborators.updatedAt,
      editRequestedAt: documentCollaborators.editRequestedAt,
      email: users.email,
    })
    .from(documentCollaborators)
    .innerJoin(users, eq(users.id, documentCollaborators.userId))
    .where(eq(documentCollaborators.documentId, documentId))
    .orderBy(asc(users.email))
    .all();

  return { invitations, collaborators };
}

export type CreateInvitationResult =
  | { email: string; ok: true; invitation: DocumentInvitation; token: string }
  | {
      email: string;
      ok: false;
      error: 'invalid_email' | 'invalid_role' | 'duplicate' | 'self' | 'already_invited' | 'already_collaborator';
    };

export function createDocumentInvitations(
  db: DB,
  documentId: string,
  owner: User,
  inputs: Array<{ email: string; role: string }>,
  now = new Date(),
): CreateInvitationResult[] {
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== owner.id) return [];

    const seen = new Set<string>();
    return inputs.map((input): CreateInvitationResult => {
      const email = normalizeInvitationEmail(input.email);
      if (!z.email().safeParse(email).success) return { email, ok: false, error: 'invalid_email' };
      if (!isCollaborationRole(input.role)) return { email, ok: false, error: 'invalid_role' };
      if (seen.has(email)) return { email, ok: false, error: 'duplicate' };
      seen.add(email);
      if (email === owner.email) return { email, ok: false, error: 'self' };

      const existingUser = tx.select().from(users).where(eq(users.email, email)).get();
      if (existingUser) {
        const grant = tx
          .select()
          .from(documentCollaborators)
          .where(and(eq(documentCollaborators.documentId, documentId), eq(documentCollaborators.userId, existingUser.id)))
          .get();
        if (grant) return { email, ok: false, error: 'already_collaborator' };
      }

      const existing = tx
        .select()
        .from(documentInvitations)
        .where(and(eq(documentInvitations.documentId, documentId), eq(documentInvitations.email, email)))
        .get();
      if (existing?.status === 'pending' && existing.expiresAt.getTime() > now.getTime()) {
        return { email, ok: false, error: 'already_invited' };
      }
      if (existing?.status === 'accepted') return { email, ok: false, error: 'already_collaborator' };

      const { token, tokenHash } = newToken();
      const values = {
        documentId,
        email,
        role: input.role,
        invitedBy: owner.id,
        tokenHash,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        status: 'pending' as const,
        acceptedBy: null,
        acceptedAt: null,
        deliveryStatus: null,
        // Claim the initial send as well, so Resend cannot rotate its link mid-delivery.
        lastDeliveryAt: now,
      };
      const invitation = existing
        ? tx.update(documentInvitations).set(values).where(eq(documentInvitations.id, existing.id)).returning().get()
        : tx
            .insert(documentInvitations)
            .values({ id: randomId(), createdAt: now, ...values })
            .returning()
            .get();
      return { email, ok: true, invitation, token };
    });
  });
}

export function recordInvitationDelivery(
  db: DB,
  invitationId: string,
  tokenHash: string,
  ok: boolean,
  now = new Date(),
): void {
  db.update(documentInvitations)
    .set({ deliveryStatus: ok ? 'sent' : 'failed', lastDeliveryAt: now, updatedAt: now })
    .where(and(eq(documentInvitations.id, invitationId), eq(documentInvitations.tokenHash, tokenHash)))
    .run();
}

export type ResendResult =
  | { ok: true; invitation: DocumentInvitation; token: string }
  | { ok: false; error: 'not_found' | 'not_resendable' | 'cooldown' };

export function resendDocumentInvitation(
  db: DB,
  documentId: string,
  invitationId: string,
  ownerId: string,
  now = new Date(),
): ResendResult {
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== ownerId) return { ok: false, error: 'not_found' };
    const invitation = tx
      .select()
      .from(documentInvitations)
      .where(and(eq(documentInvitations.id, invitationId), eq(documentInvitations.documentId, documentId)))
      .get();
    if (!invitation) return { ok: false, error: 'not_found' };
    if (invitation.status !== 'pending' && invitation.status !== 'expired') return { ok: false, error: 'not_resendable' };
    if (invitation.lastDeliveryAt && now.getTime() - invitation.lastDeliveryAt.getTime() < 60_000) {
      return { ok: false, error: 'cooldown' };
    }
    const { token, tokenHash } = newToken();
    const updated = tx
      .update(documentInvitations)
      .set({
        tokenHash,
        status: 'pending',
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        updatedAt: now,
        deliveryStatus: null,
        // Claim the resend cooldown in the same transaction as token
        // rotation. A second request must not rotate away a link while the
        // first request is still awaiting email delivery.
        lastDeliveryAt: now,
      })
      .where(and(eq(documentInvitations.id, invitationId), eq(documentInvitations.status, invitation.status)))
      .returning()
      .get();
    return updated ? { ok: true, invitation: updated, token } : { ok: false, error: 'not_resendable' };
  });
}

export type RoleChangeResult =
  | { ok: true; invitation?: DocumentInvitation; collaborator?: DocumentCollaborator }
  | { ok: false; error: 'not_found' | 'not_editable' };

export function changeInvitationRole(
  db: DB,
  documentId: string,
  invitationId: string,
  ownerId: string,
  role: string,
  now = new Date(),
): RoleChangeResult {
  if (!isCollaborationRole(role)) return { ok: false, error: 'not_editable' };
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== ownerId) return { ok: false, error: 'not_found' };
    const invitation = tx
      .select()
      .from(documentInvitations)
      .where(and(eq(documentInvitations.id, invitationId), eq(documentInvitations.documentId, documentId)))
      .get();
    if (!invitation) return { ok: false, error: 'not_found' };
    if (invitation.status === 'pending') {
      const updated = tx
        .update(documentInvitations)
        .set({ role, updatedAt: now })
        .where(and(eq(documentInvitations.id, invitation.id), eq(documentInvitations.status, 'pending')))
        .returning()
        .get();
      return updated ? { ok: true, invitation: updated } : { ok: false, error: 'not_editable' };
    }
    if (invitation.status === 'accepted' && invitation.acceptedBy) {
      const collaborator = tx
        .update(documentCollaborators)
        .set({ role, updatedAt: now })
        .where(
          and(
            eq(documentCollaborators.documentId, documentId),
            eq(documentCollaborators.userId, invitation.acceptedBy),
          ),
        )
        .returning()
        .get();
      if (!collaborator) return { ok: false, error: 'not_editable' };
      const updated = tx
        .update(documentInvitations)
        .set({ role, updatedAt: now })
        .where(eq(documentInvitations.id, invitation.id))
        .returning()
        .get();
      return { ok: true, invitation: updated, collaborator };
    }
    return { ok: false, error: 'not_editable' };
  });
}

export function revokeDocumentInvitation(
  db: DB,
  documentId: string,
  invitationId: string,
  ownerId: string,
  now = new Date(),
): boolean {
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== ownerId) return false;
    const invitation = tx
      .select()
      .from(documentInvitations)
      .where(and(eq(documentInvitations.id, invitationId), eq(documentInvitations.documentId, documentId)))
      .get();
    if (!invitation) return false;
    if (invitation.acceptedBy) {
      tx.delete(documentCollaborators)
        .where(
          and(eq(documentCollaborators.documentId, documentId), eq(documentCollaborators.userId, invitation.acceptedBy)),
        )
        .run();
    }
    tx.update(documentInvitations)
      .set({ status: 'revoked', updatedAt: now, tokenHash: sha256hex(randomBytes(32).toString('hex')) })
      .where(eq(documentInvitations.id, invitation.id))
      .run();
    pruneDocumentWatches(tx, documentId);
    return true;
  });
}

export function changeCollaboratorRole(
  db: DB,
  documentId: string,
  userId: string,
  ownerId: string,
  role: string,
  now = new Date(),
): DocumentCollaborator | undefined {
  if (!isCollaborationRole(role)) return undefined;
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== ownerId || userId === ownerId) return undefined;
    const collaborator = tx
      .update(documentCollaborators)
      .set({ role, updatedAt: now })
      .where(and(eq(documentCollaborators.documentId, documentId), eq(documentCollaborators.userId, userId)))
      .returning()
      .get();
    if (!collaborator) return undefined;
    tx.update(documentInvitations)
      .set({ role, updatedAt: now })
      .where(
        and(
          eq(documentInvitations.documentId, documentId),
          eq(documentInvitations.acceptedBy, userId),
          eq(documentInvitations.status, 'accepted'),
        ),
      )
      .run();
    return collaborator;
  });
}

export function revokeDocumentCollaborator(
  db: DB,
  documentId: string,
  userId: string,
  ownerId: string,
  now = new Date(),
): boolean {
  return db.transaction((tx) => {
    const document = activeDocument(tx, documentId);
    if (!document || document.createdBy !== ownerId || userId === ownerId) return false;
    const removed = tx
      .delete(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, documentId), eq(documentCollaborators.userId, userId)))
      .run();
    if (removed.changes === 0) return false;
    tx.update(documentInvitations)
      .set({ status: 'revoked', updatedAt: now, tokenHash: sha256hex(randomBytes(32).toString('hex')) })
      .where(and(eq(documentInvitations.documentId, documentId), eq(documentInvitations.acceptedBy, userId)))
      .run();
    pruneDocumentWatches(tx, documentId);
    return true;
  });
}

export type InvitationInspection =
  | { kind: 'missing' }
  | { kind: 'expired'; invitation: DocumentInvitation }
  | { kind: 'unavailable'; invitation: DocumentInvitation }
  | { kind: 'available'; invitation: DocumentInvitation };

export function inspectDocumentInvitation(db: DB, token: string, now = new Date()): InvitationInspection {
  const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.tokenHash, sha256hex(token))).get();
  if (!invitation) return { kind: 'missing' };
  if (invitation.status === 'pending' && invitation.expiresAt.getTime() <= now.getTime()) {
    db.update(documentInvitations)
      .set({ status: 'expired', updatedAt: now })
      .where(and(eq(documentInvitations.id, invitation.id), eq(documentInvitations.status, 'pending')))
      .run();
    invitation.status = 'expired';
    invitation.updatedAt = now;
    return { kind: 'expired', invitation };
  }
  if (!activeDocument(db, invitation.documentId)) return { kind: 'unavailable', invitation };
  if (invitation.status !== 'pending' && invitation.status !== 'accepted') return { kind: 'unavailable', invitation };
  return { kind: 'available', invitation };
}

export type AcceptInvitationResult =
  | { ok: true; slug: string; alreadyAccepted: boolean }
  | { ok: false; error: 'not_found' | 'wrong_account' | 'expired' | 'unavailable' };

export function acceptDocumentInvitation(
  db: DB,
  token: string,
  user: User,
  now = new Date(),
): AcceptInvitationResult {
  return db.transaction((tx) => {
    const invitation = tx.select().from(documentInvitations).where(eq(documentInvitations.tokenHash, sha256hex(token))).get();
    if (!invitation) return { ok: false, error: 'not_found' };
    if (invitation.email !== normalizeInvitationEmail(user.email)) return { ok: false, error: 'wrong_account' };
    if (invitation.expiresAt.getTime() <= now.getTime() && invitation.status === 'pending') {
      tx.update(documentInvitations)
        .set({ status: 'expired', updatedAt: now })
        .where(and(eq(documentInvitations.id, invitation.id), eq(documentInvitations.status, 'pending')))
        .run();
      return { ok: false, error: 'expired' };
    }
    if (!activeDocument(tx, invitation.documentId)) return { ok: false, error: 'unavailable' };
    if (invitation.status === 'accepted' && invitation.acceptedBy === user.id) {
      const collaborator = tx
        .select()
        .from(documentCollaborators)
        .where(and(eq(documentCollaborators.documentId, invitation.documentId), eq(documentCollaborators.userId, user.id)))
        .get();
      return collaborator
        ? { ok: true, slug: invitation.documentId, alreadyAccepted: true }
        : { ok: false, error: 'unavailable' };
    }
    if (invitation.status !== 'pending') return { ok: false, error: 'unavailable' };

    tx.insert(documentCollaborators)
      .values({
        documentId: invitation.documentId,
        userId: user.id,
        role: invitation.role,
        grantedBy: invitation.invitedBy,
        createdAt: now,
        updatedAt: now,
        editRequestedAt: null,
      })
      .onConflictDoUpdate({
        target: [documentCollaborators.documentId, documentCollaborators.userId],
        set: { role: invitation.role, grantedBy: invitation.invitedBy, updatedAt: now },
      })
      .run();
    const accepted = tx
      .update(documentInvitations)
      .set({ status: 'accepted', acceptedBy: user.id, acceptedAt: now, updatedAt: now })
      .where(and(eq(documentInvitations.id, invitation.id), eq(documentInvitations.status, 'pending')))
      .run();
    return accepted.changes > 0
      ? { ok: true, slug: invitation.documentId, alreadyAccepted: false }
      : { ok: false, error: 'unavailable' };
  });
}

export type EditRequestStart =
  | { ok: true; ownerEmail: string; documentTitle: string; collaborator: DocumentCollaborator }
  | { ok: false; error: 'not_allowed' | 'cooldown' };

export function beginEditPermissionRequest(
  db: DB,
  documentId: string,
  userId: string,
  now = new Date(),
): EditRequestStart {
  return db.transaction((tx) => {
    const access = resolveDocumentAccess(tx, documentId, userId);
    if (!access?.canRequestEdit) return { ok: false, error: 'not_allowed' };
    const document = access.document;
    const collaborator = tx
      .select()
      .from(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, documentId), eq(documentCollaborators.userId, userId)))
      .get();
    if (!collaborator || collaborator.role !== 'viewer') return { ok: false, error: 'not_allowed' };
    if (collaborator.editRequestedAt && now.getTime() - collaborator.editRequestedAt.getTime() < EDIT_REQUEST_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown' };
    }
    const claimed = tx
      .update(documentCollaborators)
      .set({ editRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(documentCollaborators.documentId, documentId),
          eq(documentCollaborators.userId, userId),
          eq(documentCollaborators.role, 'viewer'),
        ),
      )
      .returning()
      .get();
    const owner = tx.select().from(users).where(eq(users.id, document.createdBy)).get();
    return claimed && owner
      ? { ok: true, ownerEmail: owner.email, documentTitle: document.title, collaborator: claimed }
      : { ok: false, error: 'not_allowed' };
  });
}

export function clearFailedEditPermissionRequest(db: DB, documentId: string, userId: string, requestedAt: Date): void {
  db.update(documentCollaborators)
    .set({ editRequestedAt: null })
    .where(
      and(
        eq(documentCollaborators.documentId, documentId),
        eq(documentCollaborators.userId, userId),
        eq(documentCollaborators.editRequestedAt, requestedAt),
      ),
    )
    .run();
}
