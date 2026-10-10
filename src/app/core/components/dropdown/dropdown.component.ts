import { animate, style, transition, trigger } from '@angular/animations';
import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, inject, Input, Output, ViewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LocalStorage } from '../../services';
import { Outsideclick } from '../../directives';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';

@Component({
  selector: 'app-dropdown',
  imports: [NgClass, MatIcon, ReactiveFormsModule, Outsideclick, TranslateModule],
  templateUrl: './dropdown.component.html',
  styleUrl: './dropdown.component.scss',
  animations: [
    trigger('dropdownMenuAnimation', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }),
        animate('180ms cubic-bezier(0.2, 0, 0, 1)', style({ opacity: 1, transform: 'translateY(0) scale(1)' })),
      ]),
      transition(':leave', [
        animate('140ms cubic-bezier(0.4, 0, 1, 1)', style({ opacity: 0, transform: 'translateY(-4px) scale(0.98)' })),
      ]),
    ]),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownComponent {

  private localStorage = inject(LocalStorage)
  private translate = inject(TranslateService)
  private cdr = inject(ChangeDetectorRef)

  // display label: raw text passes through, i18n key paths resolve (ponytail: keyboard search matches what the user sees)
  private display(option?: { name: string; code: string }): string {
    return option ? (this.translate.instant(option.name) as string) : ''
  }

  @Input() control: FormControl<{ name: string, code: string }>
  @Input() options: { name: string, code: string }[]
  @Input() position: 'bottom' | 'top' = 'bottom'
  @Input() dropDownName?: string = 'Region'
  @Input() padding?: string
  @Input() lightColor?: string = 'blue'
  @Input() enableMenuAnimation: boolean = false
  @Output() select: EventEmitter<any> = new EventEmitter()
  @ViewChild('dropDown') dropDown: ElementRef
  @ViewChild('menu') menu: ElementRef
  isOpen: boolean = false;
  isFocus: boolean = false
  searchInput: string = ''

  constructor() { }

  @HostListener('keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this.isOpen) {
      switch (event.key) {
        case 'ArrowUp':
          const prevOption = this.options.find(option => option.name === this.controlValue.name);
          const prevIndex = this.options.findIndex(option => option === prevOption);
          const currentIndex = this.options.findIndex(option => option === this.controlValue);
          this.resetStyleOfCurrenElement(currentIndex)
          if (currentIndex > 0 && (!this.searchInput || this.display(prevOption).toLowerCase().includes(this.searchInput.toLowerCase()))) {
            const previousOptionIndex = currentIndex > 0 ? currentIndex - 1 : undefined;
            if (previousOptionIndex !== undefined) {
              this.control.setValue(this.options[previousOptionIndex]);
              this.scrollToOption(previousOptionIndex)
            }
          }
          break;
        case 'ArrowDown':
          const nextOption = this.options.find(option => option.name === this.controlValue.name);
          const nextIndex = this.options.findIndex(option => option === nextOption);
          const lastIndex = this.options.length - 1;
          const currentIndex2 = this.options.findIndex(option => option === this.controlValue)
          this.resetStyleOfCurrenElement(currentIndex2)


          if (currentIndex2 < lastIndex && (!this.searchInput || this.display(nextOption).toLowerCase().includes(this.searchInput.toLowerCase()))) {
            const nextOptionIndex = currentIndex2 < lastIndex ? currentIndex2 + 1 : undefined;
            if (nextOptionIndex !== undefined) {
              this.control.setValue(this.options[nextOptionIndex])
              this.scrollToOption(nextOptionIndex)
            }
          }
          break;
        case 'Enter':
          if (this.control.hasError('required')) {
            if (this.controlValue) {
              this.select.emit(this.controlValue);
              this.isOpen = false;
            } else {
              const closestValue = this.options.find(option => this.display(option).toLowerCase().includes(this.searchInput.toLowerCase()));
              this.closeDropDown();
              setTimeout(() => {
                this.control.setValue(closestValue ?? this.options[0]);
                this.select.emit(this.control.value);
                this.isOpen = false;
                // OnPush: deferred past the keydown's own check.
                this.cdr.markForCheck();
              }, 100);
            }
          } else if (this.control.dirty) {
            this.select.emit(this.controlValue);
            this.isOpen = false;
          }
          break;
        case 'Shift':
          break;
        case 'Escape':
          this.closeDropDown();
          break;
        default:
          const matchingOptions = this.options.filter(option => this.display(option).toLowerCase().startsWith(event.key.toLowerCase()));
          if (matchingOptions.length > 0) {
            const currentIndex = this.options.indexOf(this.controlValue)
            this.resetStyleOfCurrenElement(currentIndex)

            const nextMatchIndex = matchingOptions.findIndex(option => this.options.indexOf(option) > currentIndex);
            const matchingIndex = nextMatchIndex !== -1 ? this.options.indexOf(matchingOptions[nextMatchIndex]) : this.options.indexOf(matchingOptions[0]);
            this.control.setValue(this.options[matchingIndex]);
            this.scrollToOption(matchingIndex)
          }
          break;
      }


    }
  }
  private scrollToOption(index: number) {
    const optionElement = this.menu.nativeElement.querySelector(`[id="country${index}"]`) as HTMLElement;

    if (optionElement) {
      optionElement.scrollIntoView({ behavior: 'smooth', block: 'start' })

      if (this.localStorage?.getItem(themeStorageKey) === 'true') {
        optionElement.style.backgroundColor = '#90caf9 ';
        optionElement.style.color = '#2a2e35';
      } else {

        optionElement.style.backgroundColor = '#274983FF';
        optionElement.style.color = '#FFF';
      }

    }
  }

  private resetStyleOfCurrenElement(index: number) {
    const optionElement = this.menu.nativeElement.querySelector(`[id="country${index}"]`) as HTMLElement;

    if (optionElement) {

      if (this.localStorage?.getItem(themeStorageKey) === 'true') {
        optionElement.style.backgroundColor = '#2a2e35';
        optionElement.style.color = '#fff';
        optionElement.removeAttribute('style');
      } else {
        optionElement.style.backgroundColor = '#ffffff00';
        optionElement.style.color = '#2a2e35';
      }

      // optionElement.style.backgroundColor = 'inherit';
    }

  }

  protected get controlValue() {
    return this.control.value
  }
  onToggle() {
    this.isOpen = !this.isOpen;
    this.control.markAsUntouched()
  }
  closeDropDown() {

    this.dropDown.nativeElement.blur()
    if (this.isOpen)
      this.isOpen = !this.isOpen;

  }

  onOptionSelected(option: any) {
    this.control.setValue(option)
    this.control.markAsDirty()
    this.select.emit(option);
    this.isOpen = !this.isOpen;
    this.doFocus()
    this.focus()
  }

  focus() {
    this.dropDown.nativeElement.focus()
  }

  doFocus() {
    this.isFocus = true
  }

  doBlur() {


    if (this.isOpen) this.focus(), this.doFocus()
    else this.dropDown.nativeElement.blur(), this.isFocus = false
  }


  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
  }

}
