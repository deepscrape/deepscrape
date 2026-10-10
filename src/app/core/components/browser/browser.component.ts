import { Component, ElementRef, Inject, Input, OnDestroy, OnInit, ViewChild, DOCUMENT, inject } from '@angular/core';

import { AuthService, WebRtcService, WindowToken } from '../../services';
import { ClipboardComponent } from '../clipboard/clipboard.component';
import { ResolutionComponent } from '../resolution/resolution.component';
import { ControlComponent } from '../control/control.component';
import { TranslateModule } from '@ngx-translate/core';
import { fromEvent, merge, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-browser',
  imports: [ClipboardComponent, ResolutionComponent, ControlComponent, TranslateModule],
  templateUrl: './browser.component.html',
  styleUrl: './browser.component.scss'
})
export class BrowserComponent implements OnInit, OnDestroy {
  private window = inject(WindowToken);
  private destroy$ = new Subject<void>();
  /**
   * The signalling endpoint, supplied by whoever mounts this viewer.
   *
   * There is deliberately NO default. It used to read a global
   * `environment.nekoUrl` pointing at one fixed external host this repo does not
   * control, which made the endpoint a build-time constant rather than a
   * per-session fact. An empty value means "nobody said where the browser is",
   * and the connect path refuses rather than guessing.
   */
  @Input() endpoint = '';
  private isMouseDown = false;  private isConnectionActive = false;
  private wheelThrottle = false;
  private lastTextareaValue = '';
  @ViewChild('video') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlay') overlayRef!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('clipboard') clipboardRef!: ClipboardComponent;
  @ViewChild('resolution') resolutionRef!: ResolutionComponent;
  @ViewChild('control') controlRef!: ControlComponent;
  
  // UI state variables
  connecting = false;
  connected = false;
  error: string | null = null;
  hasControl = false;
  autoplayBlocked = false;
  private playAttempts = 0;
  private maxPlayAttempts = 3;
  private playPromise: Promise<void> | null = null;
  private videoHealthInterval: ReturnType<typeof setInterval> | null = null;
  private lastVideoTime = 0;
    constructor(
    private rtc: WebRtcService, 
    private auth: AuthService,
    @Inject(DOCUMENT) private document: Document,
  ) {}
  ngOnInit(): void {
    // Wait for ViewChild references to be available
    setTimeout(() => this.setupEventListeners(), 0);
    
    // Subscribe to WebRTC events
    this.setupWebRTCEvents();
    
    // Set up user interaction listeners to help with autoplay
    this.setupUserInteractionListeners();
  }
  
