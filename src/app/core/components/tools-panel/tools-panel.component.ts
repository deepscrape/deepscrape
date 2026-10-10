import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { ToolEnvelope } from '../../types';
import { WebrainToolsService } from '../../services';
import { StinputComponent } from '../stinput/stinput.component';
import {
  ResultEnvelopeComponent,
  ResultEnvelopeState,
} from '../result-envelope/result-envelope.component';
import { smoothfadeAnimation } from 'src/app/animations';

/** How one field renders. Five kinds cover every argument the three tools take. */
export type ToolFieldKind = 'text' | 'select' | 'number' | 'json' | 'flag';

/** One argument, as data. */
export interface ToolField {
  /** The HTTP surface's field name, which is not always the worker's. */
  readonly name: string;
  readonly label: string;
  readonly kind: ToolFieldKind;
  /** Required unconditionally. */
  readonly required?: boolean;
  /** The accepted values, for a `select`. Copied from the gateway's own list. */
  readonly options?: readonly string[];
  readonly hint?: string;
  /** Visible only when `modeField` holds one of these. */
  readonly whenMode?: readonly string[];
  /** Required only when `modeField` holds one of these. */
  readonly requiredWhenMode?: readonly string[];
}

/** One tool route, as data. */
export interface ToolDescriptor {
  readonly id: string;
  /** The route path under `/api`. */
  readonly path: string;
  readonly label: string;
  readonly note: string;
  /** The field whose value gates every `whenMode` / `requiredWhenMode`. */
  readonly modeField?: string;
  readonly fields: readonly ToolField[];
}

/**
 * The descriptor table.
 *
 * The vocabularies below are copied from the GATEWAY, not invented:
 * `functions/src/handlers/webrain-tools.ts` holds `SEARCH_ENGINES`,
 * `EXTRACT_MODES`, `PDF_OPS` and `EXTRACT_MAX_TOP_K`, and each of those lists in
 * turn came from the worker's own `inputSchema`. They are duplicated here
 * because the gateway exposes no endpoint that reports them, and a picker is
 * worth more than a free-text box that earns a 400. A `tools-panel.spec.ts`
 * pins the two copies together so a drift is a failing test rather than a
 * mystery 400.
 *
 * `note` is load-bearing, not decoration. Two of these three tools cannot
 * succeed for most callers, and the reason is a property of the worker rather
 * than of this form, so the panel says it before the call rather than letting
 * the user discover it in a 502:
 *
 *  - `extract` reads the CURRENT PAGE of a browser session. It refuses `url`
 *    outright, and `webrain_session` is a paid-only tool, so on the shared pool
 *    it answers `502 -- Needs a private worker; the shared pool holds no
 *    sessions`.
 *  - `pdf` takes `path` / `paths`, which are paths on or reachable from the
 *    WORKER. The platform has no upload route, so there is nothing a caller can
 *    do to put a file where this tool can read it.
 */
const SEARCH_TOOL: ToolDescriptor = {
  id: 'search',
  path: '/search',
  label: 'TOOLS.TAB_SEARCH',
  note: 'TOOLS.NOTE_SEARCH',
  fields: [
    { name: 'q', label: 'TOOLS.FIELD_QUERY', kind: 'text', required: true },
    {
      name: 'engine',
      label: 'TOOLS.FIELD_ENGINE',
      kind: 'select',
      options: ['duckduckgo', 'google', 'bing', 'brave'],
      hint: 'TOOLS.HINT_ENGINE_SEARCH',
    },
  ],
};

const EXTRACT_TOOL: ToolDescriptor = {
  id: 'extract',
  path: '/extract',
  label: 'TOOLS.TAB_EXTRACT',
  note: 'TOOLS.NOTE_EXTRACT',
  modeField: 'mode',
  fields: [
    {
      name: 'mode',
      label: 'TOOLS.FIELD_MODE',
      kind: 'select',
      required: true,
      options: ['schema', 'regex', 'jsonld', 'table', 'autoschema', 'bm25'],
    },
    {
      name: 'selector',
      label: 'TOOLS.FIELD_SELECTOR',
      kind: 'text',
      hint: 'TOOLS.HINT_SELECTOR',
      requiredWhenMode: ['schema'],
    },
    {
      name: 'schema',
      label: 'TOOLS.FIELD_SCHEMA',
      kind: 'json',
      hint: 'TOOLS.HINT_SCHEMA',
      whenMode: ['schema'],
    },
    {
      name: 'query',
      label: 'TOOLS.FIELD_QUERY',
      kind: 'text',
      requiredWhenMode: ['bm25'],
    },
    {
      name: 'patterns',
      label: 'TOOLS.FIELD_PATTERNS',
      kind: 'json',
      hint: 'TOOLS.HINT_PATTERNS',
      whenMode: ['regex'],
    },
    { name: 'top_k', label: 'TOOLS.FIELD_TOP_K', kind: 'number', hint: 'TOOLS.HINT_TOP_K' },
    { name: 'adaptive', label: 'TOOLS.FIELD_ADAPTIVE', kind: 'flag' },
  ],
};

