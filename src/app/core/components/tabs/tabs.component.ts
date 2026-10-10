import { AfterViewChecked, AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Inject, inject, Input, OnInit, Output, PLATFORM_ID, ViewChild } from '@angular/core';
import { LocalStorage, ScreenResizeService } from '../../services';
import { RippleDirective, TouchEventsDirective } from '../../directives';
import { isPlatformBrowser, NgClass } from '@angular/common';
import { Subscription } from 'rxjs';
import { SCREEN_SIZE } from '../../enum';
import { CrawlLinkTab, LinkTabs, ScrollDimensions } from '../../types';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { NavigationEnd, NavigationStart, Router, RouterLink } from '@angular/router';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';
@Component({
  selector: 'app-tabs',
  imports: [RippleDirective, NgClass, MatIcon, RouterLink, TouchEventsDirective, TranslateModule],
  templateUrl: './tabs.component.html',
  styleUrl: './tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppTabsComponent implements OnInit, AfterViewInit {

  @ViewChild('tabs', { read: ElementRef }) tabsSelector: ElementRef<HTMLElement>
  @ViewChild('tab', { read: ElementRef }) liSelector: ElementRef<HTMLElement>
  @ViewChild('bar', { read: ElementRef }) barSelector: ElementRef<HTMLElement>

  @ViewChild('tabsContainer', { read: ElementRef }) tabsContainer: ElementRef<HTMLElement>

  @Input('tabs') linkTabs: LinkTabs[] = []

  @Input() sourceTabUrl: string = ''
  @Output() tabChange = new EventEmitter<string>()

  protected leftPosition: string = '0'
  protected transformPosition: string
  private localStorage: Storage = inject(LocalStorage)

  private screenSub: Subscription
  private size!: SCREEN_SIZE


  showPreviousButton: boolean = false
  showNextButton: boolean = true

  tabSelectorWidth = 0

  transformX = '0px'

  private routerEventSubscription: Subscription

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private resizeSvc: ScreenResizeService,
    private cdr: ChangeDetectorRef,
    private router: Router

  ) {


  }


  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.

    // Subscribe to the Screen Resize event
    this.screenSub = this.resizeSvc.onResize$.subscribe((x: SCREEN_SIZE) => {

      this.size = x

      this.updatePositions()
      this.scrollTabs('previous')

    })

    this.routerEventSubscription = this.router.events.subscribe((event: any) => {
      if (event instanceof NavigationStart) {
        // this.isLoading = true;
      } else if (event instanceof NavigationEnd) {

        this.updatePositions()
        this.scrollTabs('previous')
      }
    })


    /* this.renderer.listen(this.elementRef.nativeElement, 'load', () => {
      this.calculateTabSelectorLeft()
    }); */

  }

  ngAfterViewInit(): void {
    //Called after ngAfterContentInit when the component's view has been initialized. Applies to components only.
    //Add 'implements AfterViewInit' to the class.
    // FIXME: This is a hack to get the position of the tab selector
    this.updatePositions()
    this.scrollTabs('previous')
  }

  setRoutes(link: string): string[] {
    if (link.length)
      return ['/', this.sourceTabUrl, link]

    return ['/', this.sourceTabUrl]

  }

  private updatePositions(translateX: number = 0): void {

    if (isPlatformBrowser(this.platformId))
      this.transformPosition = this.calculateTabSelectorTransform(translateX)

    this.checkScrollButtons()
    this.cdr.detectChanges()
  }

  protected onTabChange(_: MouseEvent, tab: CrawlLinkTab, index: number) {


    this.linkTabs.forEach(element => {
      if (element.index === tab)
        element.active = true
      else
        element.active = false
    })

    // FIXME: This is a hack to get the position of the tab selector
    this.updatePositions()
    this.scrollTabs('next')
    this.tabChange.emit(tab)
  }

  /* The `onTouchStart()`, `onTouchMove(deltaX: number, deltaY: number)`, and `onTouchEnd()` functions
  are related to handling touch events on a touch-enabled device. Here is a brief explanation of
  each function: */


  onSwipeLeft(event: ScrollDimensions) {
    // Handle swipe left

    const { deltaX } = event
    const clientWidth = this.tabsSelector?.nativeElement.clientWidth
    const containerWidth = this.tabsContainer?.nativeElement.clientWidth
    const tabsWidth = Math.abs(containerWidth - clientWidth)
    const translateX = this.getTranslateX()
    const translateXPercentage = this.getTranslateXPercentage(translateX)
    const diff = tabsWidth - Math.abs(deltaX)

    let newTranslateX: number = 0

    // console.log('Swipe left', translateXPercentage)
    // left - next
    if (diff > 0 && Math.abs(translateX) < tabsWidth && translateXPercentage < 100) {

      // Calculate the new X position
      newTranslateX = translateX - Math.abs(deltaX)

      if (Math.abs(newTranslateX) > tabsWidth) {
        // Adjust the newX the maximum value to stay within the container width
        newTranslateX = -tabsWidth
      }
      this.transformX = newTranslateX + 'px'
      this.updatePositions(newTranslateX)
    } else if (translateXPercentage >= 100) {
      // Calculate the last X position to not exceed the tab container width
      if (diff < 0)
        this.transformX = -tabsWidth + 'px'
    }

  }

  onSwipeRight(event: ScrollDimensions) {
    // Handle swipe right

    const { deltaX } = event
    // container and client Width
    const clientWidth = this.tabsSelector?.nativeElement.clientWidth
    const containerWidth = this.tabsContainer?.nativeElement.clientWidth
    const tabsWidth = Math.abs(containerWidth - clientWidth)
    const translateX = this.getTranslateX()
    const translateXPercentage = this.getTranslateXPercentage(translateX)
    const diff = tabsWidth - Math.abs(deltaX)

    let newTranslateX: number = 0

    // console.log('Swipe Right', translateXPercentage)
    // right - previous
    if (diff > 0 && translateX < 0 && translateXPercentage > -0) {
      // Calculate the new X position
      newTranslateX = translateX + Math.abs(deltaX)
      const newDiff = tabsWidth - Math.abs(newTranslateX)

      // if (diff < tabsWidth) {
      //   // Adjust the newX value to stay within the container width
      //   newTranslateX = 0
      // }
      this.transformX = newTranslateX + 'px'
      // console.log('newTranslateX', newTranslateX, 'newDiff: ', newDiff, 'oldDiff:', diff, 'tabsWidth', tabsWidth, diff > tabsWidth)
      this.updatePositions(newTranslateX)
    } else {

      if (translateX !== 0)
        this.transformX = 0 + 'px'

      // this.updatePositions()

    }
  }

  scrollTabs(direction: string): void {
    const clientWidth = this.tabsSelector?.nativeElement.clientWidth
    const containerWidth = this.tabsContainer?.nativeElement.clientWidth
    const liRectWidth = this.liSelector.nativeElement.getBoundingClientRect()?.width
    const translateX = this.getTranslateX()
    const translateXPercentage = this.getTranslateXPercentage(translateX)
    let newX: number = 0

    if (direction === 'previous' && translateXPercentage > -0) {
      // Calculate the new X position
      newX = translateX + liRectWidth

      if (Math.abs(newX) < liRectWidth) {
        // Adjust the newX value to stay within the container width
        newX = translateX + Math.abs(newX) + liRectWidth
      }
      this.transformX = `${newX}px`
      this.updatePositions(newX)

    } else if (direction === 'next' && translateXPercentage < 100) {

      // Calculate the new X position
      newX = translateX - liRectWidth
      const diff = Math.abs(containerWidth - clientWidth) - Math.abs(newX)


      if (diff < liRectWidth) {
        // Adjust the newX value to stay within the container width
        newX = translateX - diff - liRectWidth
      }

      this.transformX = `${newX}px`
      this.updatePositions(newX)
    }
  }

  checkScrollButtons(): void {

    const translateX = this.getTranslateX()
    const translateXPercentage = this.getTranslateXPercentage(translateX)

    this.showPreviousButton = translateXPercentage > -0
    this.showNextButton = translateXPercentage >= -0 && translateXPercentage < 100
  }

  getTranslateX(): number {
    const translateX = this.transformX
    return parseFloat(translateX.replace('px', ''))
  }

  getTranslateXPercentage(translateX: number): number {
    // const scrollWidth = this.liSelector?.nativeElement.scrollWidth;
    const clientWidth = this.tabsSelector?.nativeElement.clientWidth;
    // const scrollLeft = this.tabsSelector?.nativeElement.scrollLeft;
    const containerWidth = this.tabsContainer?.nativeElement.clientWidth;

    // console.log('translateX', translateX, 'clientWidth: ', clientWidth, 'containerWidth: ', containerWidth)
    const translateXPercentage = translateX / (containerWidth - clientWidth) * 100

    return translateXPercentage
  }

  // updateTabSelectorPosition(index: number): void {
  //   if (this.linkTabs) {
  //     let tabs: HTMLCollection = this.tabsSelector.nativeElement.children
  //     let leftPosition = 0;
  //     let d: HTMLElement

  //     for (let i = 0; i < index; i++) {
  //       d = tabs[i] as HTMLElement

  //       leftPosition += d.offsetWidth;
  //     }
  //     this.leftScrollPosition = leftPosition;
  //   }
  // }



  calculateTabSelectorLeft(translateX: number = 0): string {

    if (!this.tabsSelector || !this.liSelector || !this.barSelector) return '0'
    // const clientWidth = this.tabsSelector?.nativeElement.clientWidth
    // const containerWidth = this.tabsContainer?.nativeElement.clientWidth
    const parentElement = this.tabsSelector.nativeElement.parentElement
    const parentRectWidth = parentElement!.getBoundingClientRect()
    const liRectWidth = this.liSelector.nativeElement.getBoundingClientRect()?.width
    const barWidth = this.barSelector.nativeElement.getBoundingClientRect()?.width

    const tabWidth = parentRectWidth.width

    // console.log('tabWidth', tabWidth, 'liRectWidth', liRectWidth, 'barWidth', barWidth, 'containerWidth', containerWidth, 'clientWidth', clientWidth)

    return this.calculateLeftMargin(tabWidth, liRectWidth, this.linkTabs.length, barWidth, this.linkTabs.findIndex(x => x.active) + 1, translateX)
  }

  /**
 * Calculates the left margin of the absolute div to position it under the middle li.
 * 
 * @param ulWidth The width of the ul element.
 * @param liWidth The width of each li element.
 * @param numLi The number of li elements.
 * @param absoluteDivWidth The width of the absolute div.
 * @returns The left margin of the absolute div.
 */
  private calculateLeftMargin(ulWidth: number, liWidth: number, numLi: number, absoluteDivWidth: number, tabi: number, translateX: number = 0): string {

    // const ulDifference = ulWidth - numLi * liWidth

    const middleLiLeftMargin = /* ulDifference / 2 + */absoluteDivWidth / 2

    const left = liWidth * (tabi - 1) + middleLiLeftMargin - 6 // - 3

    // console.log('translateX: ' + left, 'liWidth: ' + liWidth, 'middleLiLeftMargin: ' + middleLiLeftMargin, 'ulDifference: ' + ulDifference, 'tabi: ' + tabi)

    return translateX + left + 'px'
  }

  calculateTabSelectorTransform(translateX: number = 0): string {
    return `translateX(${this.calculateTabSelectorLeft(translateX)})`
  }

  themeIsDark() {
    return this.localStorage?.getItem(themeStorageKey) === 'true'
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.screenSub?.unsubscribe()
    this.routerEventSubscription?.unsubscribe()
  }

}
