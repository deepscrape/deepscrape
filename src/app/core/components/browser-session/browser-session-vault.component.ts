import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { BrowserSessionService } from '../../services/browser-session.service';
import { ToolEnvelope } from '../../types';

/** One stored vault entry, as `op=profiles` reports it. Names only, never secrets. */
interface VaultEntry {
  service: string;
  profile: string;
  username?: string;
}

/**
 * The entry list out of a worker reply.
 *
 * Defensive on purpose: the payload shape is the WORKER's contract, and the
 * gateway passes it through unmodified rather than re-modelling it (see
 * `webrain-tools.interface.ts`). So this reads what it recognises and drops the
 * rest, instead of asserting a shape that can drift under it.
 * @param {ToolEnvelope} reply The worker's reply.
 * @return {VaultEntry[]} Every entry it could read.
 */
const entriesFrom = (reply: ToolEnvelope): VaultEntry[] => {
  const data = reply?.data;
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === 'object')
    .map((row) => ({
      service: String(row['service'] ?? ''),
      profile: String(row['profile'] ?? ''),
      username: row['username'] ? String(row['username']) : undefined,
    }))
    .filter((entry) => entry.service.length > 0);
};

/**
 * The credential vault: build it, and log in from it.
 *
 * A section rather than a page, and it composes under the session panel because
 * the two are one flow: open a session, log in, then capture that login here.
 * A tab would hide that sequence behind a click.
 *
 * PAID, and it renders rather than hides that fact. A 402 from the route is the
 * authority -- the route is `paid` because the vault is process-global on the
 * worker and a free caller would be reading credentials it does not own -- so
 * this NEVER guesses the caller's plan client-side. It shows the upgrade state
 * only after the server has said 402.
 *
 * What it can do is bounded by the FIVE advertised vault ops, and deliberately
 * no more: `profiles` lists, `save_state` captures the current logged-in
 * browser, `login` replays an entry, `restore_state` re-applies one, and
 * `close_launch` releases the Chrome a login started. There is no delete op
 * published, so this offers none -- a remove button would be a lie.
 */
@Component({
  selector: 'app-browser-session-vault',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, MatIcon, RouterLink],
  templateUrl: './browser-session-vault.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserSessionVaultComponent {
  private readonly fb = inject(FormBuilder);
  private readonly sessions = inject(BrowserSessionService);

  protected readonly entries = signal<VaultEntry[]>([]);
  protected readonly loading = signal(false);
  /** The op in flight, so only its own button shows a spinner. */
  protected readonly busy = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  /** Set ONLY by a 402 from the route; never inferred from a plan. */
  protected readonly upgradeRequired = signal(false);
  protected readonly hasEntries = computed(() => this.entries().length > 0);

  protected readonly form = this.fb.nonNullable.group({
    service: ['', [Validators.required]],
    profile: ['', [Validators.required]],
    // Needed by `login` only: localStorage is origin-scoped, so a replay has to
    // navigate to the site first.
    url: [''],
  });

  constructor() {
    this.refresh();
  }

  /**
   * Read the vault's names.
   * @return {void}
   */
  protected refresh(): void {
    this.loading.set(true);
    this.failure.set(null);
    this.sessions.vault({ op: 'profiles' }).subscribe({
      next: (reply) => {
        this.loading.set(false);
        this.upgradeRequired.set(false);
        this.entries.set(entriesFrom(reply));
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  /**
   * Capture the CURRENT browser's logged-in state under the form's names.
   *
   * This is the write path, and the only one the worker exposes: an entry is
   * built by logging in once and saving, not by typing a password here.
   * @return {void}
   */
  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { service, profile } = this.form.getRawValue();
    this.call('save_state', { op: 'save_state', service, profile });
  }

  /**
   * Replay the form's entry onto the current browser.
   * @return {void}
   */
  protected login(): void {
    const { service, profile, url } = this.form.getRawValue();
    if (!service || !profile || !url) {
      this.form.markAllAsTouched();
      this.failure.set('VAULT.NEEDS_URL');
      return;
    }
    this.call('login', { op: 'login', service, profile, url });
  }

  /**
   * Release the Chrome a login started.
   * @return {void}
   */
  protected closeLaunch(): void {
    const { service, profile } = this.form.getRawValue();
    if (!service || !profile) {
      this.form.markAllAsTouched();
      return;
    }
    this.call('close_launch', { op: 'close_launch', service, profile });
  }

  /**
   * Fill the form from a listed entry, so the next action needs no typing.
   * @param {VaultEntry} entry The entry to load.
   * @return {void}
   */
  protected use(entry: VaultEntry): void {
    this.form.patchValue({ service: entry.service, profile: entry.profile });
  }

  /**
   * One vault op, with the outcomes that differ: 402 is an upgrade, 403 is a
   * permanent refusal, a transport failure is a retry, everything else is a
   * message.
   * @param {string} op The vault op, for the spinner.
   * @param {Record<string, unknown>} body The worker arguments.
   * @return {void}
   */
  private call(op: string, body: Record<string, unknown>): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(op);
    this.failure.set(null);
    this.sessions.vault(body).subscribe({
      next: () => {
        this.busy.set(null);
        // `save_state` and `close_launch` change the list, `login` does not, but
        // re-reading is one cheap call and keeps the two in step.
        this.refresh();
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.fail(error);
      },
    });
  }

  /**
   * Record a failure. Three outcomes, because the remedy differs: a 402 is an
   * upgrade, a 403 is a permanent refusal with nothing to retry, and anything
   * else may be transient.
   * @param {unknown} error The failure.
   * @return {void}
   */
  private fail(error: unknown): void {
    this.loading.set(false);
    this.busy.set(null);
    if (error instanceof HttpErrorResponse && error.status === 402) {
      this.upgradeRequired.set(true);
      this.failure.set(null);
      return;
    }
    // 403 is this route's "your plan is not the problem" answer. The vault ops
    // need a worker dedicated to the caller, and no such worker exists yet
    // (`VAULT_TOOLS` / `needsCallerOwnWorker`), so the gateway refuses them
    // before one is leased. Both alternatives would mislead: "try again" is not
    // a remedy, and the upgrade prompt is worse, because a PAID caller receives
    // this same 403.
    if (error instanceof HttpErrorResponse && error.status === 403) {
      this.failure.set('VAULT.NO_PRIVATE_WORKER');
      return;
    }
    this.failure.set('VAULT.FAILED');
  }
}
