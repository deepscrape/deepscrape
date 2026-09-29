import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { ForbiddenValidatorDirective } from '../../directives';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-ginput',
    imports: [NgClass, ForbiddenValidatorDirective, ReactiveFormsModule, TranslateModule],
    providers: [],
    templateUrl: './ginput.component.html',
    styleUrl: './ginput.component.scss'
})
export class GinputComponent {
  // The Form Controller of Market URL Input  

  URLPlaceholder: string

  protected isProcessing = false

  @Input() control: FormControl<any>
  @Input() bgColor?: string = `bg-gray-50 dark:bg-gray-700`

  @Input() label?: string = 'URL'

  constructor() { }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.URLPlaceholder = " "
  }
  // do Focus and fill the Placeholder
  doFocus() {

    // this.validation.emit({ invalid: this.control.invalid, value: this.control.value })
    this.URLPlaceholder = 'Set a URL string..'
  }

  // do Blur and clear Placeholder
  doBlur() {

    this.URLPlaceholder = " "
  }



  doValidation() {
  }
}
