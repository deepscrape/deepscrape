import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, HostListener, Input, model, Output, signal, ViewChild } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { startSuspendAnimation } from 'src/app/animations';
import { FlyMachine } from '../../types';
import { FormatBytesPipe } from '../../pipes';
import { DeploymentService } from '../../services';
import { MACHNINE_STATE } from '../../enum';
import { Outsideclick, RippleDirective } from '../../directives';

export interface ExtendedFlyMachine extends FlyMachine {
  menu_visible?: boolean
}

@Component({
  selector: 'app-container-box',
  imports: [
    MatIcon,
    DatePipe,
    FormatBytesPipe,
    RippleDirective,
    TranslateModule
],
  templateUrl: './container-box.component.html',
  styleUrl: './container-box.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [startSuspendAnimation]
})
export class ContainerBoxComponent {

  
  @ViewChild('menuElement') menuElement: any;
  
  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const menu = this.menuElement.nativeElement;
    if (menu && !menu.contains(event.target)) {
      this.machine.menu_visible = false;
    }
  }

  startButton = signal<boolean>(false)
  stopButton = signal<boolean>(false) // model.required<boolean>()
  @Input() machine: ExtendedFlyMachine

  @Output() startPressed = new EventEmitter<{ id: string, laststate: string, instance_id: string }>()
  @Output() suspendPressed = new EventEmitter<{ id: string, laststate: string, instance_id: string }>()
  @Output() stopPressed = new EventEmitter<{ id: string, laststate: string, instance_id: string }>()
  @Output() destroyPressed = new EventEmitter<{ id: string, laststate: string, instance_id: string }>()
  @Output() taskPressed = new EventEmitter<{ id: string, laststate: string, instance_id: string }>()

  constructor(private cdr: ChangeDetectorRef, private deployService: DeploymentService) { }

  ngAfterViewInit(): void {
    //Called after every check of the component's view. Applies to components only.
    //Add 'implements AfterViewChecked' to the class.

    this.switchState()
    this.cdr.detectChanges()
  }
  get name() {
    return this.machine.name
  }
  get description() {
    return this.machine.description
  }

  get state() {
    return this.machine.state
  }


  /* Actions */
  protected start() {

    if (!this.startButton()) {
      this.startPressed.emit({ id: this.machine.id, laststate: this.machine.state, instance_id: this.machine.instance_id })
      this.stopButton.set(true)
    } else {
      this.suspendPressed.emit({ id: this.machine.id, laststate: this.machine.state, instance_id: this.machine.instance_id })
      this.stopButton.set(true)
    }

    this.startButton.set(!this.startButton())
  }

  protected destroy() {
    this.destroyPressed.emit({ id: this.machine.id, laststate: this.machine.state, instance_id: this.machine.instance_id })
    this.toggleMenuVisible()
  }

  protected runTask() {
    this.taskPressed.emit({ id: this.machine.id, laststate: this.machine.state, instance_id: this.machine.instance_id })
    this.toggleMenuVisible()
  }

  protected stop() {
    this.stopButton.set(false)
    this.startButton.set(false)
    this.machine.state = MACHNINE_STATE.STOPPING

    // emit stop event
    this.stopPressed.emit({ id: this.machine.id, laststate: this.machine.state, instance_id: this.machine.instance_id })
    this.cdr.detectChanges()
  }

  switchState() {
    switch (this.machine.state) {
      case MACHNINE_STATE.CREATED:
        this.startButton.set(true)
        this.stopButton.set(true)
        break;
      case MACHNINE_STATE.STARTED:
        this.startButton.set(true)
        this.stopButton.set(true)
        break;
      case MACHNINE_STATE.SUSPENDED:
        this.startButton.set(false)
        this.stopButton.set(true)
        break;
      case MACHNINE_STATE.STOPPING:
        break;
      case MACHNINE_STATE.STOPPED:
        this.startButton.set(false)
        this.stopButton.set(false)
        break;
      default:
        break;
    }
  }

  toggleMenuVisible() {
    this.machine.menu_visible = !this.machine.menu_visible
    // this.apiKeyService.setMenuVisible(key)
  }

  closePopupMenu(event: MouseEvent) {

    /* const element = event.target as HTMLElement
    console.log(element) */

    if (!this.machine?.menu_visible) return

    // this.apiKeyService.setMenuVisible(key);
  }
  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.

    this.startPressed?.complete()
    this.suspendPressed?.complete()
    this.stopPressed?.complete()
    this.destroyPressed?.complete()
    this.taskPressed?.complete()
  }
}
