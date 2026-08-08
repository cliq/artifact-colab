/**
 * Sign-in page: an email form that swaps to a code form once a code has
 * been requested, driven by a small inline script (no client framework).
 * `next` is the post-sign-in redirect target, already validated server-side.
 */

import type { FC } from 'hono/jsx';

import { Layout } from './layout.js';

export interface SigninPageProps {
  next?: string;
  csrfToken: string;
  /** Self sign-up is enabled — the same form doubles as account creation, so say so. */
  selfSignup?: boolean;
}

const inlineScript = `
(function () {
  var emailForm = document.getElementById('email-form');
  var codeForm = document.getElementById('code-form');
  var emailInput = document.getElementById('email-input');
  var codeInput = document.getElementById('code-input');
  var codeEmailField = document.getElementById('code-email');
  var errorBox = document.getElementById('signin-error');
  var next = document.getElementById('next-value').value;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = message ? 'block' : 'none';
  }

  var ERROR_MESSAGES = {
    rate_limited: 'Too many code requests. Try again later.',
    invalid: 'That code is invalid. Please try again.',
    expired: 'That code has expired. Request a new one.',
    locked: 'Too many incorrect attempts. Request a new code.',
  };

  emailForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    fetch('/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailInput.value }),
    })
      .then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); })
      .then(function (result) {
        if (!result.res.ok) {
          showError(ERROR_MESSAGES[result.data.error] || 'Something went wrong.');
          return;
        }
        codeEmailField.value = emailInput.value;
        emailForm.style.display = 'none';
        codeForm.style.display = 'block';
        codeInput.focus();
      })
      .catch(function () { showError('Something went wrong.'); });
  });

  codeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    fetch('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: codeEmailField.value, code: codeInput.value, next: next || undefined }),
    })
      .then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); })
      .then(function (result) {
        if (!result.res.ok) {
          showError(ERROR_MESSAGES[result.data.error] || 'Something went wrong.');
          return;
        }
        location.href = result.data.redirect || next || '/';
      })
      .catch(function () { showError('Something went wrong.'); });
  });
})();
`;

export const SigninPage: FC<SigninPageProps> = ({ next, csrfToken, selfSignup }) => {
  return (
    <Layout title="Sign in - Artifact Colab" csrfToken={csrfToken}>
      <div class="card form-card">
        <h1>{selfSignup ? 'Sign in or create an account' : 'Sign in'}</h1>
        <div id="signin-error" class="error-message" style="display:none"></div>
        <input type="hidden" id="next-value" value={next ?? ''} />

        <form id="email-form">
          <div class="field">
            <label for="email-input">Work email</label>
            <input type="email" id="email-input" name="email" required autofocus placeholder="you@company.com" />
          </div>
          <button type="submit">Send code</button>
        </form>

        <form id="code-form" style="display:none">
          <input type="hidden" id="code-email" name="email" />
          <div class="field">
            <label for="code-input">Enter the 6-digit code we emailed you</label>
            <input type="text" id="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" required />
          </div>
          <button type="submit">Verify</button>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: inlineScript }} />
    </Layout>
  );
};