const PDF_TOOL: ToolDescriptor = {
  id: 'pdf',
  path: '/pdf',
  label: 'TOOLS.TAB_PDF',
  note: 'TOOLS.NOTE_PDF',
  modeField: 'op',
  fields: [
    {
      name: 'op',
      label: 'TOOLS.FIELD_OP',
      kind: 'select',
      required: true,
      options: ['page', 'extract', 'render', 'images'],
    },
    {
      name: 'path',
      label: 'TOOLS.FIELD_PATH',
      kind: 'text',
      hint: 'TOOLS.HINT_PATH',
      whenMode: ['extract', 'render', 'images'],
      requiredWhenMode: ['extract', 'render', 'images'],
    },
    {
      name: 'paths',
      label: 'TOOLS.FIELD_PATHS',
      kind: 'json',
      hint: 'TOOLS.HINT_PATHS',
      whenMode: ['extract', 'render', 'images'],
    },
    { name: 'pages', label: 'TOOLS.FIELD_PAGES', kind: 'json', hint: 'TOOLS.HINT_PAGES' },
    { name: 'dpi', label: 'TOOLS.FIELD_DPI', kind: 'number' },
    { name: 'tile_size', label: 'TOOLS.FIELD_TILE', kind: 'number' },
  ],
};

/**
 * `webrain_vision` -- local vision over screenshot pixels.
 *
 * The only PAID route in this panel, and the note carries that rather than an
 * entitlement field on the descriptor. That is the convention this file already
 * set: `extract` and `pdf` also cannot succeed for most callers, and both say so
 * in `note` before the call instead of in a 502 after it. A free caller
 * selecting this tab gets `402` from the `paid` guard, so the note has to name
 * it or the panel looks broken.
 *
 * `op=ask` runs on the worker's bundled model, so no screenshot leaves the
 * worker and no cloud key is involved. `index` holds a named tile index on the
 * worker BETWEEN calls, which is why the guard is `paid` and not `access`.
 */
const VISION_TOOL: ToolDescriptor = {
  id: 'vision',
  path: '/vision',
  label: 'TOOLS.TAB_VISION',
  note: 'TOOLS.NOTE_VISION',
  modeField: 'op',
  fields: [
    {
      name: 'op',
      label: 'TOOLS.FIELD_OP',
      kind: 'select',
      required: true,
      options: ['index', 'retrieve', 'ask'],
    },
    {
      name: 'prompt',
      label: 'TOOLS.FIELD_PROMPT',
      kind: 'text',
      requiredWhenMode: ['ask'],
    },
    {
      name: 'query',
      label: 'TOOLS.FIELD_QUERY',
      kind: 'text',
      requiredWhenMode: ['retrieve'],
    },
    { name: 'tag', label: 'TOOLS.FIELD_TAG', kind: 'text' },
    {
      name: 'scale',
      label: 'TOOLS.FIELD_SCALE',
      kind: 'number',
      whenMode: ['ask'],
      hint: 'TOOLS.HINT_SCALE',
    },
  ],
};

/**
 * One hint per field, keyed by `<tool>.<field>`.
 *
 * A MAP rather than a `hint` on each descriptor row. That table is pinned against
 * the gateway's own vocabularies by `tools-panel.spec.ts` and is meant to mirror it
 * row for row; the copy a user reads is a different concern from the arguments the
 * gateway accepts. Keying by tool AND field is load-bearing: `query` is a BM25 term
 * on `extract` and a retrieval question on `vision`, so a map keyed by field name
 * alone would hand one of them the other's text.
 *
 * Every visible field must have an entry. Unexplained argument names are what made
 * this panel hard to use: `top_k`, `dpi` and `tile_size` are not self-evident, and a
 * hint costs less than the error message it prevents.
 */
