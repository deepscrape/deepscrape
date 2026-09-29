import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { AbstractControl, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-radio-button',
  imports: [ReactiveFormsModule],
  templateUrl: './radio-button.component.html',
  styleUrl: './radio-button.component.scss'
})
export class RadioButtonComponent {
  @Input() control: FormControl<string>

  @Input() value: string
  @Input() title?: string

  constructor() { }


  setTitle(): string {

    if (!this.title)
      return 'set a Title'

    const format: string[] | undefined = this.title?.split('/')

    return this.title

  }


}
