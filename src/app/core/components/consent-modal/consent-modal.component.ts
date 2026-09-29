
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { LocalStorage, WindowToken } from '../../services';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { RippleDirective } from '../../directives';



@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-consent-modal',
    imports: [MatIcon, RippleDirective, TranslateModule],
    templateUrl: './consent-modal.component.html',
    styleUrl: './consent-modal.component.scss'
})
export class ConsentModalComponent {
  isConsent: boolean = false;
  private window = inject(WindowToken);
  private localStorage = inject(LocalStorage);
  @Input() isExtensionInstalled: boolean = true;  // Track if extension is already installed

  @Input() forwardCookiesBtnEnabled: boolean = true
  @Output() consentAccepted = new EventEmitter<boolean>();

  @Output() onExtensionDecline = new EventEmitter<boolean>()

  constructor(private cdr: ChangeDetectorRef) { }
  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.isConsent = this.localStorage.getItem('privacyConsent') === 'true';
  }

  acceptConsent() {
    this.isConsent = true;
    this.consentAccepted.emit(true);
  }

  declineConsent() {
    this.isConsent = true;
    this.consentAccepted.emit(false);
    this.declineExtension()
  }

  declineExtension() {
    this.onExtensionDecline.emit(false)
  }
  // Redirect to browser extension store for download
  downloadExtension() {

    // Replace with the actual URL of your extension
    const extensionUrl = 'https://chrome.google.com/webstore/detail/your-extension-id';

    this.window.open(extensionUrl, '_blank');
  }


}
