
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { bounceAnim } from 'src/app/animations';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-loading-dots',
    imports: [],
    templateUrl: './loading-dots.component.html',
    styleUrl: './loading-dots.component.scss',
    animations: [
        bounceAnim
    ]
})
export class LoadingDotsComponent {
  flash = false;

  constructor() {
    // setInterval(() => {
    //   // This triggers the animation to restart
    //   this.flash = !this.flash;
    // }, 1000); // 3 cycles of 1.2s each
  }
}
