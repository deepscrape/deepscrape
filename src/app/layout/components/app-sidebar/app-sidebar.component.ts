import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppSidebarNavComponent } from '../app-sidebar-nav/app-sidebar-nav.component';
import { LoadingService } from 'src/app/core/services';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { asideBarAnimation } from 'src/app/animations';
import { Outsideclick } from 'src/app/core/directives/outsideclick.directive';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-sidebar',
    imports: [NgClass, AppSidebarNavComponent, MatProgressSpinner, Outsideclick],
    templateUrl: './app-sidebar.component.html',
    styleUrl: './app-sidebar.component.scss',
    animations: [
        asideBarAnimation
    ]
})
export class AppSidebarComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);

  @Input() barClosed: boolean
  @Input() resizeScreen: boolean

  @Output() backDropPressed: EventEmitter<boolean> = new EventEmitter<boolean>()
  isLoading = signal(false);

  constructor(private loadingService: LoadingService) {

    this.barClosed = false
  }

  ngOnInit(): void {
    this.loadingService.loadingSubject$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((isLoading) => {
        this.isLoading.set(isLoading);
      });
  }

  onSidebarClose(event: boolean): void {
    // like a backDrop click
    this.backDropPressed.emit(true)
  }
  backDropClicked($event: MouseEvent) {
    const element = $event.target as HTMLElement

    if (element.id === "asidebarblur") {
      this.backDropPressed.emit(true)
    }
  }
}