const TOOL_FIELD_HINTS: Record<string, string> = {
  'search.q': 'TOOLS.HINT_Q_SEARCH',
  'search.engine': 'TOOLS.HINT_ENGINE_SEARCH',
  'extract.mode': 'TOOLS.HINT_MODE',
  'extract.selector': 'TOOLS.HINT_SELECTOR',
  'extract.schema': 'TOOLS.HINT_SCHEMA',
  'extract.query': 'TOOLS.HINT_QUERY_BM25',
  'extract.patterns': 'TOOLS.HINT_PATTERNS',
  'extract.top_k': 'TOOLS.HINT_TOP_K',
  'extract.adaptive': 'TOOLS.HINT_ADAPTIVE',
  'pdf.op': 'TOOLS.HINT_OP_PDF',
  'pdf.path': 'TOOLS.HINT_PATH',
  'pdf.paths': 'TOOLS.HINT_PATHS',
  'pdf.pages': 'TOOLS.HINT_PAGES',
  'pdf.dpi': 'TOOLS.HINT_DPI',
  'pdf.tile_size': 'TOOLS.HINT_TILE',
  'vision.op': 'TOOLS.HINT_OP_VISION',
  'vision.prompt': 'TOOLS.HINT_PROMPT',
  'vision.query': 'TOOLS.HINT_QUERY_VISION',
  'vision.tag': 'TOOLS.HINT_TAG',
  'vision.scale': 'TOOLS.HINT_SCALE',
};

/** Every tool, in strip order. */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  SEARCH_TOOL,
  EXTRACT_TOOL,
  PDF_TOOL,
  VISION_TOOL,
];

/**
 * The raw webrain tool routes, in one panel.
 *
 * Why a descriptor table rather than three forms
 * ---------------------------------------------
 * `/search`, `/extract` and `/pdf` share one gateway tail and one envelope, so
 * the differences between them are their arguments. Arguments as data means the
 * renderer is written once and a field is added by adding a row, rather than by
 * editing a template that then diverges from its siblings.
 *
 * Why the output is raw JSON
 * --------------------------
 * The worker's payload is the contract and the gateway passes it through
 * unchanged rather than re-modelling it (its own comment says so). A bespoke
 * renderer per tool would be the drift that comment exists to prevent, and it
 * would have to be rewritten every time the worker changes a field. So the
 * reply is pretty-printed and labelled, and `webrain-tools.interface.ts`
 * deliberately types `data` as `unknown` rather than guessing its shape.
 */
