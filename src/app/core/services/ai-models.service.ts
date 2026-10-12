import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { of } from 'rxjs/internal/observable/of';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { AIModel, AiVendorId, ModelFacts } from '../types';
import { buildModelOptions, setAIModel } from '../functions';
import { AiAPIService } from './aiapi.service';
import { AiKeysService } from './ai-keys.service';

/**
 * The models every picker offers, in one place.
 *
 * Why a service rather than the rule repeated per component
 * -------------------------------------------------------
 * Chat, the LLM-scrape form and operations render the same dropdown over the same catalogue, and
 * all three must agree on which models a caller may choose -- it is the decision that sets whose
 * model a request is posted to. The first version of this lived in the chat component; wiring the
 * other two from there would have made a third and fourth copy of that decision.
 *
 * It owns no `FormControl` and no default selection. Each picker keeps its own default, and
 * `selectionFor` is the single place that repairs a default which is no longer offered.
 *
 * What it is NOT
 * --------------
 * No retry, no polling and no refresh method. The catalogue changes when a vendor ships a model,
 * which is not something a page needs to watch for; `load()` once per page life is the whole
 * policy, and a caller that needs a fresh answer reloads the page.
 */
@Injectable({ providedIn: 'root' })
export class AiModelsService {
  private readonly ai = inject(AiAPIService);
  private readonly aiKeys = inject(AiKeysService);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly modelsState = signal<AIModel[]>([]);
  private readonly unlistedState = signal<AiVendorId[]>([]);
  private started = false;

  /** Every model a picker may offer: live where it could be read, static where it could not. */
  readonly models = this.modelsState.asReadonly();

  /**
   * Vendors the caller can use but whose catalogue came back empty.
   *
   * Surfaced rather than swallowed: "your key is fine but the catalogue came back empty" is a
   * different problem from "you have no key", and only the user can tell which they have.
   */
  readonly unlistedVendors = this.unlistedState.asReadonly();

  private readonly factsState = signal<Readonly<Record<string, ModelFacts>>>({});

  /**
   * What the platform knows about a model: context window, price, capabilities.
   *
   * A method rather than a signal a template reads, because no consumer wants the whole map.
   * The one is the cost figure for the model that was just called, and a map read in a template
   * would re-render every picker on the page when any vendor's facts landed.
   *
   * Absent is the ORDINARY answer, not an error: the registry does not carry every vendor, and a
   * model it has never heard of must read as "no better answer available" rather than as a claim
   * that the model is text-only and free.
   * @param {string} id The model id as this service holds it.
   * @return {ModelFacts | undefined} The facts, or undefined when there are none.
   */
  factsFor(id: string): ModelFacts | undefined {
    return this.factsState()[id];
  }

  /**
   * Fill the list, once per page life.
   *
   * Idempotent because more than one picker can be mounted at once -- the scrape form and the
   * operations table both live under the user layout. A second caller gets the list already being
   * built rather than a second round of requests.
   *
   * The static pass runs on the server too. A prerender has no authenticated user, so it can only
   * ever produce the static list -- but producing NOTHING would hydrate into a different `<select>`
   * than the browser then renders, and the picker would flash empty on the first paint.
   * @return {void}
   */
  load(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // Pure: no request, no authenticated user, no browser API. This is exactly what all three
    // pickers rendered before the list moved here, so SSR output is unchanged by the move.
    const fallback: AIModel[] = [];
    setAIModel(fallback);
    this.apply(fallback, {});

    // Past this point every read needs a signed-in caller, which a prerender does not have.
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    // Only ask for the keys if nobody has. The settings panel and the scrape form both load them
    // already, and `AiKeysService.load` re-reads on EVERY call by design (a write needs a fresh
    // answer), so calling it unconditionally here would buy a duplicate round trip on exactly the
    // page where it is least wanted.
    const keys = this.aiKeys.isLoaded() ? Promise.resolve() : this.aiKeys.load();

    void keys.then(() => {
      const fetches = this.allowedVendors().map(vendor => this.ai.fetchModels(vendor).pipe(
        // One vendor failing must not reject the batch, and an empty catalogue is already the
        // agreed answer for "could not read it".
        catchError(() => of({ models: [] as string[], facts: {} })),
        map(catalogue => [vendor, catalogue] as const),
      ));

      if (fetches.length === 0) {
        return;
      }

      forkJoin(fetches).subscribe(pairs => {
        const live: Record<string, string[]> = {};
        const facts: Record<string, ModelFacts> = {};

        for (const [vendor, catalogue] of pairs) {
          live[vendor] = catalogue.models;
          // Merged across vendors into one map. A collision means two vendors serve the SAME
          // model, in which case either row gives the same price; the ids that differ are the
          // vendor-specific ones, and those cannot collide by definition.
          Object.assign(facts, catalogue.facts);
        }

        this.factsState.set(facts);
        this.apply(fallback, live, facts);
      });
    });
  }

  /**
   * The option a picker should hold, given what it had.
   *
   * A selection that is no longer offered renders the dropdown with NOTHING selected -- the trap
   * `setAIModel`'s own comment warns about -- and it is reachable in practice: a release can drop
   * a model, and a caller's own key changes what their vendor serves.
   * @param {AIModel} current The selection the picker holds.
   * @return {AIModel} `current` when it is still offered, otherwise the first option.
   */
  selectionFor(current: AIModel): AIModel {
    const options = this.models();
    return options.length === 0 || options.some(option => option.name === current.name)
      ? current
      : options[0];
  }

  /**
   * Apply a built option list.
   * @param {readonly AIModel[]} fallback The static list, for vendors with no live one.
   * @param {Readonly<Record<string, string[]>>} live The fetched catalogues, per vendor.
   * @return {void}
   */
  private apply(
    fallback: readonly AIModel[],
    live: Readonly<Record<string, string[]>>,
    facts: Readonly<Record<string, ModelFacts>> = {},
  ): void {
    // `null` until the server has answered: that is "unknown", which is not the same as "nothing
    // is usable", and the two must not collapse into an empty dropdown.
    const allowed = this.aiKeys.isLoaded() ? this.allowedVendors() : null;
    const { options, missing } = buildModelOptions(allowed, live, fallback, facts);

    this.modelsState.set(options);
    // Only meaningful once the server has said who is usable. Before that every BYOK-only vendor
    // is merely UNKNOWN, and naming all of them on the first paint would be a scare rather than a
    // report.
    this.unlistedState.set(allowed === null ? [] : missing);
  }

  /**
   * The vendors the server resolved as usable for this caller.
   *
   * The server's verdict, not a client guess: it already accounts for the plan AND for whether a
   * key is stored, which is the same rule the route guard enforces. Re-deriving it here would be
   * the second opinion `resolveAiKeySource` exists to prevent.
   * @return {AiVendorId[]} The usable vendors, in catalogue order.
   */
  private allowedVendors(): AiVendorId[] {
    const allowed: AiVendorId[] = [];
    for (const vendor of this.aiKeys.vendors()) {
      if (vendor.allowed && vendor.id !== null) {
        allowed.push(vendor.id);
      }
    }
    return allowed;
  }
}
