// webrtc.service.ts
import { DestroyRef, Inject, Injectable, inject, DOCUMENT } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, Observable, Subject, catchError, firstValueFrom, from, retry, throwError, filter, take, timeout } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { HttpClient, HttpHeaders } from '@angular/common/http';

import { NAVIGATOR } from '../providers';
import { EVENT, SignalAnswerMessage, ControlClipboardPayload, SignalCandidatePayload, SignalOfferPayload, SignalProvidePayload, WebSocketMessages } from '../types';

// Constants for binary data communication
export enum OPCODE {
  MOVE = 0x01,
  SCROLL = 0x02,
  KEY_DOWN = 0x03,
  KEY_UP = 0x04,
  MOUSE_DOWN = 0x05,
  MOUSE_UP = 0x06,
}

@Injectable({ providedIn: 'root' })
export class WebRtcService {
  private destroyRef = inject(DestroyRef);
  pc: RTCPeerConnection | null = null;
  private wsSubject$: WebSocketSubject<any> | null = null;
  sessionId: string | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private candidates: RTCIceCandidate[] = [];
  private heartbeatInterval: any;
  private reconnectAttempts = 0;
  private reconnectTimeout: any;
  private maxReconnectAttempts = 5;
  private displayName = '';
  
  // Default ICE servers - will be overridden by server config if provided
  private iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" }
  ];

  // Connection state tracking
  private _state: RTCIceConnectionState = 'disconnected';
  get peerConnected(): boolean {
    return !!this.pc && ['connected', 'checking', 'completed'].includes(this._state);
  }
  
  get socketOpen(): boolean {
    return !!this.wsSubject$ && !this.wsSubject$.closed;
  }
  
  get connected(): boolean {
    return this.peerConnected && this.socketOpen;
  }
  
  get supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && 
           typeof RTCPeerConnection.prototype.addTransceiver !== 'undefined';
  }

  // WebSocket message subject
  private messagesSubject$ = new Subject<any>();
  public messages$ = this.messagesSubject$.asObservable();

  // Connection status subject
  private connectionStatusSubject$ = new BehaviorSubject<boolean>(false);
  public connectionStatus$ = this.connectionStatusSubject$.asObservable();

  // Track events
  private trackSubject$ = new Subject<RTCTrackEvent>();
  public track$ = this.trackSubject$.asObservable();
  // Control subjects
  private controlStatusSubject$ = new BehaviorSubject<boolean>(false);
  public controlStatus$ = this.controlStatusSubject$.asObservable();
  
  // Control lock status
  private controlLockedSubject$ = new BehaviorSubject<boolean>(false);
  public controlLocked$ = this.controlLockedSubject$.asObservable();
  
  // User ID who has control
  private controllerIdSubject$ = new BehaviorSubject<string>('');
  public controllerId$ = this.controllerIdSubject$.asObservable();

  // Clipboard subject for syncing clipboard content
  private clipboardSubject$ = new BehaviorSubject<string>('');
  public clipboard$ = this.clipboardSubject$.asObservable();

  constructor(private http: HttpClient,
    @Inject(NAVIGATOR) private navigator: Navigator,
    @Inject(DOCUMENT) private document: Document,
  ) { }

  /**
   * Initialize WebRTC connection with server
   * @param serverBase Base URL of the server
   * @param jwtToken JWT authentication token
   */
  async connect(serverBase: string, password: string, displayName: string/* jwtToken: string */) {
    if (this.socketOpen) {
      console.warn('WebSocket connection already exists');
      return;
    }

    if (!this.supported) {
      throw new Error('WebRTC is not supported in this browser');
    }

    this.displayName = displayName; // Could be parameterized later
    this[EVENT.CONNECTING]();

    try {
      // First establish WebSocket connection (similar to base.ts). Credentials go in the
      // query string because neko's own upgrade handler reads them there; no ID token ever
      // does -- a URL lands in proxy and CDN logs and a token in one is replayable.
      const wsUrl = `${serverBase.replace(/^http(s)?:\/\//, 'ws$1://')}?password=${encodeURIComponent(password)}&username=${encodeURIComponent(displayName)}`;
      this.connectToWebSocket(wsUrl);

      // Wait for the PROVIDE event which will contain ICE servers
      // This is typically handled by the WebSocket message handler
      // But we can simulate waiting for initialization
      await firstValueFrom(this.connectionStatusSubject$.pipe(
        filter(status => status === true),
        take(1),
        timeout(10000),
        catchError(error => {
          throw new Error('Timed out waiting for WebSocket connection');
        })
      ));

      // At this point, the SIGNAL.PROVIDE or SYSTEM.INIT would have been received
      // and handled by the message handlers, which would create the peer connection

      // For backward compatibility, we'll create a peer connection if not already created
      if (!this.pc) {
        await this.createPeer(false);
      }
      
      return this.sessionId;
    } catch (error) {
      console.error('Failed to establish WebRTC connection:', error);
      this.close();
      throw error;
    }
  }
  
  /**
   * Called when attempting to reconnect to an existing session
   */
  protected [EVENT.RECONNECTING]() {
    console.log('Reconnecting to WebRTC session...');
  }

  /**
   * Create a new WebRTC peer connection
   * @param lite Whether to use lite mode (no ICE servers)
   * @param servers Optional ICE servers to use
   */
  private async createPeer(lite: boolean = false, servers?: RTCIceServer[]) {
    console.log('Creating peer connection');
    
    if (!this.socketOpen) {
      console.warn('Attempting to create peer with no websocket connection');
      return;
    }

    if (this.peerConnected) {
      console.warn('Attempting to create peer while already connected');
      return;
    }

    // Close existing peer connection if any
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Create new peer connection with ICE servers
    if (lite !== true && servers) {
      this.pc = new RTCPeerConnection({
        iceServers: servers
      });
    } else {
      // Fallback to default STUN server if no servers provided
      this.pc = new RTCPeerConnection({
        iceServers: this.iceServers
      });
    }

    // Connection state changes
    this.pc.onconnectionstatechange = () => {
      console.debug('Peer connection state changed:', this.pc?.connectionState);
    };

    // Signaling state changes
    this.pc.onsignalingstatechange = () => {
      console.debug('Peer signaling state changed:', this.pc?.signalingState);
    };

    // ICE connection state changes
    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      this._state = this.pc.iceConnectionState;
      console.debug(`Peer ICE connection state changed: ${this._state}`);

      switch (this._state) {
        case 'checking':
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
          }
          break;
        case 'connected':
          this.onConnected();
          break;
        case 'disconnected':
          this[EVENT.RECONNECTING]();
          break;
        case 'failed':
          this.onDisconnected(new Error('Peer connection failed'));
          break;
        case 'closed':
          this.onDisconnected(new Error('Peer connection closed'));
          break;
      }
    };

    // Track events - when remote tracks are received
    this.pc.ontrack = (event: RTCTrackEvent) => {
      console.log('✅ Got remote track', event.streams[0]);
      this.trackSubject$.next(event);
    };

    // ICE candidate events
    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) {
        console.debug('Sent all local ICE candidates');
        return;
      }

      const init = event.candidate.toJSON();
      console.debug('Sending local ICE candidate', init);

      // Send the candidate to the server using WebSocket
      if (this.wsSubject$ && !this.wsSubject$.closed) {
        this.wsSubject$.next({
          event: EVENT.SIGNAL.CANDIDATE,
          data: JSON.stringify(init)
        });
      }
    };

    // Negotiation needed event
    this.pc.onnegotiationneeded = async () => {
      console.warn('Negotiation is needed');
      
      try {
        const offer = await this.pc!.createOffer();
        await this.pc!.setLocalDescription(offer);

        // Send offer to server using WebSocket
        if (this.wsSubject$ && !this.wsSubject$.closed) {
          this.wsSubject$.next({
            event: EVENT.SIGNAL.OFFER,
            sdp: this.pc!.localDescription!.sdp
          });
        }
      } catch (error) {
        console.error('Failed to create offer', error);
      }
    };

    // Create data channel for control inputs
    this.dataChannel = this.pc.createDataChannel('data');
    
    // Data channel error handling
    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.onError(error);
    };
    
    // Data channel message handling
    this.dataChannel.onmessage = (event) => {
      this.onDataChannelMessage(event);
    };
    
    // Data channel close handling
    this.dataChannel.onclose = () => {
      console.warn('Data channel closed');
      this.onDisconnected(new Error('Peer data channel closed'));
    };

    // For receiving video
    // this.pc.addTransceiver('video', { direction: 'recvonly' });
    
    // Optionally add audio transceiver if needed
    // this.pc.addTransceiver('audio', { direction: 'recvonly' });

    // Setup complete
    console.log('Peer connection setup complete');
  }

  /**
   * Handle WebRTC connection established
   */
  private onConnected() {
    console.log('WebRTC connection established!');
    this.connectionStatusSubject$.next(true);
    
    // Start sending heartbeats
    this.startHeartbeat();
  }

  /**
   * Handle WebRTC disconnection
   */
  private onDisconnected(error: Error) {
    console.warn('WebRTC disconnected:', error.message);
    this.connectionStatusSubject$.next(false);
      // Attempt reconnection if not explicitly closed
    if (this.wsSubject$ && !this.wsSubject$.closed) {
      this.attemptReconnect();
    }
  }

  /**
   * Handle WebRTC error
   */
  private onError(error: any) {
    console.error('WebRTC error:', error);
    
    // Emit error event
    if (this.messagesSubject$) {
      this.messagesSubject$.error(error);
    }
  }

  /**
   * Handle data channel message
   */
  private onDataChannelMessage(event: MessageEvent) {
    try {
      // Handle binary or text messages from the server
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        this.messagesSubject$.next(message);
      } else {
        // Binary message handling (if needed)
        console.debug('Received binary data', event.data);
      }
    } catch (error) {
      console.error('Error handling data channel message', error);
    }
  }  

  /**
   * Set remote offer and create answer - aligned with base.ts implementation
   */
  public async setRemoteOffer(sdp: string) {
    if (!this.pc) {
      console.warn('Attempting to set remote offer while disconnected');
      return;
    }

    try {
      // Set the remote description
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      
      // Process any stored ICE candidates now that the remote description is set
      await this.processPendingCandidates();

      // Create answer
      const answer = await this.pc.createAnswer();
      
      // Add stereo=1 to answer sdp to enable stereo audio like in base.ts
      answer.sdp = answer.sdp?.replace(/(stereo=1;)?useinbandfec=1/, 'useinbandfec=1;stereo=1');
      
      // Set local description
      await this.pc.setLocalDescription(answer);
      
      // Send answer to server
      if (this.wsSubject$ && !this.wsSubject$.closed) {
        this.wsSubject$.next({
          event: EVENT.SIGNAL.ANSWER,
          sdp: answer.sdp,
          displayname: this.displayName
        });
      }
      
      return answer;
    } catch (error) {
      console.error('Failed to process offer or create answer', error);
      throw error;
    }
  }  

  /**
   * Set remote answer - aligned with base.ts implementation
   */
  public async setRemoteAnswer(sdp: string) {
    if (!this.pc) {
      console.warn('Attempting to set remote answer while disconnected');
      return;
    }

    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      
    } catch (error) {
      console.error('Failed to set remote answer:', error);
      throw error;
    }
  }

  /**
   * Process any pending ICE candidates that were received before the remote description was set
   */
  private async processPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription || this.candidates.length === 0) {
      return;
    }

    console.log(`Processing ${this.candidates.length} stored ICE candidates`);
    
    const processCandidates = [...this.candidates];
    this.candidates = []; // Clear the candidates array to avoid processing them multiple times
    
    for (const candidate of processCandidates) {
      try {        
        await this.pc.addIceCandidate(candidate);
      } catch (error: any) {
        console.error('Failed to add stored ICE candidate:', error, candidate);
        // Re-add the candidate if it failed due to temporary state issue
        if (error.name === 'OperationError' && this.pc.signalingState !== 'closed') {
          this.candidates.push(candidate);
        }
      }
    }
  }

  /**
   * Handle WebSocket message - optimized to match base.ts implementation
   */  private async handleWebSocketMessage(e: MessageEvent) {
    if (!e || !e.data) {
      console.warn('Received malformed WebSocket message', e);
      return;
    }
    
    let event: string;
    let payload: any;
    let parsedData: any;
    let rawData = e.data;
    
    try {
      // Check if data is already an object (sometimes WebSocketSubject will parse JSON)
      if (typeof rawData === 'object' && rawData !== null) {
        parsedData = rawData;
      } else if (typeof rawData === 'string') {
        // Log raw message for debugging
        if (rawData.includes('control/locked') || 
            rawData.includes('control/request') || 
            rawData.includes('control/release')) {
          console.debug('Raw WebSocket control message:', rawData);
        }
        
        try {
          parsedData = JSON.parse(rawData) as WebSocketMessages;
        } catch (parseError) {
          console.error('JSON parse error:', parseError, rawData);
          return;
        }
      } else {
        console.warn('Unknown WebSocket message format', rawData);
        return;
      }
      
      event = parsedData.event;
      
      // Extract the rest of the properties as payload
      if (parsedData) {
        const { event: _, ...rest } = parsedData;
        payload = rest;
      }
      
      if (!event) {
        console.warn('Received WebSocket message without event:', parsedData);
        return;
      }
    } catch (error) {
      console.error('Failed to process WebSocket message:', error, rawData);
      return;
    }

    console.debug('Received WebSocket message:', event, payload);
    
    // Special case for SYSTEM.INIT message
    if (event === EVENT.SYSTEM.INIT) {
      try {
        this.handleSystemInitMessage(payload);
      } catch (error) {
        console.error('Failed to handle system/init:', error, payload);
      }
      return;
    }
    
    // Handle core WebRTC signaling messages directly, similar to base.ts onMessage
    if (event === EVENT.SIGNAL.PROVIDE) {
      try {
        const { sdp, lite, ice: servers, id } = payload as SignalProvidePayload;
        this.sessionId = id || null;
        await this.createPeer(lite, servers || this.iceServers);
        if (sdp) {
          await this.setRemoteOffer(sdp);
        }
      } catch (error) {
        console.error('Failed to handle signal/provide:', error, payload);
      }
      return;
    }

    if (event === EVENT.SIGNAL.OFFER) {
      try {
        const { sdp } = payload as SignalOfferPayload;
        if (sdp) {
          await this.setRemoteOffer(sdp);
        }
      } catch (error) {
        console.error('Failed to handle signal/offer:', error, payload);
      }
      return;
    }

    if (event === EVENT.SIGNAL.ANSWER) {
      try {
        const { sdp } = payload as SignalAnswerMessage;
        if (sdp) {
          await this.setRemoteAnswer(sdp);
        }
      } catch (error) {
        console.error('Failed to handle signal/answer:', error, payload);
      }
      return;
    }

    if (event === EVENT.SIGNAL.CANDIDATE) {
      try {
        const { data } = payload as SignalCandidatePayload;
        if (data && typeof data === 'string') {
          let candidate: RTCIceCandidate;
          try {
            candidate = JSON.parse(data);
          } catch (parseError) {
            console.error('Failed to parse ICE candidate data:', parseError, data);
            return;
          }
          
          if (this.pc) {
            if (this.pc.remoteDescription) {
              // Only add candidate if remote description is set
              console.debug('Adding ICE candidate immediately');
              try {
                await this.pc.addIceCandidate(candidate);
              } catch (addError) {
                console.error('Failed to add ICE candidate:', addError);
                
                // If we get an invalid state error, store the candidate for later
                if ((addError as Error).name === 'InvalidStateError') {
                  this.candidates.push(candidate);
                  console.debug('Stored ICE candidate for later use due to invalid state');
                }
              }
            } else {
              // Store candidate for later use
              this.candidates.push(candidate);
              console.debug('Stored ICE candidate for later use - no remote description');
            }
          } else {
            console.warn('Received ICE candidate but no RTCPeerConnection exists');
          }
        }
      } catch (error) {
        console.error('Failed to handle signal/candidate:', error, payload);
      }
      return;
    }

    // For specific events like clipboard, call the event handler method
    if (event === EVENT.CONTROL.CLIPBOARD) {
      this.handlecontrol_clipboard(payload as ControlClipboardPayload);
      return;
    }

    // For other events, try to find a handler method
    // const eventHandler = `handle${event.replace('/', '_')}` as keyof WebRtcService;
    // if (typeof this[eventHandler] === 'function') {
    //   (this[eventHandler] as Function)(e);
    // } else {
    //   // For unhandled events, log a warning
    //   console.warn(`Unhandled websocket event '${event}':`, e);
    // }    // Handle control-related events directly
    if (event.startsWith('control/')) {
      console.log(`Handling control event: ${event}`, payload);
      
      // Special case for handling control events
      switch (event) {
        case EVENT.CONTROL.LOCKED:
          this[EVENT.CONTROL.LOCKED](payload);
          break;
        case EVENT.CONTROL.RELEASE:
          this[EVENT.CONTROL.RELEASE](payload);
          break;
        case EVENT.CONTROL.REQUESTING:
          this[EVENT.CONTROL.REQUESTING]?.(payload);
          break;
        case EVENT.CONTROL.GIVE:
          this[EVENT.CONTROL.GIVE](payload);
          break;
        case EVENT.CONTROL.REQUEST:
          this[EVENT.CONTROL.REQUEST](payload);
          break;
        case EVENT.CONTROL.CLIPBOARD:
          // Already handled above
          break;
        default:
          console.warn(`Unknown control event: ${event}`, payload);
      }
      return;
    }
    
    // Try bracket notation for other events
    try {
      // @ts-ignore
      if (typeof this[event] === 'function') {
        // @ts-ignore
        this[event](payload);
      } else {
        this[EVENT.MESSAGE](event, payload);
      }
    } catch (error) {
      console.error(`Error handling event ${event}:`, error);
      this[EVENT.MESSAGE](event, payload);
    }
    
    // Forward message to subscribers
    this.messagesSubject$.next(e);
  }  

  /**
   * Handle the MESSAGE event for unhandled WebSocket events
   * @param event Event type
   * @param payload Event payload
   */
  protected [EVENT.MESSAGE](event: string, payload: any) {
    console.warn(`Unhandled websocket event '${event}':`, payload);
  }
  /**
   * Handle the system/init message
   * @param message System init message
   */
  private handleSystemInitMessage(message: any) {
    console.log('Received system/init message:', message);
    
    const { session_id, heartbeat_interval, locks } = message;
    
    // Update session ID
    if (session_id) {
      this.sessionId = session_id;
    }
    
    // Handle heartbeat interval setting
    if (heartbeat_interval && typeof heartbeat_interval === 'number') {
      // Use server-specified heartbeat interval if provided
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
      
      const intervalMs = heartbeat_interval * 1000;
      console.log(`Setting heartbeat interval to ${intervalMs}ms`);
      
      this.heartbeatInterval = setInterval(() => {
        this.sendMessage(EVENT.CLIENT.HEARTBEAT);
      }, intervalMs);
    }
    
    // Handle control locks if provided
    if (locks) {
      if (locks.keyboard || locks.mouse) {
        // If keyboard or mouse is locked, update control locked status
        this.controlLockedSubject$.next(true);
      }
      
      // Handle other lock types if needed
      if (locks.clipboard) {
        console.log('Clipboard access is locked by server');
      }
    }
    
    console.log('System initialized with session ID:', this.sessionId);
  }

  /**
   * Start the heartbeat to keep the connection alive
   */
  private startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      this.sendMessage(EVENT.CLIENT.HEARTBEAT);
    }, 30000); // Send heartbeat every 30 seconds
  }  /**
   * Send a message over the WebSocket
   * @param event The event type
   * @param payload Optional payload
   * @returns boolean indicating if the message was sent
   */
  public sendMessage(event: string, payload?: any): boolean {
    if (!this.wsSubject$ || this.wsSubject$.closed) {
      console.warn('Cannot send message, WebSocket not connected');
      return false;
    }
    
    try {
      const message = payload ? { event, ...payload } : { event };
      console.debug(`Sending WebSocket message: ${event}`, payload || '');
      this.wsSubject$.next(message);
      return true;
    } catch (error) {
      console.error('Failed to send WebSocket message:', error);
      return false;
    }
  }
  
  /**
   * Handle the control/clipboard event - receives clipboard text from server
   * @param payload Clipboard payload from server
   */
  protected handlecontrol_clipboard(payload: { text: string }) {
    // Forward to the EVENT.CONTROL.CLIPBOARD handler
    this[EVENT.CONTROL.CLIPBOARD](payload);
  }

  protected [EVENT.CONNECTING]() {
    console.log('Connecting to WebRTC server...');
  }

  protected [EVENT.CONNECTED]() {
    console.log('Connected to WebRTC server');
    this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
  }
  protected [EVENT.DISCONNECTED](reason?: Error) {
    console.log('Disconnected from WebRTC server', reason);
    this.connectionStatusSubject$.next(false);
  }
  
  protected [EVENT.TRACK](event: RTCTrackEvent) {
    console.log(`Received ${event.track.kind} track from peer: ${event.track.id}`);
    this.trackSubject$.next(event);
  }
  protected [EVENT.DATA](event: MessageEvent) {
    // Process binary data from data channel
    console.log('Received data channel message', event.data);
  }
  
  /**
   * Send binary data for input control - aligned with base.ts sendData
   * @param event Event type (wheel, mousemove, mousedown, mouseup, keydown, keyup)
   * @param data Event data (coordinates or key codes)
   */
  public sendData(event: 'wheel' | 'mousemove', data: { x: number; y: number }): void;
  public sendData(event: 'mousedown' | 'mouseup' | 'keydown' | 'keyup', data: { key: number }): void;
  public sendData(event: string, data: any) {
    if (!this.connected || !this.dataChannel) {
      console.warn('Attempting to send data while disconnected');
      return;
    }

    let buffer: ArrayBuffer;
    let payload: DataView;
    
    switch (event) {
      case 'mousemove':
        buffer = new ArrayBuffer(7);
        payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.MOVE);
        payload.setUint16(1, 4, true);
        payload.setUint16(3, data.x, true);
        payload.setUint16(5, data.y, true);
        break;
      case 'wheel':
        buffer = new ArrayBuffer(7);
        payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.SCROLL);
        payload.setUint16(1, 4, true);
        payload.setInt16(3, data.x, true);
        payload.setInt16(5, data.y, true);
        break;
      case 'keydown':
      case 'mousedown':
        buffer = new ArrayBuffer(11);
        payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.KEY_DOWN);
        payload.setUint16(1, 8, true);
        payload.setBigUint64(3, BigInt(data.key), true);
        break;
      case 'keyup':
      case 'mouseup':
        buffer = new ArrayBuffer(11);
        payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.KEY_UP);
        payload.setUint16(1, 8, true);
        payload.setBigUint64(3, BigInt(data.key), true);
        break;
      default:
        console.warn(`Unknown data event: ${event}`);
        return;
    }

    // Send the binary data through the data channel
    this.dataChannel.send(buffer);
  }
  /**
   * Connect to WebSocket server
   * @param wsUrl WebSocket URL
   */
  private connectToWebSocket(wsUrl: string) {
    // Only create a new socket if not already open
    if (!this.wsSubject$ || this.wsSubject$.closed) {
      console.log('Connecting to WebSocket server:', wsUrl);
      
      try {
        // Create new WebSocket connection using native WebSocket instead of rxjs webSocket
        const socket = new WebSocket(wsUrl);
        
        // Set up event handlers
        socket.onopen = () => {
          console.log('WebSocket connection opened');
          this.connectionStatusSubject$.next(true);
          this[EVENT.CONNECTED]();
        };
        
        socket.onclose = (event) => {
          console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
          this.connectionStatusSubject$.next(false);
          
          // Attempt to reconnect if unexpected close
          if (event.code !== 1000) { // Normal closure
            this.attemptReconnect();
          }
        };
        
        socket.onerror = (error) => {
          console.error('WebSocket error:', error);
        };
        
        socket.onmessage = (event) => {
          this.handleWebSocketMessage(event);
        };
        
        // Create a Subject that wraps our WebSocket
        this.wsSubject$ = {
          next: (data: any) => {
            if (socket.readyState === WebSocket.OPEN) {
              const message = JSON.stringify(data);
              console.debug('Sending WebSocket message:', data);
              socket.send(message);
            } else {
              console.warn('Attempted to send message but WebSocket is not open');
            }
          },
          complete: () => {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
              socket.close(1000, 'Normal closure');
            }
          },
          error: (err: any) => {
            console.error('WebSocket error:', err);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
              socket.close(1011, 'Internal error');
            }
          },
          closed: false
        } as WebSocketSubject<any>;
      } catch (error) {
        console.error('Failed to create WebSocket connection:', error);
        this.connectionStatusSubject$.next(false);
      }
    }
  }
  
  /**
   * Attempt to reconnect after a connection failure
   */
  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      this[EVENT.DISCONNECTED](new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    // Clear any existing timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Exponential backoff for reconnect
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    
    this.reconnectTimeout = setTimeout(() => {
      if (this.sessionId) {
        // Try reconnecting with existing session
        // Implement reconnection logic here
      }
    }, delay);
  }
  /**
   * Disconnect WebSocket connection
   */
  private closeWebSocket() {
    if (this.wsSubject$) {
      try {
        this.wsSubject$.complete();
      } catch (error) {
        console.warn('Error closing WebSocket:', error);
      }
      this.wsSubject$ = null;
    }
    
    // Reset connection state
    this.connectionStatusSubject$.next(false);
  }

  /**
   * Close all WebRTC and WebSocket connections
   */
  close() {
    if (this.pc) { 
      this.pc.close(); 
      this.pc = null; 
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    this.closeWebSocket();
    this._state = 'disconnected';
  }
  ngOnDestroy(): void {
    this.close();
    this.messagesSubject$.complete();
    this.connectionStatusSubject$.complete();
    this.trackSubject$.complete();
    this.controlStatusSubject$.complete();
    this.clipboardSubject$.complete();
    this.controlLockedSubject$.complete();
    this.controllerIdSubject$.complete();
  }
  /**
   * Handle the control/clipboard message from server
   * @param message Clipboard message containing text
   */
  protected [EVENT.CONTROL.CLIPBOARD](message: { text: string }) {
    const { text } = message;
    
    if (!text || typeof text !== 'string') {
      console.warn('Invalid clipboard data received:', message);
      return;
    }
    
    // Update clipboard content in our subject
    this.clipboardSubject$.next(text);
    
    // Try to write to clipboard if possible and the browser supports it
    if (this.navigator.clipboard && typeof this.navigator.clipboard.writeText === 'function') {
      this.navigator.clipboard.writeText(text)
        .then(() => {
          console.log('Successfully wrote to clipboard from server data');
        })
        .catch(err => {
          console.warn('Failed to write to clipboard:', err);
        });
    } else {
      console.warn('Clipboard API not available. Cannot automatically update clipboard.');
    }
    
    console.log('Received clipboard content from server');
  }
  /**
   * Send clipboard content to the server
   * @param text Clipboard text to send
   * @returns boolean indicating success
   */
  public sendClipboardText(text: string): boolean {
    if (!this.connected) {
      console.warn('Cannot send clipboard text while disconnected');
      return false;
    }
    
    try {
      // Update local clipboard state
      this.clipboardSubject$.next(text);
      
      // Send to server
      this.sendMessage(EVENT.CONTROL.CLIPBOARD, { text });
      
      // Attempt to write to local clipboard as well
      if (this.navigator.clipboard && typeof this.navigator.clipboard.writeText === 'function') {
        this.navigator.clipboard.writeText(text).catch(err => {
          console.warn('Failed to write to local clipboard:', err);
        });
      }
      
      return true;
    } catch (err) {
      console.error('Error sending clipboard text:', err);
      return false;
    }
  }
  /**
   * Handle the control/locked event - control is locked by an admin
   * @param payload Control locked payload
   */
  protected [EVENT.CONTROL.LOCKED](payload: { id?: string }) {
    // Set lock status
    this.controlLockedSubject$.next(true);
    
    // If there's an ID provided, that user has control now
    if (payload.id) {
      this.controllerIdSubject$.next(payload.id);
      
      // If we received our own ID, we have control
      if (payload.id === this.sessionId) {
        this.controlStatusSubject$.next(true);
        console.log('We have control and locked it');
      } else {
        // Someone else has control
        if (this.controlStatusSubject$.getValue()) {
          // We had control but lost it
          this.controlStatusSubject$.next(false);
        }
        console.log('Control locked by:', payload.id);
      }
    } else {
      console.log('Control locked by admin');
    }
  }

  /**
   * Handle the control/release event - control is released
   * @param payload Control release payload
   */
  protected [EVENT.CONTROL.RELEASE](payload: { id?: string }) {
    if (!payload.id || payload.id === this.sessionId) {
      // We lost control
      this.controlStatusSubject$.next(false);
    }
    
    // Control is available
    this.controllerIdSubject$.next('');
    console.log('Control released', payload);
  }

  /**
   * Handle the control/requesting event - someone is requesting control
   * @param payload Control requesting payload
   */
  protected [EVENT.CONTROL.REQUESTING](payload: { id: string }) {
    // Someone is requesting control
    console.log('Control requested by', payload.id);
    // Could implement a notification system here to show who is requesting control
  }

  /**
   * Handle the control/give event - we've been given control
   * @param payload Control give payload
   */
  protected [EVENT.CONTROL.GIVE](payload: { id: string }) {
    if (payload.id === this.sessionId) {
      // We got control
      this.controlStatusSubject$.next(true);
      console.log('Control given to us');
    } else {
      // Someone else got control
      this.controllerIdSubject$.next(payload.id);
      console.log('Control given to', payload.id);
    }
  }

  /**
   * Handle the control/request event - when a user requests control
   * @param payload Control request payload
   */  protected [EVENT.CONTROL.REQUEST](payload: { id?: string }) {
    if (payload.id === this.sessionId) {
      // We received confirmation that we have control
      this.controlStatusSubject$.next(true);
      console.log('We have been granted control');
    } else if (payload.id) {
      // Someone else has control now
      this.controllerIdSubject$.next(payload.id);
      console.log('Control given to:', payload.id);
    }
    
    // Log complete control state for debugging
    console.log('=== Control State ===');
    console.log('Has control:', this.controlStatusSubject$.getValue());
    console.log('Control locked:', this.controlLockedSubject$.getValue());
    console.log('Controller ID:', this.controllerIdSubject$.getValue());
    console.log('Session ID:', this.sessionId);
    console.log('===================');
  }
}
