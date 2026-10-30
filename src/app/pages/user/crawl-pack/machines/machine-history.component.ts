import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { timeout } from 'rxjs';
import { DeploymentService } from 'src/app/core/services';
import { MachineHistoryEntry } from 'src/app/core/types/machine-fleet.interface';

/**
 * The machines this caller has DESTROYED.
 *
 * `machines_history` is written by arachnefly at destruction time and, until this
 * page, was read by nothing: a machine vanished from the console and the record
 * of what had existed was unreachable. Read-only on purpose -- the machine is gone
 * from Fly, so there is nothing to start, stop or destroy.
 *
 * The server scopes the read to the caller's uid from the record's `id` FIELD (the
 * document key is the machine id), so this page cannot widen it.
 */
@Component({
  selector: 'app-machine-history',
  standalone: true,
  imports: [RouterLink, TranslateModule],
  templateUrl: './machine-history.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineHistoryComponent implements OnInit {
  private readonly deploy = inject(DeploymentService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly rows = signal<MachineHistoryEntry[]>([]);
  protected readonly query = signal('');
  protected readonly busy = signal(true);
  protected readonly failed = signal(false);

  /**
   * The rows matching the filter, over name, id and region.
   *
   * Filtered here rather than on the server: the read is already capped, so a
   * query parameter would add a filter round-trip and a composite index for a set
   * that fits on one page.
   */
  protected readonly filtered = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) {
      return this.rows();
    }
    return this.rows().filter((row) =>
      `${row.name} ${row.id} ${row.region}`.toLowerCase().includes(needle),
    );
  });

  ngOnInit(): void {
    this.deploy
      .history()
      // A request that never answers must not leave the archive spinning, which
      // reads the same as "nothing was ever destroyed".
      .pipe(timeout(8000), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          this.rows.set(reply?.machines ?? []);
          this.busy.set(false);
        },
        error: () => {
          this.failed.set(true);
          this.busy.set(false);
        },
      });
  }

  /**
   * Update the filter from the input.
   * @param {Event} event The input event.
   * @return {void} Nothing.
   */
  protected onFilter(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.query.set(target?.value ?? '');
  }

  /**
   * Enough of an id to recognise a row, with the whole value on hover.
   * @param {string} id The machine id.
   * @return {string} The id, shortened when it is long.
   */
  protected shortId(id: string): string {
    return id.length > 14 ? `${id.slice(0, 12)}…` : id;
  }
}
