import { Injectable, signal } from '@angular/core';

/**
 * Whether the chat's own rail of conversations is showing.
 *
 * Root state rather than a field on the chat component, because the HEADER's menu button lives in
 * the layout and has to open that rail: on `/chatai` the platform sidebar is not rendered, so a
 * button bound to that sidebar would be dead on the one route where a menu matters most.
 *
 * One signal, written by both sides and read by the chat. There is no second copy, so the button
 * and the rail cannot disagree about whether the menu is open.
 */
@Injectable({ providedIn: 'root' })
export class ChatRailService {
    /** The rail's visibility. Open by default: it is the page's only index. */
    readonly open = signal(true);

    /** Flip it, for every control that is a toggle rather than an open/close. */
    toggle(): void {
        this.open.update(open => !open);
    }
}
