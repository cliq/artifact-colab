/**
 * The Backups section of /admin: start a package, watch it pack, and manage
 * previous packages. The form works without JS (post → redirect back to a
 * page showing the running job); the script upgrades it to fetch + polling
 * `/admin/backups/status` and returns to the page once the package is ready.
 */

import type { FC } from 'hono/jsx';

import type { BackupFailure, BackupJob, BackupPackage } from '../services/backups.js';
import { formatBytes } from '../services/teamStats.js';
import { LocalTime } from './localTime.js';

export interface BackupsSectionProps {
  packages: BackupPackage[];
  running: BackupJob | null;
  failure: BackupFailure | null;
  /** Package name the page was sent back for after a backup finished — surfaced with its download link. */
  ready?: string;
}

const PHASE_LABEL: Record<BackupJob['phase'], string> = {
  snapshot: 'Snapshotting database…',
  compress: 'Compressing package…',
};

const backupScript = `
(function () {
  var section = document.getElementById('backups');
  if (!section) return;
  var form = section.querySelector('form.backup-start');
  var progress = section.querySelector('.backup-progress');
  var bar = progress.querySelector('progress');
  var label = progress.querySelector('.backup-progress-label');
  var button = form.querySelector('button');
  var hint = form.querySelector('.backup-hint');
  var phases = ${JSON.stringify(PHASE_LABEL)};

  function show(job) {
    progress.hidden = false;
    if (hint) hint.hidden = true;
    button.disabled = true;
    bar.value = job.percent;
    label.textContent = (phases[job.phase] || 'Working…') + ' ' + job.percent + '%';
  }

  function poll(name) {
    fetch('/admin/backups/status', { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (status) {
        if (status.job) {
          show(status.job);
          setTimeout(function () { poll(status.job.name); }, 1000);
          return;
        }
        location.href = status.failure ? '/admin#backups' : '/admin?backup=' + encodeURIComponent(name) + '#backups';
      })
      .catch(function () { setTimeout(function () { poll(name); }, 3000); });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    button.disabled = true;
    fetch(form.action, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': form.querySelector('input[name=_csrf]').value },
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.job) { location.href = '/admin#backups'; return; }
        show(body.job);
        poll(body.job.name);
      })
      .catch(function () { button.disabled = false; });
  });

  if (progress.dataset.running) poll(progress.dataset.running);
})();
`;

export const BackupsSection: FC<BackupsSectionProps & { csrfToken: string }> = ({ packages, running, failure, ready, csrfToken }) => {
  const readyPackage = ready ? packages.find((p) => p.name === ready) : undefined;
  return (
    <section class="settings-section" id="backups">
      <h2>Backups</h2>
      <p class="muted">
        A backup package holds all current data — teams, users, artifacts and their versions, assets, and comments — as a
        snapshot of the database, taken while the app keeps running. To restore, extract <code>app.db</code> from the
        package and point <code>DATABASE_PATH</code> at it.
      </p>
      {failure && (
        <p class="error-message">
          The last backup failed: {failure.message}
        </p>
      )}
      {readyPackage && (
        <p>
          Backup ready ({formatBytes(readyPackage.sizeBytes)}) —{' '}
          <a href={`/admin/backups/${readyPackage.name}/download`} download={readyPackage.name}>
            download {readyPackage.name}
          </a>
        </p>
      )}

      <div class="card form-card">
        <form method="post" action="/admin/backups" class="backup-start form-row">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <div class="field-grow">
            <div class="backup-progress" hidden={!running} data-running={running?.name}>
              <progress max={100} value={running?.percent ?? 0}></progress>
              <span class="backup-progress-label muted small">
                {running ? `${PHASE_LABEL[running.phase]} ${running.percent}%` : ''}
              </span>
            </div>
            {!running && <span class="backup-hint muted small">Packing takes a moment on large instances; you can leave this page meanwhile.</span>}
          </div>
          <button type="submit" disabled={!!running}>
            Create backup
          </button>
        </form>
      </div>

      {packages.length > 0 ? (
        <div class="card table-card" style="margin-top: 1rem">
          <table>
            <thead>
              <tr>
                <th>Package</th>
                <th class="backup-wide">Size</th>
                <th class="backup-wide">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg) => (
                <tr>
                  <td>
                    <div class="backup-name">{pkg.name}</div>
                    {/* Narrow screens fold the Size and Created columns in here. */}
                    <div class="backup-narrow muted small">
                      {formatBytes(pkg.sizeBytes)} · <LocalTime date={pkg.createdAt} />
                    </div>
                  </td>
                  <td class="backup-wide nowrap">{formatBytes(pkg.sizeBytes)}</td>
                  <td class="backup-wide muted">
                    <LocalTime date={pkg.createdAt} split />
                  </td>
                  <td class="cell-actions backup-actions">
                    <a class="button-link" href={`/admin/backups/${pkg.name}/download`} download={pkg.name}>
                      Download
                    </a>
                    <form
                      method="post"
                      action={`/admin/backups/${pkg.name}/delete`}
                      onsubmit="return confirm('Delete this backup package permanently?')"
                    >
                      <input type="hidden" name="_csrf" value={csrfToken} />
                      <button type="submit" class="secondary danger">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted" style="margin-top: 1rem">
          No backup packages yet.
        </p>
      )}
      <p class="muted small">Downloads resume where they left off if the connection drops.</p>
      <script dangerouslySetInnerHTML={{ __html: backupScript }}></script>
    </section>
  );
};
