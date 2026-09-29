import { Component, ChangeDetectionStrategy } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

@Component({
  selector: 'app-landing-architecture',
  standalone: true,
  imports: [LucideAngularModule, TranslateModule, RevealDirective],
  templateUrl: './landing-architecture.component.html',
  styleUrl: './landing-architecture.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingArchitectureComponent {
  readonly icons = myIcons;

  /**
   * The capabilities every run inherits regardless of which engine executes it. Previously these
   * lived only inside prose ("browser pooling", "proxy rotation") and one untranslated chip, so the
   * runtime that actually differentiates the platform was effectively invisible on the landing page.
   */
  readonly runtimePrimitives = [
    { icon: 'network', key: 'ARCH.ENG_RT_1' },
    { icon: 'server', key: 'ARCH.ENG_RT_2' },
    { icon: 'shieldcheck', key: 'ARCH.ENG_RT_3' },
    { icon: 'globe', key: 'ARCH.ENG_RT_4' },
    { icon: 'key-round', key: 'ARCH.ENG_RT_5' },
    { icon: 'code', key: 'ARCH.ENG_RT_6' },
  ];
}
