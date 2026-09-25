/**
 * Outbound email: one-time login codes and comment digests. In dev/test, set
 * `DEV_LOGIN_CODE_FILE` (codes) or `DEV_EMAIL_FILE` (digests) to skip Resend
 * entirely and append to a file instead — used by e2e/integration tests to
 * read back what a "user" would have received.
 */

import { appendFileSync } from 'node:fs';

import { Resend } from 'resend';

import type { Config } from './config.js';

export async function sendLoginCode(config: Config, email: string, code: string): Promise<{ ok: boolean }> {
  if (config.devLoginCodeFile) {
    appendFileSync(config.devLoginCodeFile, `${email} ${code}\n`);
    return { ok: true };
  }

  try {
    const resend = new Resend(config.resendApiKey);
    const { error } = await resend.emails.send({
      from: config.emailFrom,
      to: email,
      subject: 'Your sign-in code',
      text: `Your sign-in code is ${code}. It expires in 10 minutes.`,
    });
    if (error) throw new Error(`${error.name}: ${error.message}`);
    return { ok: true };
  } catch (err) {
    // A missing/blank API key makes the Resend constructor itself throw —
    // that must surface as the route's 503, not a 500.
    console.error(`Failed to send login code to ${email} via Resend:`, err);
    return { ok: false };
  }
}

/**
 * Invite notification. The link carries no token — the invite is redeemed by
 * the normal sign-in code flow, so this email is a notification, not a
 * credential. Failures are reported, not thrown: the invite row already
 * exists, so the invitee can sign in regardless.
 */
export async function sendInviteEmail(config: Config, to: string, inviterEmail: string, teamName: string): Promise<{ ok: boolean }> {
  const subject = `${inviterEmail} invited you to ${teamName} on Artifact Colab`;
  const text = [
    `${inviterEmail} invited you to the team "${teamName}" on Artifact Colab.`,
    '',
    `Sign in with this email address to get started: ${config.baseUrl}/signin`,
  ].join('\n');

  if (config.devEmailFile) {
    appendFileSync(config.devEmailFile, `${JSON.stringify({ to, subject, text })}\n`);
    return { ok: true };
  }

  try {
    const resend = new Resend(config.resendApiKey);
    const { error } = await resend.emails.send({ from: config.emailFrom, to, subject, text });
    if (error) throw new Error(`${error.name}: ${error.message}`);
    return { ok: true };
  } catch (err) {
    console.error(`Failed to send invite to ${to} via Resend:`, err);
    return { ok: false };
  }
}

async function sendRecordedEmail(
  config: Config,
  message: { to: string; subject: string; text: string },
  description: string,
): Promise<{ ok: boolean }> {
  if (config.devEmailFile) {
    appendFileSync(config.devEmailFile, `${JSON.stringify(message)}\n`);
    return { ok: true };
  }
  try {
    const resend = new Resend(config.resendApiKey);
    const { error } = await resend.emails.send({ from: config.emailFrom, ...message });
    if (error) throw new Error(`${error.name}: ${error.message}`);
    return { ok: true };
  } catch (err) {
    console.error(`Failed to send ${description} to ${message.to} via Resend:`, err);
    return { ok: false };
  }
}

export async function sendDocumentInvitation(
  config: Config,
  to: string,
  inviterEmail: string,
  documentTitle: string,
  role: 'viewer' | 'editor',
  token: string,
): Promise<{ ok: boolean }> {
  const subject = `${inviterEmail} invited you to collaborate on ${documentTitle}`;
  const text = [
    `${inviterEmail} invited you as a ${role === 'editor' ? 'Editor' : 'Viewer'} of “${documentTitle}” on Artifact Colab.`,
    '',
    'Sign in with this exact email address, then accept the invitation:',
    `${config.baseUrl}/invitations/${token}`,
    '',
    'This invitation expires in 7 days.',
  ].join('\n');
  return sendRecordedEmail(config, { to, subject, text }, 'document invitation');
}

export async function sendEditPermissionRequest(
  config: Config,
  to: string,
  requesterEmail: string,
  documentTitle: string,
  slug: string,
): Promise<{ ok: boolean }> {
  const subject = `${requesterEmail} requested edit access to ${documentTitle}`;
  const text = [
    `${requesterEmail} requested Editor access to “${documentTitle}”.`,
    '',
    `Review access: ${config.baseUrl}/d/${encodeURIComponent(slug)}?share=1`,
  ].join('\n');
  return sendRecordedEmail(config, { to, subject, text }, 'edit permission request');
}

/** A comment digest, sent as HTML with a plain-text alternative. */
export async function sendDigest(config: Config, message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  if (config.devEmailFile) {
    appendFileSync(config.devEmailFile, `${JSON.stringify(message)}\n`);
    return;
  }

  const resend = new Resend(config.resendApiKey);
  const { error } = await resend.emails.send({ from: config.emailFrom, ...message });
  if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
}