  /**
   * Set up listeners for user interaction to enable autoplay
   * after the first user gesture on the document
   */
  private setupUserInteractionListeners(): void {
    const interactionEvents = ['click', 'touchstart', 'keydown', 'pointerdown'];

    merge(...interactionEvents.map(e => fromEvent(this.document, e)))
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.autoplayBlocked && this.connected && this.videoRef?.nativeElement) {
          console.log('User interaction detected, attempting to play video');
          this.startPlayback();
        }
      });
  }
  /**
   * Set up subscriptions for WebRTC events
   */
  private setupWebRTCEvents() {
    // Connection status updates
    this.rtc.connectionStatus$
      .pipe(takeUntil(this.destroy$))
      .subscribe(status => {
        this.isConnectionActive = status;
        this.connected = status;
      });
      // Track events for handling video streams
    this.rtc.track$
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        if (this.videoRef?.nativeElement && event.streams[0]) {
          // Store the current stream object for reference
          this.videoRef.nativeElement.srcObject = event.streams[0];
          
          // Use the safe play method with retry logic
          this.safePlayVideo();
        }
      });
      // Clipboard events for synchronizing clipboard content
    this.rtc.clipboard$
      .pipe(takeUntil(this.destroy$))
      .subscribe(text => {
        if (this.clipboardRef && text) {
          // Update clipboard component text if it's open
          if (this.clipboardRef.visible) {
            this.clipboardRef.clipboardText = text;
          }
          
          // Show clipboard UI if receiving new content from server
          // and we don't currently have the clipboard open
          if (!this.clipboardRef.visible && text.trim() !== '') {
            // Optionally auto-open the clipboard UI when receiving new content
            // this.openClipboard();
            
            // Or display a notification that clipboard content is available
            console.log('New clipboard content available from server');
          }
        }
      });

    // Control status updates
    this.rtc.controlStatus$
      .pipe(takeUntil(this.destroy$))
      .subscribe(hasControl => {
        this.hasControl = hasControl;
        if (this.controlRef) {
          this.controlRef.hasControl = hasControl;
        }
      });
  }

  /**
   * Set up mouse and keyboard event listeners for remote control
   */
  private setupEventListeners() {
    if (!this.overlayRef) return;
    
    const overlay = this.overlayRef.nativeElement;
    
    // Mouse events
    fromEvent<MouseEvent>(overlay, 'mousemove')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onMouseMove(e));
      
    fromEvent<MouseEvent>(overlay, 'mousedown')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onMouseDown(e));
      
    fromEvent<MouseEvent>(overlay, 'mouseup')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onMouseUp(e));
      // Keyboard events - listen on window for better keyboard capture
    fromEvent<KeyboardEvent>(this.window, 'keydown')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => {
        // First check if it's a shortcut we want to handle locally
        const handled = this.handleShortcuts(e);
        // Only send to remote if not handled locally
        if (!handled) {
          this.onKeyDown(e);
        }
      });
      
    fromEvent<KeyboardEvent>(this.window, 'keyup')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onKeyUp(e));
      
    // Touch events for mobile support
    fromEvent<TouchEvent>(overlay, 'touchstart')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onTouchStart(e));
      
    fromEvent<TouchEvent>(overlay, 'touchmove')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onTouchMove(e));
      
    fromEvent<TouchEvent>(overlay, 'touchend')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onTouchEnd(e));

    // Wheel event
    fromEvent<WheelEvent>(overlay, 'wheel')
      .pipe(takeUntil(this.destroy$))
      .subscribe(e => this.onWheel(e));

    // Composition events for IME input
    fromEvent<CompositionEvent>(overlay, 'compositionstart')
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.onCompositionStart());

    fromEvent<CompositionEvent>(overlay, 'compositionend')
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.onCompositionEnd());
  }
  /**
   * Initiate WebRTC connection with the server
   */
  async startStream() {
    if (this.connecting) return;
    
    this.connecting = true;
    this.error = null;
    this.autoplayBlocked = false;
    this.playAttempts = 0;
    this.playPromise = null;
    
    try {
      // Reset video element if it exists
      if (this.videoRef?.nativeElement) {
        const video = this.videoRef.nativeElement;
        
        // Clean up existing video state
        if (video.srcObject) {
          // Stop all tracks if they exist
          const streams = video.srcObject as MediaStream;
          if (streams) {
            streams.getTracks().forEach(track => track.stop());
          }
          video.srcObject = null;
        }
      }
      
      // The endpoint comes from the CALLER, never from a build constant. An
      // unmounted viewer therefore cannot reach anything: with no endpoint this
      // throws into the catch below rather than dialling a default host.
      const endpoint = (this.endpoint ?? '').trim().replace(/\/+$/, '');
      if (!endpoint) {
        throw new Error('No browser endpoint configured for this session.');
      }
      await this.rtc.connect(`${endpoint}/ws`, "admin", "neko");
      
      // Focus the overlay for keyboard input
      if (this.overlayRef?.nativeElement) {
        this.overlayRef.nativeElement.focus();
      }
    } catch (err: any) {
      this.error = err.message || 'Failed to connect to remote browser';
      console.error('WebRTC connection error:', err);
    } finally {
      this.connecting = false;
    }
  }
  /**
   * Mouse movement event handler
   */  private onMouseMove(e: MouseEvent) {
    if (!this.isConnectionActive || !this.hasControl) return;
    
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = Math.floor(e.clientX - rect.left);
    const y = Math.floor(e.clientY - rect.top);
    
    this.rtc.sendData('mousemove', { x, y });
  }
  /**
   * Mouse down event handler
   */  private onMouseDown(e: MouseEvent) {
    if (!this.isConnectionActive || !this.hasControl) return;
    this.isMouseDown = true;
    
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = Math.floor(e.clientX - rect.left);
    const y = Math.floor(e.clientY - rect.top);
    
    // First send the current mouse position
    this.rtc.sendData('mousemove', { x, y });
    // Then send the mousedown event
    this.rtc.sendData('mousedown', { key: e.button + 1 }); // Convert from JS button (0,1,2) to WebRTC button (1,2,3)
    
    // Prevent default to avoid text selection, etc.
    e.preventDefault();
  }

  /**
   * Mouse up event handler
   */  private onMouseUp(e: MouseEvent) {
    if (!this.isConnectionActive || !this.isMouseDown) return;
    this.isMouseDown = false;
    
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = Math.floor(e.clientX - rect.left);
    const y = Math.floor(e.clientY - rect.top);
    
    // First send the current mouse position
    this.rtc.sendData('mousemove', { x, y });
    // Then send the mouseup event
    this.rtc.sendData('mouseup', { key: e.button + 1 }); // Convert from JS button (0,1,2) to WebRTC button (1,2,3)
    
    e.preventDefault();
  }

  /**
   * Key down event handler
   */  private onKeyDown(e: KeyboardEvent) {
    if (!this.isConnectionActive) return;
    
    // Ignore certain key combinations, like browser shortcuts
    if ((e.ctrlKey && e.key === 'r') || 
        (e.ctrlKey && e.key === 'w') || 
        (e.ctrlKey && e.key === 't')) {
      return;
    }
    
    // Convert key to key code (this would need proper mapping like in Neko client)
    const keyCode = this.mapKeyToCode(e.key);
    this.rtc.sendData('keydown', { key: keyCode });
    
    // Prevent browser defaults for certain keys
    if (['F5', 'F11', 'Tab'].includes(e.key)) {
      e.preventDefault();
    }
  }
  
  /**
   * Map keyboard key to X11 key code like in neko client
   */
  private mapKeyToCode(key: string): number {
    // This is a simplified mapping - should be expanded based on Neko's keyMap
    const keyMap: {[key: string]: number} = {
      'Control': 0xffe3, // Left control
      'Alt': 0xffe9, // Left alt
      'Shift': 0xffe1, // Left shift
      'Meta': 0xffe7, // Left meta
      'Escape': 0xff1b,
      'Backspace': 0xff08,
      'Tab': 0xff09,
      'Enter': 0xff0d,
      'ArrowLeft': 0xff51,
      'ArrowUp': 0xff52,
      'ArrowRight': 0xff53,
      'ArrowDown': 0xff54
    };
    
    if (keyMap[key]) {
      return keyMap[key];
    }
    
    // For standard keys, return ASCII/Unicode value
    if (key.length === 1) {
      return key.charCodeAt(0);
    }
    
    // Default key code
    return 0;
  }

  /**
   * Key up event handler
   */  private onKeyUp(e: KeyboardEvent) {
    if (!this.isConnectionActive) return;
    
    const keyCode = this.mapKeyToCode(e.key);
    this.rtc.sendData('keyup', { key: keyCode });
  }
  /**
   * Touch start handler for mobile devices
   */
  private onTouchStart(e: TouchEvent) {
    if (!this.isConnectionActive || !e.touches.length) return;
    
    const touch = e.touches[0];
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = Math.floor(touch.clientX - rect.left);
    const y = Math.floor(touch.clientY - rect.top);
    
    // First send the mouse position
    this.rtc.sendData('mousemove', { x, y });
    // Then send mousedown
    this.rtc.sendData('mousedown', { key: 1 }); // Left click
    
    e.preventDefault();
  }
  /**
   * Touch move handler for mobile devices
   */
  private onTouchMove(e: TouchEvent) {
    if (!this.isConnectionActive || !e.touches.length) return;
    
    const touch = e.touches[0];
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = Math.floor(touch.clientX - rect.left);
    const y = Math.floor(touch.clientY - rect.top);
    
    this.rtc.sendData('mousemove', { x, y });
    
    e.preventDefault();
  }
  /**
   * Touch end handler for mobile devices
   */
  private onTouchEnd(e: TouchEvent) {
    if (!this.isConnectionActive) return;
    
    // Use last touch position or center if not available
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const x = e.changedTouches.length ? 
      Math.floor(e.changedTouches[0].clientX - rect.left) : 
      Math.floor(rect.width / 2);
    const y = e.changedTouches.length ? 
      Math.floor(e.changedTouches[0].clientY - rect.top) : 
      Math.floor(rect.height / 2);
    
    // First send the mouse position (like in video.vue)
    this.rtc.sendData('mousemove', { x, y });
    // Then send the mouseup event
    this.rtc.sendData('mouseup', { key: 1 }); // Left click release
    
    e.preventDefault();
  }

  /**
   * Mouse wheel event handler for scrolling
   */
  private onWheel(e: WheelEvent) {
    if (!this.isConnectionActive) return;
    
    // Calculate scroll values
    let x = e.deltaX;
    let y = e.deltaY;
    
    // Handle non-pixel delta modes (like line or page scrolling)
    if (e.deltaMode !== 0) {
      // Use a line height similar to Neko client
      const WHEEL_LINE_HEIGHT = 19;
      x *= WHEEL_LINE_HEIGHT;
      y *= WHEEL_LINE_HEIGHT;
    }
    
    // Apply constraints to prevent overly fast scrolling
    const scrollLimit = 100;
    x = Math.min(Math.max(x, -scrollLimit), scrollLimit);
    y = Math.min(Math.max(y, -scrollLimit), scrollLimit);
    
    // Get current mouse position
    const rect = this.overlayRef.nativeElement.getBoundingClientRect();
    const mouseX = Math.floor(e.clientX - rect.left);
    const mouseY = Math.floor(e.clientY - rect.top);
    
    // Send position and wheel data with throttling
    if (!this.wheelThrottle) {
      this.wheelThrottle = true;
      
      // First send the current mouse position
      this.rtc.sendData('mousemove', { x: mouseX, y: mouseY });
      
      // Then send the wheel data
      this.rtc.sendData('wheel', { x, y });
      
      // Reset throttle after a short delay
      setTimeout(() => {
        this.wheelThrottle = false;
      }, 50);
    }
    
    // Prevent default browser scrolling
    e.preventDefault();
  }

  /**
   * Composition start handler for IME input
   */
  onCompositionStart() {
    if (this.overlayRef?.nativeElement) {
      this.lastTextareaValue = this.overlayRef.nativeElement.value;
    }
  }

  /**
   * Composition end handler for IME input
   */
  onCompositionEnd() {
    if (this.overlayRef?.nativeElement) {
      this.overlayRef.nativeElement.value = this.lastTextareaValue;
    }
  }

  /**
   * Handle keyboard shortcuts for clipboard and other common operations
   * @param event Keyboard event
   * @returns true if handled, false otherwise
   */
  private handleShortcuts(event: KeyboardEvent): boolean {
    // Only process if connected
    if (!this.isConnectionActive) return false;
    
    // Check for Ctrl+V to intercept clipboard paste
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === 'v') {
      // Show clipboard dialog for pasting
      this.openClipboard();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    
    // Check for Ctrl+C to intercept clipboard copy
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === 'c') {
      // We still send the Ctrl+C to the remote system
      // but also try to get any text selection locally
      try {
        const selection = this.window.getSelection()?.toString();
        if (selection && selection.length > 0) {
          // Update clipboard component with selection
          if (this.clipboardRef) {
            this.clipboardRef.clipboardText = selection;
            // Don't open clipboard UI, but send the text to remote
            this.rtc.sendClipboardText(selection);
          }
        }
      } catch (err) {
        console.warn('Failed to access selection:', err);
      }
      
      // We don't prevent default here since we want the Ctrl+C to still go to the remote
      return false;
    }
    
    return false;
  }

  /**
   * Open clipboard dialog
   */
  openClipboard() {
    if (this.clipboardRef) {
      this.clipboardRef.open();
    }
  }
  /**
   * Handle clipboard content sent from clipboard component
   */
  onClipboardSent(text: string) {
    console.log('Clipboard content sent to remote:', text);
    
    // Send clipboard content to the server via WebRTC
    // Using the dedicated sendClipboardText method
    this.rtc.sendClipboardText(text);
  }

  /**
   * Open resolution selector dialog
   */
  openResolution() {
    if (this.resolutionRef) {
      this.resolutionRef.open();
    }
  }

  /**
   * Handle resolution change from resolution component
   */
  onResolutionChanged(resolution: {width: number, height: number}) {
    console.log(`Resolution changed to ${resolution.width}×${resolution.height}`);
    // The ResolutionComponent already handles sending the message to the server
  }

  /**
   * Handle control status change from control component
   * @param hasControl Whether the current user has control
   */
  onControlChanged(hasControl: boolean) {
    this.hasControl = hasControl;
    console.log(`Control status changed: ${hasControl ? 'Has control' : 'No control'}`);
  }

  /**
   * Request fullscreen mode for the video
   */
  requestFullscreen() {
    const videoContainer = this.videoRef?.nativeElement?.parentElement;
    if (!videoContainer) return;

    if (this.document.fullscreenElement) {
      this.document.exitFullscreen().catch(err => {
        console.error('Error exiting fullscreen mode:', err);
      });
    } else {
      videoContainer.requestFullscreen().catch(err => {
        console.error('Error entering fullscreen mode:', err);
      });
    }
  }
  /**
   * Safely attempt to play the video with proper promise handling
   * and retry logic to handle interrupted play() calls
   */
  private safePlayVideo(): void {
    if (!this.videoRef?.nativeElement) return;
    
    const video = this.videoRef.nativeElement;
    
    // Cancel any existing play operation before starting a new one
    if (this.playPromise !== null) {
      // Reset the promise to allow new play attempts
      this.playPromise = null;
      this.playAttempts = 0;
      return;
    }
    
    this.playAttempts++;
    console.log(`Attempting to play video (attempt ${this.playAttempts}/${this.maxPlayAttempts})`);
    
    try {
      // Make sure video is muted for first attempt (browsers allow muted autoplay)
      if (this.playAttempts === 1) {
        video.muted = true;
      }
      
      // Store the promise to track its state
      this.playPromise = video.play();
      
      if (this.playPromise !== undefined) {
        this.playPromise
          .then(() => {
            // Playback started successfully
            console.log('Video playback started successfully');
            this.autoplayBlocked = false;
            this.playPromise = null;
            this.playAttempts = 0;
            
            // If we're connected and have a stream, set a flag to indicate successful play
            if (this.connected && video.srcObject) {
              console.log('Stream is now playing');
              
              // Set a periodic check to ensure video is still playing
              this.setupVideoHealthCheck();
            }
          })
          .catch(error => {
            // Handle the error based on its type
            if (error.name === 'AbortError') {
              console.warn('Video play() was interrupted by another operation', error);
              
              // Retry play if under max attempts and if video is still in the DOM
              if (this.playAttempts < this.maxPlayAttempts && this.videoRef?.nativeElement) {
                console.log('Retrying video playback after interruption...');
                
                // Small delay before retry to avoid rapid retries
                setTimeout(() => {
                  this.playPromise = null;
                  this.safePlayVideo();
                }, 200);
              } else {
                this.playPromise = null;
                console.warn(`Maximum play attempts (${this.maxPlayAttempts}) reached after AbortError`);
                
                // Show UI for manual play after too many attempts
                this.autoplayBlocked = true;
              }
            } else if (error.name === 'NotAllowedError') {
              // Browser blocked autoplay due to user interaction policy
              console.warn('Autoplay blocked by browser policy, waiting for user interaction', error);
              this.autoplayBlocked = true;
              this.playPromise = null;
              this.playAttempts = 0;
              
              // Try one more time with muted if we haven't already
              if (!video.muted) {
                console.log('Retrying with muted video');
                video.muted = true;
                setTimeout(() => {
                  this.playPromise = null;
                  this.safePlayVideo();
                }, 100);
              }
            } else {
              // Other errors
              console.error('Error during video playback:', error);
              this.playPromise = null;
              this.playAttempts = 0;
              this.autoplayBlocked = true;
            }
          });
      }
    } catch (err) {
      console.error('Exception during play() call:', err);
      this.playPromise = null;
      this.playAttempts = 0;
      this.autoplayBlocked = true;
    }
  }
  
  /**
   * Setup a periodic check to make sure video is still playing
   * and recover if it has stalled
   */
  private setupVideoHealthCheck(): void {
    // Clear any existing interval
    if (this.videoHealthInterval) {
      clearInterval(this.videoHealthInterval);
      this.videoHealthInterval = null;
    }
    
    // Set up a new interval to check video health periodically
    this.videoHealthInterval = setInterval(() => {
      const video = this.videoRef?.nativeElement;
      if (!video || !this.connected) {
        clearInterval(this.videoHealthInterval!);
        this.videoHealthInterval = null;
        return;
      }
      
      // Check if video is stalled or paused unexpectedly
      if (!video.paused && (video.readyState < 3 || video.currentTime === this.lastVideoTime)) {
        console.warn('Video may be stalled, attempting recovery...');
        this.playAttempts = 0;
        this.playPromise = null;
        this.safePlayVideo();
      }
      
      // Update last known time
      this.lastVideoTime = video.currentTime;
      
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * User-initiated playback start (called from UI)
   */
  public startPlayback(): void {
    if (this.videoRef?.nativeElement) {
      this.playAttempts = 0;
      this.playPromise = null;
      this.safePlayVideo();
      this.autoplayBlocked = false;
    }
  }
  /**
   * Cleanup resources on component destroy
   */
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    
    // Clear any active intervals
    if (this.videoHealthInterval) {
      clearInterval(this.videoHealthInterval);
      this.videoHealthInterval = null;
    }
    
    // Close the WebRTC connection
    this.rtc.close();
  }
}
