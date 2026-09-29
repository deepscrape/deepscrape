import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-animated-bg',
  templateUrl: './animated-bg.component.html',
  styleUrls: ['./animated-bg.component.scss']
})
export class AnimatedBgComponent {}