@Component({
  selector: 'app-tools-panel',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    TranslateModule,
    StinputComponent,
    ResultEnvelopeComponent,
  ],
  templateUrl: './tools-panel.component.html',
  styleUrl: './tools-panel.component.scss',
  // The repository's own `* <=> *` trigger, reused rather than re-declared: it is
  // the same one the settings shell and the playground shell animate their child
  // route with, and binding the active tool id to it replays the form on a switch.
  animations: [smoothfadeAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolsPanelComponent {
  @HostBinding('class') classes = 'flex items-center flex-col relative w-full';

  private readonly tools = inject(WebrainToolsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Every tab. */
  readonly descriptors = TOOL_DESCRIPTORS;

  readonly active = signal<ToolDescriptor>(SEARCH_TOOL);

  /**
   * What each tool needs before it runs, and what a call costs.
   *
   * Two axes on purpose. `credits` is from
   * `functions/src/domain/billing-pricing.domain.ts`: these three routes are
   * registered with `resolveAccess`, not `requirePaidAccess`, so the CALL is
   * free on every plan. What `extract` and `pdf` need is not credits but a
   * private worker -- `extract` reads the current page of a browser session and
   * `pdf` reads a path on the worker, so on the shared pool neither can be
   * attributed to a caller. Collapsing that into one "tier" word would hide the
   * axis that actually gates them.
   *
   * Lease prices are from the same table and stated in `TOOLS.LEASE_COST`:
   * `POST /machines/deploy` is 5 credits, `start`/`suspend`/`stop` are 1 each,
   * `DELETE` is 2.
   */
  readonly costs: Record<string, { requires: 'free' | 'lease'; credits: number }> = {
    search: { requires: 'free', credits: 0 },
    extract: { requires: 'lease', credits: 0 },
    pdf: { requires: 'lease', credits: 0 },
  };

  /**
   * One string control per visible field, per tool.
   *
   * `FormControl<string>` even for numbers and flags, which is the repository's
   * convention for `StinputComponent` and keeps one control type across the
   * renderer: a number is parsed once at submit, and a flag is the string
   * `'true'` or `''`. Mixing `FormControl<number>` in would mean a union at
   * every binding site for no gain.
   */
  private readonly controls = signal<Record<string, FormControl<string>>>(this.buildControls(SEARCH_TOOL));

  readonly state = signal<ResultEnvelopeState>('idle');
  readonly envelope = signal<ToolEnvelope | null>(null);
  readonly errorMessage = signal('');
  /** An i18n key for a form-level problem, e.g. unparseable JSON. */
  readonly formError = signal('');

  /** The live value of the tool's mode field, which gates conditional fields. */
  private modeValue(): string {
    const field = this.active().modeField;
    return field ? this.controlFor(field).value : '';
  }

  /**
   * The fields to render for the current mode, in table order.
   *
   * A METHOD rather than a `computed`, and that is load-bearing. The only thing
   * it depends on that changes is a `FormControl`'s value, which is NOT a
   * signal: a `computed` would depend on `active()` and `controls()` alone and
   * would therefore cache the mode it first saw. The conditional fields would
   * never appear or disappear, which looks like a broken picker rather than a
   * stale memo. Recomputing per change-detection pass is the honest cost.
   * @return {ToolField[]} The fields to render.
   */
  visibleFields(): ToolField[] {
    const mode = this.modeValue();
    return this.active().fields.filter(field => !field.whenMode || field.whenMode.includes(mode));
  }

  /** Whether the last successful reply has anything to show. */
  readonly pretty = computed(() => {
    const reply = this.envelope();
    return reply ? JSON.stringify(reply.data ?? reply, null, 2) : '';
  });

  /** Header chips: what the worker reported about its own call. */
  readonly meta = computed(() => {
    const reply = this.envelope();
    if (!reply) {
      return [];
    }
    const chips = [];
    if (typeof reply.tokens === 'number') {
      chips.push({ label: 'TOOLS.META_TOKENS', value: String(reply.tokens), tone: 'neutral' as const });
    }
    if (typeof reply.ms === 'number') {
      chips.push({ label: 'TOOLS.META_MS', value: String(reply.ms), tone: 'neutral' as const });
    }
    return chips;
  });

  /** Only a transport failure is worth retrying; a refusal will refuse again. */
  get showRetry(): boolean {
    return this.state() === 'error' && this.envelope()?.transportError === true;
  }

  get busy(): boolean {
    return this.state() === 'loading';
  }

  /**
   * Switch tool.
   *
   * Resets the reply and the controls: a `mode` from `extract` means nothing to
   * `pdf`, and leaving a stale payload on screen under a new tool's heading
   * would read as that tool's answer.
   * @param {ToolDescriptor} descriptor The tab that was chosen.
   * @return {void}
   */
  selectTool(descriptor: ToolDescriptor): void {
    if (this.active().id === descriptor.id) {
      return;
    }
    this.active.set(descriptor);
    this.controls.set(this.buildControls(descriptor));
    this.reset();
  }

  /** The control for one field, created on demand so a template never sees null.
   * @param {string} name The field name.
   * @return {FormControl<string>} The control.
   */
  controlFor(name: string): FormControl<string> {
    const existing = this.controls()[name];
    return existing ?? new FormControl('', { nonNullable: true });
  }

  /** Whether a field is required in the current mode.
   * @param {ToolField} field The field.
   * @return {boolean} True when a value must be supplied.
   */
  isRequired(field: ToolField): boolean {
    if (field.required) {
      return true;
    }
    const mode = this.modeValue();
    return Boolean(field.requiredWhenMode?.includes(mode));
  }

  /** Toggle a `flag` field, which is stored as the string `'true'` or `''`.
   * @param {string} name The field name.
   * @param {boolean} checked The new state.
   * @return {void}
   */
  setFlag(name: string, checked: boolean): void {
    this.controlFor(name).setValue(checked ? 'true' : '');
  }

  /** Read a `flag` field.
   * @param {string} name The field name.
   * @return {boolean} Whether it is on.
   */
  isFlagOn(name: string): boolean {
    return this.controlFor(name).value === 'true';
  }

  /**
   * The hint for one field, as an i18n key.
   *
   * Returns `''` rather than throwing when a field has no entry, so a descriptor
   * row added without a hint renders plainly instead of blanking the panel. The
   * spec asserts every field of every tool HAS an entry, which is what keeps the
   * map from drifting away from the table it describes.
   * @param {ToolField} field The field.
   * @return {string} The hint key, or an empty string.
   */
  hintFor(field: ToolField): string {
    return TOOL_FIELD_HINTS[`${this.active().id}.${field.name}`] ?? '';
  }

  /**
   * Build the body and send it.
   *
   * Every value is mapped ONCE here rather than at each binding site: text
   * trimmed, a number parsed, JSON parsed, a blank optional field omitted. An
   * omitted optional field matters -- the gateway refuses `limit` on `/search`
   * precisely because a silently dropped argument looks accepted and does
   * nothing, so sending only what the user filled in is the contract, not
   * tidiness.
   * @return {void}
   */
  submit(): void {
    if (this.busy) {
      return;
    }

    const body: Record<string, unknown> = {};
    this.formError.set('');

    for (const field of this.visibleFields()) {
      const control = this.controlFor(field.name);
      const raw = control.value.trim();

      if (field.kind === 'flag') {
        if (raw === 'true') {
          body[field.name] = true;
        }
        continue;
      }

      if (!raw) {
        if (this.isRequired(field)) {
          control.markAsTouched();
          this.formError.set('TOOLS.FORM_REQUIRED');
          return;
        }
        continue;
      }

      if (field.kind === 'json') {
        try {
          body[field.name] = JSON.parse(raw);
        } catch {
          control.markAsTouched();
          this.formError.set('TOOLS.FORM_BAD_JSON');
          return;
        }
        continue;
      }

      if (field.kind === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          control.markAsTouched();
          this.formError.set('TOOLS.FORM_BAD_NUMBER');
          return;
        }
        body[field.name] = parsed;
        continue;
      }

      body[field.name] = raw;
    }

    this.state.set('loading');
    this.errorMessage.set('');

    this.tools[this.active().id as 'search' | 'extract' | 'pdf'](body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => this.apply(reply),
        error: (error: HttpErrorResponse) => this.applyFailure(error),
      });
  }

  /** Re-run the same submission. */
  retry(): void {
    this.submit();
  }

  /** Clear the fields and the reply. */
  clear(): void {
    for (const control of Object.values(this.controls())) {
      control.setValue('');
    }
    this.reset();
  }

  /**
   * Fold one reply into view state.
   *
   * The 400 from the argument mapper has no `provider` and no `status` -- it is
   * the gateway refusing the body, not the worker answering -- so `error` is
   * checked rather than `status`, which is absent on that path.
   * @param {ToolEnvelope} reply The reply.
   * @return {void}
   */
  private apply(reply: ToolEnvelope): void {
    this.envelope.set(reply);

    if (reply.error) {
      this.state.set('error');
      this.errorMessage.set(reply.error);
      return;
    }

    this.state.set('ready');
    this.errorMessage.set('');
  }

  /**
   * Fold a failed HTTP response into view state.
   *
   * The body is an envelope on every status this route produces, so the server's
   * own text is preferred over a status-code guess. A refusal (403) and an
   * outage (502) read very differently to a user, and only the server knows
   * which happened.
   * @param {HttpErrorResponse} error The failed response.
   * @return {void}
   */
  private applyFailure(error: HttpErrorResponse): void {
    const body = error.error as ToolEnvelope | null;
    this.envelope.set(body);

    this.state.set('error');
    this.errorMessage.set(
      typeof body?.error === 'string' && body.error ? body.error : 'TOOLS.ERR_REQUEST',
    );
  }

  /** Back to the opening state, keeping the tool choice. */
  private reset(): void {
    this.envelope.set(null);
    this.errorMessage.set('');
    this.formError.set('');
    this.state.set('idle');
  }

  /** One control per field of a tool, all empty.
   * @param {ToolDescriptor} descriptor The tool.
   * @return {Record<string, FormControl<string>>} The controls.
   */
  private buildControls(descriptor: ToolDescriptor): Record<string, FormControl<string>> {
    const controls: Record<string, FormControl<string>> = {};
    for (const field of descriptor.fields) {
      controls[field.name] = new FormControl('', { nonNullable: true });
    }
    return controls;
  }
}
