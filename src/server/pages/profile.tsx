/**
 * Profile settings page: display name (empty by default — comments fall back
 * to the email) and the Gravatar tied to the account's email address.
 */

import type { FC } from 'hono/jsx';

import type { User } from '../db/schema.js';
import { Layout } from './layout.js';

export interface ProfilePageProps {
  user: User;
  csrfToken: string;
  isInstanceAdmin: boolean;
  avatarUrl: string;
  saved?: boolean;
}

export const ProfilePage: FC<ProfilePageProps> = ({ user, csrfToken, isInstanceAdmin, avatarUrl, saved }) => {
  return (
    <Layout title="Profile - Artifact Colab" user={user} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin}>
      <h1>Profile</h1>
      {saved && <p class="muted">Saved.</p>}

      <section class="settings-section">
        <form method="post" action="/settings/profile" class="card form-card">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <div class="field">
            <label for="name-input">Display name</label>
            <input type="text" id="name-input" name="name" value={user.name ?? ''} maxlength={120} placeholder={user.email} />
            <p class="muted small">Shown on your comments. Leave empty to show your email address instead.</p>
          </div>
          <button type="submit">Save</button>
        </form>
      </section>

      <section class="settings-section">
        <h2>Avatar</h2>
        <div class="card form-card profile-avatar-row">
          <img class="profile-avatar" src={avatarUrl} alt="Your avatar" referrerpolicy="no-referrer" />
          <p class="muted small">
            Avatars come from <a href="https://gravatar.com">Gravatar</a>, based on your email address ({user.email}).
            Change it there and it updates here.
          </p>
        </div>
      </section>
    </Layout>
  );
};
