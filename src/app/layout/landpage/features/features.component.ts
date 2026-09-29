
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { WithGradientBorderComponent } from 'src/app/core/components/with-gradient-border/with-gradient-border.component';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

@Component({
  selector: 'app-features',
  imports: [LucideAngularModule, WithGradientBorderComponent, TranslateModule, RevealDirective],
  templateUrl: './features.component.html',
  styleUrl: './features.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeaturesComponent {

  readonly icons = myIcons
  coreFeatures = [
    {
      icon: myIcons['bot'],
      title: "FEATURES.CORE_1_T",
      description: "FEATURES.CORE_1_D"
    },
    {
      icon: myIcons['gauge'],
      title: "FEATURES.CORE_2_T",
      description: "FEATURES.CORE_2_D"
    },
    {
      icon: myIcons['shield'],
      title: "FEATURES.CORE_3_T",
      description: "FEATURES.CORE_3_D"
    },
    {
      icon: myIcons['database'],
      title: "FEATURES.CORE_4_T",
      description: "FEATURES.CORE_4_D"
    },
    {
      icon: myIcons['code'],
      title: "FEATURES.CORE_5_T",
      description: "FEATURES.CORE_5_D"
    },
    {
      icon: myIcons['network'],
      title: "FEATURES.CORE_6_T",
      description: "FEATURES.CORE_6_D"
    }
  ];

  advancedFeatures = [
    {
      icon: myIcons['brain'],
      title: "FEATURES.ADV_1_T",
      description: "FEATURES.ADV_1_D"
    },
    {
      icon: myIcons['globe'],
      title: "FEATURES.ADV_2_T",
      description: "FEATURES.ADV_2_D"
    },
    {
      icon: myIcons['filetext'],
      title: "FEATURES.ADV_3_T",
      description: "FEATURES.ADV_3_D"
    },
    {
      icon: myIcons['search'],
      title: "FEATURES.ADV_4_T",
      description: "FEATURES.ADV_4_D"
    },
    {
      icon: myIcons['monitor'],
      title: "FEATURES.ADV_5_T",
      description: "FEATURES.ADV_5_D"
    },
    {
      icon: myIcons['zap'],
      title: "FEATURES.ADV_6_T",
      description: "FEATURES.ADV_6_D"
    }
  ];
}
