import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { CartService, WebrainToolsService } from 'src/app/core/services';
import { SchemaCompileResult } from 'src/app/core/types';

/**
 * The Extraction Strategies tab: get a CSS schema without writing one.
 *
 * Why it exists
 * -------------
 * A schema is `base_selector` + `fields`, and a human cannot type that — the
 * only way to produce it by hand is to read a page's markup. So the input here
 * is a sentence ("every product: name, price, link"), and the answer comes from
 * `POST /api/extract/schema`, which compiles it and PROVES it selects rows
 * before answering. What the tab shows is therefore already working on the page
 * it was compiled against, not a plausible guess.
 *
 * Why the compiled schema is stored on the CART, under its own key
 * ----------------------------------------------------------------
 * The three sibling tabs each own one disjoint cart key (`browserProfile`,
 * `crawlConfig`, `crawlResultconfig`) and none of them writes another's. This
 * follows that exactly: `extractionStrategy`, so this tab needs no knowledge of
 * the crawler-config form and cannot clobber it. The pack is assembled from
 * those keys.
 *
 * `model` is the caller's to name, and the route requires it — see
 * `WebrainToolsService.compileSchema`.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-extract-strategy',
    imports: [ReactiveFormsModule, TranslateModule, MatIcon, JsonPipe],
    templateUrl: './extract-strategy.component.html',
    styleUrl: './extract-strategy.component.scss'
})
export class ExtractStrategyComponent {
    private readonly fb = inject(FormBuilder);
    private readonly compiler = inject(WebrainToolsService);
    private readonly cartService = inject(CartService);

    /** The last successful compile, or null. */
    protected readonly result = signal<SchemaCompileResult | null>(null);
    protected readonly compiling = signal(false);
    protected readonly failure = signal<string | null>(null);

    /**
     * The compiled schema's column names, in order, for the sample table.
     *
     * Read off the schema rather than the rows: a field that matched nothing on
     * one sample row is still a column of the schema, and the header is what
     * tells a human which columns they asked for.
     */
    protected readonly columns = computed<string[]>(() =>
        (this.result()?.schema?.fields ?? [])
            .map((field) => String(field['name'] ?? ''))
            .filter((name) => name.length > 0)
    );

    protected readonly form = this.fb.nonNullable.group({
        url: ['', [Validators.required]],
        // Optional: the route defaults an empty intent to "the repeated records
        // on this page", which is the honest description of an unstated goal.
        intent: [''],
        model: ['', [Validators.required]],
    });

    /**
     * One sample-table cell as text.
     *
     * The one place a worker value becomes a string, because the values arrive as
     * `unknown`: a field can legitimately hold a nested object (type `html` or a
     * `list`), and rendering that through interpolation would either throw or
     * print `[object Object]`. Objects are shown as JSON, which is what the field
     * actually is.
     * @param {Record<string, unknown>} row The sample row.
     * @param {string} column The field name.
     * @return {string} The cell text.
     */
    protected cell(row: Record<string, unknown>, column: string): string {
        const value = row[column];
        if (value === null || value === undefined) {
            return '';
        }
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    /**
     * Compile the sentence against the url, and keep the schema if it produced
     * rows. A compile that yielded nothing is reported as a failure rather than
     * shown as a schema, because that is what the route answers.
     * @return {void}
     */
    protected compile(): void {
        if (this.compiling()) {
            return;
        }
        if (this.form.invalid) {
            this.form.markAllAsTouched();
            return;
        }
        this.compiling.set(true);
        this.failure.set(null);
        const { url, intent, model } = this.form.getRawValue();
        this.compiler.compileSchema({ url, intent, model }).subscribe({
            next: (reply) => {
                this.compiling.set(false);
                if (reply.ok && reply.schema) {
                    this.result.set(reply);
                    return;
                }
                this.result.set(null);
                this.failure.set(reply.error ?? 'The schema could not be compiled.');
            },
            error: (error: unknown) => {
                this.compiling.set(false);
                this.result.set(null);
                this.failure.set(
                    error instanceof Error ? error.message : 'The schema could not be compiled.'
                );
            },
        });
    }

    /**
     * Put the compiled schema on the pack, under this tab's own cart key.
     * @return {void}
     */
    protected addToPack(): void {
        const schema = this.result()?.schema;
        if (!schema) {
            return;
        }
        // The same provider the three sibling tabs pass, so a pack's provenance
        // does not depend on which tab was filled in last.
        void this.cartService.addItemToCart({ extractionStrategy: { schema } }, 'crawl4ai');
    }

    /**
     * Take this tab's contribution back off the pack.
     * @return {void}
     */
    protected clearFromPack(): void {
        void this.cartService.removeItemFromCart('extractionStrategy');
        this.result.set(null);
    }
}

