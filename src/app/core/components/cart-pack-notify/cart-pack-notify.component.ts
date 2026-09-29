import { ChangeDetectionStrategy, Component, EventEmitter, inject, Output } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { ToggleBtnService } from '../../services';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-cart-pack-notify',
    imports: [MatIcon, TranslateModule],
    templateUrl: './cart-pack-notify.component.html',
    styleUrl: './cart-pack-notify.component.scss'
})
export class CartPackNotifyComponent {

  private btnService = inject(ToggleBtnService)

  protected toggleCartDropdown() {

    this.btnService.toggleMenu()
  }
}
