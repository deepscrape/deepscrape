import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-extract-strategy',
    imports: [],
    templateUrl: './extract-strategy.component.html',
    styleUrl: './extract-strategy.component.scss'
})
export class ExtractStrategyComponent {

}
