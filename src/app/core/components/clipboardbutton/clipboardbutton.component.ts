import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, Input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { timer } from 'rxjs/internal/observable/timer';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-clipboard-button',
    imports: [MatIcon, NgClass, TranslateModule],
    templateUrl: './clipboardbutton.component.html',
    styleUrl: './clipboardbutton.component.scss'
})
export class ClipboardbuttonComponent {

  private destroyRef = inject(DestroyRef)
  protected readonly copyCodeKey = 'CLIPBOARD.COPY_CODE'
  protected readonly copiedKey = 'CLIPBOARD.COPIED'
  protected readonly title = signal(this.copyCodeKey)

  @Input() inline?: boolean = true;

  onClick() {
    this.title.set(this.copiedKey)

    timer(800)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              this.title.set(this.copyCodeKey)
            })
  }
}
