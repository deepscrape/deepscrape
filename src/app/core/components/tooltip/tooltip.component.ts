import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { NgClass } from '@angular/common';
import { TooltipPosition, TooltipTheme } from '../../enum';
import { AnimationEvent } from '@angular/animations';
import { animate, state, style, transition, trigger } from '@angular/animations';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'tooltip',
  imports: [NgClass],
  templateUrl: './tooltip.component.html',
  styleUrl: './tooltip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('tooltipAnimation', [      state('visible', style({
        opacity: 1
      })),
      state('hidden', style({
        opacity: 0
      })),
      transition('hidden => visible', [
        animate('150ms cubic-bezier(0, 0, 0.2, 1)')
      ]),
      transition('visible => hidden', [
        animate('75ms cubic-bezier(0.4, 0, 1, 1)')
      ])
    ])
  ]
})
export class TooltipComponent implements OnInit, OnDestroy {
  tooltip: string = '';
  left: number = 0;
  top: number = 0;
  position: string = TooltipPosition.DEFAULT;
  theme: string = TooltipTheme.DEFAULT;
  visible: boolean = false;
  animationState: 'visible' | 'hidden' = 'hidden';
  
  private destroy$ = new Subject<void>();

  constructor(private cdr: ChangeDetectorRef) { }

  ngOnInit(): void { }
  
  setVisibility(visible: boolean): void {
    this.visible = visible;
    this.animationState = visible ? 'visible' : 'hidden';
    this.cdr.markForCheck();
  }

  afterHide(event: AnimationEvent): void {
    if (event.toState === 'hidden') {
      // Optional: Any cleanup after hiding
    }
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}

