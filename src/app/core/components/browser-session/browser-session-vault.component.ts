import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { BrowserSessionService } from '../../services/browser-session.service';
import { VaultDurableEntry, VaultDurableReply } from '../../types/browser-session.interface';
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
 * The durable list out of the platform's reply.
 *
 * This one IS a contract we own (`handlers/vault.ts` writes the index row), so
 * it reads the two required names and drops a row missing either: an entry with
 * no `profile` cannot be addressed, so keeping it would render a row whose every
 * action fails.
 * @param {VaultDurableReply} reply The route's reply.
 * @return {VaultDurableEntry[]} Every addressable entry.
 */
const durableEntriesFrom = (reply: VaultDurableReply): VaultDurableEntry[] => {
  const rows = Array.isArray(reply?.entries) ? reply.entries : [];
  return rows
    .filter((row) => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      service: String(row.service ?? ''),
      profile: String(row.profile ?? ''),
      updatedAtMs:
        typeof row.updatedAtMs === 'number' ? row.updatedAtMs : undefined,
    }))
    .filter((entry) => entry.service.length > 0 && entry.profile.length > 0);
};

/**
 * The credential vault: build it, keep it, and log in from it.
 *
 * A section rather than a page, and it composes under the session panel because
 * the two are one flow: open a session, log in, then capture that login here.
 * A tab would hide that sequence behind a click.
 *
 * TWO stores, and the panel shows both because they lose different things. The
 * WORKER's vault is the one `profiles`/`save_state`/`login` address: it is a
 * directory on the machine running the browser, so a session machine stopping
 * takes it with it. The ACCOUNT's vault is the platform holding a sealed blob,
 * which is the only half that outlives the machine. Nothing here decides for the
 * caller which one they meant; the labels say what each one costs.
 *
 * The tier is the ROUTE's decision and this NEVER guesses it client-side: the
 * upgrade state appears only after a 402. The two routes do not even agree on a
 * tier -- the worker one is `paid` (its entries are process-global on a shared
 * worker, so a free caller would read credentials it does not own) and the
 * durable one is `access` -- so inferring either from a plan would be wrong
 * twice.
 *
 * The cookie pair is why there is a field for the caller's own browser. A
 * non-admin may run `cookies`/`setcookies` only while naming a browser of their
 * own (`isEndpointCookieCall`), so without it those two buttons are a 403 for
 * everyone but an admin; with it the jar can leave the machine that stops.
 * The four entry ops take no such endpoint and still need a worker of the
 * caller's own, so the two refusals are reported as the different problems they
 * are.
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
  /** The ACCOUNT's entries: the half that survives the machine stopping. */
  protected readonly durable = signal<VaultDurableEntry[]>([]);
  protected readonly loading = signal(false);
  /** The op in flight, so only its own button shows a spinner. */
  protected readonly busy = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  /** Set ONLY by a 402 from a route; never inferred from a plan. */
  protected readonly upgradeRequired = signal(false);
  protected readonly hasEntries = computed(() => this.entries().length > 0);
  protected readonly hasDurable = computed(() => this.durable().length > 0);

  protected readonly form = this.fb.nonNullable.group({
    service: ['', [Validators.required]],
    profile: ['', [Validators.required]],
    // Needed by `login` only: localStorage is origin-scoped, so a replay has to
    // navigate to the site first.
    url: [''],
    // The caller's OWN browser, for the cookie pair only. Optional, because an
    // admin runs those two ops against the platform's browser; required in
    // practice for anyone else, which is what the 403 message says.
    cdp_url: [''],
  });

  constructor() {
    this.refresh();
  }

  /**
   * Read both stores' names.
   *
   * Two calls rather than one because they are two routes with two tiers, and
   * each records its own failure. They are started together and neither waits on
   * the other: an account vault that is unconfigured must not stop the worker
   * list from rendering, and vice versa.
   * @return {void}
   */
  protected refresh(): void {
    this.readWorkerNames();
    this.readDurableNames();
  }

  /**
   * The worker's entries.
   * @return {void}
   */
  private readWorkerNames(): void {
    this.loading.set(true);
    this.failure.set(null);
    this.sessions.vault({ op: 'profiles' }).subscribe({
      next: (reply) => {
        this.loading.set(false);
        this.upgradeRequired.set(false);
        this.entries.set(entriesFrom(reply));
      },
      error: (error: unknown) => this.fail(error, 'profiles'),
    });
  }

  /**
   * The account's entries.
   *
   * A 503 here is a deployment with no vault key rather than a caller's mistake,
   * and it says so: answering "no entries" would read as "your saved logins are
   * gone", which is the one thing a storage outage must never look like.
   * @return {void}
   */
  private readDurableNames(): void {
    this.sessions.durableVault({ op: 'list' }).subscribe({
      next: (reply) => {
        this.upgradeRequired.set(false);
        this.durable.set(durableEntriesFrom(reply));
      },
      error: (error: unknown) => this.fail(error, 'list'),
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
   *
   * Takes the two names rather than either entry type, because both lists have
   * them and a caller should not have to know which one it clicked.
   * @param {{ service: string; profile: string }} entry The entry to load.
   * @return {void}
   */
  protected use(entry: { service: string; profile: string }): void {
    this.form.patchValue({ service: entry.service, profile: entry.profile });
  }

  /**
   * Read the jar out of the caller's browser and keep it under their account.
   *
   * The write that makes a login outlive the machine, and a COMPOSITION of two
   * routes: the worker reads its browser's cookies, and the platform stores what
   * it answered, opaquely. The platform is deliberately not allowed to fetch the
   * jar itself, because that would make it depend on the shape of a worker reply
   * this repo cannot verify -- so the jar passes through the caller and neither
   * side has to model the other.
   * @return {void}
   */
  protected keep(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { service, profile } = this.form.getRawValue();
    if (this.busy()) {
      return;
    }
    this.busy.set('keep');
    this.failure.set(null);

    this.sessions.vault(this.cookieBody('cookies')).subscribe({
      next: (reply) => {
        const payload = reply?.data;
        // A browser that never logged in has nothing to keep. Refused here
        // rather than sent, because the route would answer 400 and "the request
        // was malformed" is not what happened.
        if (payload === undefined || payload === null) {
          this.busy.set(null);
          this.failure.set('VAULT.NOTHING_TO_KEEP');
          return;
        }
        this.sessions
          .durableVault({ op: 'store', service, profile, payload })
          .subscribe({
            next: () => {
              this.busy.set(null);
              this.refresh();
            },
            error: (error: unknown) => {
              this.busy.set(null);
              this.fail(error, 'store');
            },
          });
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.fail(error, 'cookies');
      },
    });
  }

  /**
   * Put a kept jar back into the caller's browser.
   *
   * The other half of the same composition: the platform hands back what it
   * stored, and the worker writes it into the browser. `url` is required for the
   * same reason `login` requires it -- cookies belong to an origin, so the
   * browser has to be ON the site before they mean anything.
   * @return {void}
   */
  protected restore(): void {
    const { service, profile, url } = this.form.getRawValue();
    if (!service || !profile || !url) {
      this.form.markAllAsTouched();
      this.failure.set('VAULT.NEEDS_URL');
      return;
    }
    if (this.busy()) {
      return;
    }
    this.busy.set('restore');
    this.failure.set(null);

    this.sessions.durableVault({ op: 'load', service, profile }).subscribe({
      next: (reply) => {
        this.sessions
          .vault(this.cookieBody('setcookies', { cookies: reply?.payload }))
          .subscribe({
            next: () => {
              this.busy.set(null);
              this.refresh();
            },
            error: (error: unknown) => {
              this.busy.set(null);
              this.fail(error, 'setcookies');
            },
          });
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.fail(error, 'load');
      },
    });
  }

  /**
   * Forget one account entry: the sealed blob, then the index row.
   *
   * No confirmation prompt, and that is deliberate given what the two choices
   * are. The action is reversible in the only sense that matters here -- the
   * caller still has the browser, so they can keep it again -- whereas a dialog
   * would put a modal between a caller and the only way to get under the entry
   * cap.
   * @param {VaultDurableEntry} entry The entry to forget.
   * @return {void}
   */
  protected forget(entry: VaultDurableEntry): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(this.keyOf(entry));
    this.failure.set(null);
    this.sessions
      .durableVault({
        op: 'forget',
        service: entry.service,
        profile: entry.profile,
      })
      .subscribe({
        next: () => {
          this.busy.set(null);
          this.refresh();
        },
        error: (error: unknown) => {
          this.busy.set(null);
          this.fail(error, 'forget');
        },
      });
  }

  /**
   * A row's identity for the spinner, so only the row being forgotten spins.
   * @param {VaultDurableEntry} entry The row.
   * @return {string} `service:profile`.
   */
  protected keyOf(entry: VaultDurableEntry): string {
    return entry.service + ':' + entry.profile;
  }

  /**
   * The worker arguments for one of the cookie-pair ops.
   *
   * `cdp_url` is attached only for that pair, and only when the field is
   * non-empty. The other five ops ignore it, and the route refuses a supplied
   * but unusable address rather than dropping it -- so a blank field must be an
   * ABSENT field, or a caller with an empty input would be refused for naming a
   * browser they never named.
   * @param {'cookies' | 'setcookies'} op The cookie-pair op.
   * @param {Record<string, unknown>} extra Fields that op needs.
   * @return {Record<string, unknown>} The worker arguments.
   */
  private cookieBody(
    op: 'cookies' | 'setcookies',
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const endpoint = this.form.getRawValue().cdp_url.trim();
    return endpoint ? { op, ...extra, cdp_url: endpoint } : { op, ...extra };
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
        this.fail(error, op);
      },
    });
  }

  /**
   * Record a failure. The outcomes differ because the remedy differs.
   *
   * `op` is what separates the two 403s, which are the same status meaning two
   * different things: the cookie pair is refused until the caller names their own
   * browser, and everything else is refused until some caller has a worker of
   * their own. Reporting the second to someone who only forgot to fill one field
   * would send them to support for a one-word fix.
   * @param {unknown} error The failure.
   * @param {string} op The op that failed.
   * @return {void}
   */
  private fail(error: unknown, op: string): void {
    this.loading.set(false);
    this.busy.set(null);
    if (!(error instanceof HttpErrorResponse)) {
      this.failure.set('VAULT.FAILED');
      return;
    }
    if (error.status === 402) {
      this.upgradeRequired.set(true);
      this.failure.set(null);
      return;
    }
    if (error.status === 403) {
      const cookiePair = op === 'cookies' || op === 'setcookies';
      this.failure.set(
        cookiePair ? 'VAULT.NEEDS_OWN_BROWSER' : 'VAULT.NO_PRIVATE_WORKER'
      );
      return;
    }
    // A 503 is the deployment, a 404 is an entry that is gone, and a 409 is the
    // account's entry cap. Each has a different remedy -- none of which is
    // "try again" -- so none of them is the generic message.
    if (error.status === 503) {
      this.failure.set('VAULT.UNAVAILABLE');
      return;
    }
    if (error.status === 404) {
      this.failure.set('VAULT.GONE');
      return;
    }
    if (error.status === 409) {
      this.failure.set('VAULT.CAP');
      return;
    }
    this.failure.set('VAULT.FAILED');
  }
}
