import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { animate, state, style, transition, trigger } from '@angular/animations';
import { MatIcon } from '@angular/material/icon';
import { NgClass } from '@angular/common'; // Added NgFor for iterating over icons
import { TranslateModule } from '@ngx-translate/core';
import { WindowToken } from '../../services';
import { RippleDirective } from '../../directives';
import { Subscription } from 'rxjs/internal/Subscription';
import { timer } from 'rxjs/internal/observable/timer';

export enum SnackBarType {
  success = 'success',
  error = 'error',
  warning = 'warning',
  info = 'info'
}

export enum SnackBarPosition {
  TopLeft = 'top-left',
  TopRight = 'top-right',
  TopCenter = 'top-center',
  BottomLeft = 'bottom-left',
  BottomRight = 'bottom-right',
  BottomCenter = 'bottom-center'
}

@Component({
  selector: 'app-snackbar',
  imports: [NgClass, MatIcon, RippleDirective, TranslateModule],
  templateUrl: './snackbar.component.html',
  styleUrl: './snackbar.component.scss',
  animations: [
    trigger('snackbarState', [
      state('void', style({
        transform: 'translateY(100%)',
        opacity: 0
      })),
      state('visible', style({
        transform: 'translateY(0)',
        opacity: 1
      })),
      transition('void => visible', animate('300ms ease-out')),
      transition('visible => void', animate('200ms ease-in'))
    ])
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnackbarComponent {
  @Input() message: string = ''
  @Input() action: string = ''
  @Input() type: SnackBarType = SnackBarType.info
  @Input() duration: number = 3000
  @Input() leftIcon: string = 'warning' // New input for a left icon
  @Input() rightIcon: string = '' // New input for a single right icon
  @Input() position: SnackBarPosition = SnackBarPosition.BottomCenter // New input for positioning
  @Input() closeIcon: string = 'close' // New input for custom close icon
  @Output() close = new EventEmitter<void>();
  @Output() actionClick = new EventEmitter<void>()
  @Output() leftIconClick = new EventEmitter<void>() // New output for left icon clicks

  private window = inject(WindowToken)
  visible: boolean = false
  snackbarState: 'visible' | 'void' = 'void';
  private hideTimeout: any;
  constructor(private cdr: ChangeDetectorRef) { }
  private hideTimerSub?: Subscription;

  show(message: string, type: SnackBarType, action: string | '', duration?: number) {
    this.message = message;
    this.type = type;
    this.action = action;
    this.visible = true;

    // Use requestAnimationFrame for better performance
    this.window.requestAnimationFrame(() => {
      this.snackbarState = 'visible'
      this.cdr.markForCheck()
    });

    if (this.duration > 0) {
      // Unsubscribe from any existing timer to prevent memory leaks
      this.hideTimerSub?.unsubscribe()
      this.hideTimerSub = timer(duration || this.duration).subscribe(() => this.hide())
    }
  }
  hide() {
    this.visible = false;
    this.snackbarState = 'void';
    this.close.emit();
  }

  onActionClick() {
    this.actionClick.emit()
    this.hide()
  }

  onLeftIconClick() {
    this.leftIconClick.emit();
  }


  get snackbarTypeClass(): string {
    switch (this.type) {
      case 'success':
        return 'border-green-400 text-green-400';
      case 'error':
        return 'border-red-500 text-red-500';
      case 'warning':
        return 'border-yellow-500 text-yellow-500';
      case 'info':
        return 'border-blue-400 text-blue-400';
      default:
        return 'border-blue-400 text-blue-400';
    }
  }



  snackBarTypeClassIcon() {
    const info = 'text-blue-200 group-hover:text-blue-300 dark:text-blue-400/30  dark:group-hover:text-blue-400'
    switch (this.type) {
      case 'success':
        return 'text-green-200 group-hover:text-green-300 dark:text-green-400/30  dark:group-hover:text-green-400';
      case 'error':
        return 'text-red-200 group-hover:text-red-300 dark:text-red-400/30  dark:group-hover:text-red-400';
      case 'warning':
        return 'text-yellow-200 group-hover:text-yellow-300 dark:text-yellow-400/30  dark:group-hover:text-yellow-400';
      case 'info':
        return info;
      default:
        return info;
    }
  }

  getSnackbarPositionClass() {
    const baseClasses = 'fixed z-50 mx-4 w-fit min-w-[250px] max-w-[90%] transform';
    const commonCenterClasses = 'inset-x-0 -translate-x-1/2';

    switch (this.position) {
      case SnackBarPosition.TopLeft:
        return `${baseClasses} top-8 left-0`;
      case SnackBarPosition.TopRight:
        return `${baseClasses} top-8 right-0`;
      case SnackBarPosition.TopCenter:
        return `${baseClasses} top-8 ${commonCenterClasses}`;
      case SnackBarPosition.BottomLeft:
        return `${baseClasses} bottom-8 left-0`;
      case SnackBarPosition.BottomRight:
        return `${baseClasses} bottom-8 right-0`;
      case SnackBarPosition.BottomCenter:
      default:
        return `${baseClasses} bottom-8 ${commonCenterClasses}`;
    }
  }

  ngOnDestroy() {
    // Clean up timeout to prevent memory leaks

    this.hideTimerSub?.unsubscribe()
  }
}
