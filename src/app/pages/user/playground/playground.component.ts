import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostBinding, inject, OnInit, ViewChild, ElementRef, AfterViewInit, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule, NgClass } from '@angular/common';
import { AppCrawlComponent, AppLLMScrapeComponent, DomainSeederComponent } from 'src/app/core/components';
import { fadeinCartItems, smoothfadeAnimation } from 'src/app/animations';
import { HiddenDragScrollDirective } from 'src/app/core/directives';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs';

@Component({
  selector: 'app-playground',
  imports: [AppLLMScrapeComponent, AppCrawlComponent, CommonModule, RouterModule, NgClass, DomainSeederComponent, HiddenDragScrollDirective],
  templateUrl: './playground.component.html',
  styleUrl: './playground.component.scss',
  animations: [
    fadeinCartItems,
    smoothfadeAnimation
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundComponent implements OnInit, AfterViewInit {
  @HostBinding('class') classes = 'grow';
  @ViewChild('modeScrollContainer') modeScrollContainer!: ElementRef;
  
  currentMode: 'llm-scrape' | 'crawl' | 'seeder' = 'llm-scrape'; // Default mode
  private destroyRef = inject(DestroyRef);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {
  }
  ngOnInit(): void {
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const newMode = params['mode'];
      // Only update if the mode actually changed to trigger animation
      if (this.currentMode !== newMode) {
        switch (newMode) {
          case 'llm-scrape':
          case 'crawl':
          case 'seeder':
            this.currentMode = newMode;
            break;
          default:
            this.currentMode = 'llm-scrape';
        }
        // OnPush: the query-param write is async, so the view needs telling.
        this.cdr.markForCheck()
      }
    });
  }

  ngAfterViewInit(): void {
    // Check for mobile device after view init
    timer(0)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Set initial scroll position to make the selected mode visible if needed
        this.scrollToActiveMode();
      });
  }

  // Scroll to make the active mode button visible
  private scrollToActiveMode(): void {
    if (!this.modeScrollContainer) return;
    
    const container = this.modeScrollContainer.nativeElement;
    const activeButton = container.querySelector('button.shadow-md'); // Using the shadow class to find active button
    
    if (activeButton) {
      // Calculate position to center the active button
      const containerWidth = container.clientWidth;
      const buttonLeft = activeButton.offsetLeft;
      const buttonWidth = activeButton.clientWidth;
      
      // Center the button in the container
      container.scrollLeft = buttonLeft - (containerWidth / 2) + (buttonWidth / 2);
    }
  }

  // Handle scroll events
  onModeScroll(event: Event): void {
    // Handle any scroll-related logic here if needed
  }
  changeMode(mode:string): void {
    if (this.currentMode === mode) return; // Don't navigate if already on this mode
    
    // Navigate and update query params
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { mode: mode },
      queryParamsHandling: 'merge'
    });
  }
}
