import { ChangeDetectionStrategy, Component, HostBinding, inject } from '@angular/core';
import { AiAPIService, CrawlAPIService, LocalStorage } from 'src/app/core/services';

@Component({
    selector: 'app-dashboard',
    imports: [],
    templateUrl: './dashboard.component.html',
    styleUrl: './dashboard.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
  })
  export class DashboardComponent {
  @HostBinding('class') classes = 'grow';
  private localStorage: Storage
  constructor(private crawlservice: CrawlAPIService) {

    this.localStorage = inject(LocalStorage)
  }


  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.

  }
  // Handle consent decision

  fetchData() {
  }
}
