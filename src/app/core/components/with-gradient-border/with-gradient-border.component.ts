import { Component, Input, ElementRef, HostListener, Renderer2, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'with-gradient-border',
  templateUrl: './with-gradient-border.component.html',
  styleUrls: ['./with-gradient-border.component.scss'],
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WithGradientBorderComponent {
  @Input() color: string | string[] = 'rgb(236 72 153)';
  @Input('border-width') borderWidth: string = '1px';

  x = '0px';
  y = '0px';
  size = '0px';

  get gradientStyle() {
    const colorStops = Array.isArray(this.color) ? this.color.join(', ') : this.color;
    return {
      background: `radial-gradient(${this.size} circle at ${this.x} ${this.y}, ${colorStops}, transparent 100%)`,
      "border-radius": "5px"
    };
  }

  constructor(private el: ElementRef, private renderer: Renderer2) {}

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    const rect = this.el.nativeElement.getBoundingClientRect();
    this.x = `${event.clientX - rect.left}px`;
    this.y = `${event.clientY - rect.top}px`;
    this.size = `${Math.max(rect.width, rect.height) * 0.8}px`;
  }

  @HostListener('mouseleave')
  onMouseLeave() {
    this.x = '0px';
    this.y = '0px';
    this.size = '0px';
  }
}
