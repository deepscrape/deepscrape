import { NgClass, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input, TemplateRef } from '@angular/core';
import { sidebarItemAnimation } from 'src/app/animations';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-sidebar-nav-dropdown',
    imports: [NgClass, NgTemplateOutlet],
    templateUrl: './app-sidebar-nav-dropdown.component.html',
    styleUrl: './app-sidebar-nav-dropdown.component.scss',
    animations: [
        // animation triggers go here
        sidebarItemAnimation
    ]
})
export class AppSidebarNavDropdownComponent {
  @Input() link: any
  @Input() sidebarNavTemp!: TemplateRef<any>;
  @Input() openMenu: boolean

  public isBadge() {
    return this.link.badge ? true : false
  }

  public isIcon() {

    const icon = this.link.icon ? true : false

    return icon
  }

  constructor() { this.openMenu = true }
  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.

  }
}
