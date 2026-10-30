import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MachineFleetService } from 'src/app/core/services/machine-fleet.service';
import { FleetMachine } from 'src/app/core/types/machine-fleet.interface';

/**
 * One machine, platform side. `admin/machines/:machineId`.
 *
 * Reads the same fleet list the admin table reads and picks the row, rather than
 * asking arachnefly for live state. That is not a shortcut: `MachineOwnershipMiddleware`
 * admits only the machine's OWNER and has no admin bypass — deliberately, and
 * documented in `machine-fleet.ts` — so an operator cannot read a tenant's live Fly
 * object without a policy change. What is rendered here is exactly what the fleet
 * projection carries, and nothing else.
 *
 * It also means there is no Runtime card: `webrain_stats` runs on the caller's own
 * leased machine, and an admin is not a lessee.
 */
@Component({
  selector: 'app-admin-machine-detail',
  imports: [DatePipe, MatIconModule, MatProgressSpinnerModule, RouterLink, TranslateModule],
  templateUrl: './admin-machine-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminMachineDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fleet = inject(MachineFleetService);

  readonly machineId = signal('');
  readonly machine = signal<FleetMachine | null>(null);
  readonly loading = signal(true);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('machineId') ?? '';
      this.machineId.set(id);
      this.load(id);
    });
  }

  private load(id: string): void {
    this.loading.set(true);
    this.fleet
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          this.machine.set((reply.machines ?? []).find((row) => row.id === id) ?? null);
          this.loading.set(false);
        },
        // A failed list leaves `machine` null, which the template renders as "not in
        // the fleet" — the same answer a destroyed machine gives, and both are true.
        error: () => this.loading.set(false),
      });
  }
}
