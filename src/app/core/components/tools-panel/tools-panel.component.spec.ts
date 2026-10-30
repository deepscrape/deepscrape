import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import {
  TOOL_DESCRIPTORS,
  ToolDescriptor,
  ToolsPanelComponent,
} from './tools-panel.component';
import { CrawlOperation, CrawlTask, JobResult, ToolRequestBody } from '../../types';
import { AuthService, CrawlAPIService } from '../../services';
import { CrawlOperationStatus } from '../../enum';

/**
 * Records what was QUEUED and answers one finished job.
 *
 * The panel no longer calls a tool: it queues one, so this stub stands where the
 * queue does. Recording at `enqueueTool` rather than at a per-tool method is what
 * keeps the "body it sends" tests meaningful -- the body is still mapped by the
 * component, only its destination changed.
 */
class StubJobs {
  static called: string | null = null;
  static sent: ToolRequestBody | null = null;
  static operation: CrawlOperation | null = null;

  enqueueTool(
    tool: string,
    body: ToolRequestBody,
    operation: CrawlOperation,
  ): Observable<CrawlTask> {
    StubJobs.called = tool;
    StubJobs.sent = body;
    StubJobs.operation = operation;
    return of({ id: 'job-1' } as CrawlTask);
  }

  /** A job that has already finished, so the immediate read settles the panel. */
  getJobResult(): Observable<JobResult> {
    return of({
      task_id: 'job-1',
      status: CrawlOperationStatus.COMPLETED,
      message: '',
      total: 1,
      items: [
        {
          label: 'x',
          url: 'x',
          status: 'ok',
          message: '',
          challenge: null,
          data: { ok: true },
        },
      ],
    });
  }
}

/** The minimum `TranslateService` surface the pipe and the component touch. */
const translateStub = {
  instant: (key: string) => key,
  get: (key: string) => of(key),
  stream: (key: string) => of(key),
  use: () => of('en'),
  onLangChange: of(null),
  onTranslationChange: of(null),
  onDefaultLangChange: of(null),
};

/** The descriptor for one tool id.
 * @param {string} id The tool id.
 * @return {ToolDescriptor} The descriptor.
 */
const tool = (id: string): ToolDescriptor =>
  TOOL_DESCRIPTORS.find(entry => entry.id === id) as ToolDescriptor;

describe('ToolsPanelComponent', () => {
  let component: ToolsPanelComponent;

  beforeEach(async () => {
    StubJobs.sent = null;
    StubJobs.called = null;
    StubJobs.operation = null;

    await TestBed.configureTestingModule({
      imports: [ToolsPanelComponent],
      providers: [
        provideRouter([]),
        { provide: CrawlAPIService, useValue: new StubJobs() },
        { provide: AuthService, useValue: { user$: of(null) } },
        { provide: TranslateService, useValue: translateStub },
      ],
    }).compileComponents();

    component = TestBed.createComponent(ToolsPanelComponent).componentInstance;
  });

  describe('the descriptor table', () => {
    it('gates every conditional field on a mode the tool actually declares', () => {
      // The failure this catches: a `whenMode` naming a value the picker does
      // not offer, which hides the field forever with no error anywhere.
      for (const entry of TOOL_DESCRIPTORS) {
        const modeField = entry.modeField
          ? entry.fields.find(field => field.name === entry.modeField)
          : undefined;

        for (const field of entry.fields) {
          const conditions = [...(field.whenMode ?? []), ...(field.requiredWhenMode ?? [])];

          if (conditions.length === 0) {
            continue;
          }

          expect(modeField).withContext(`${entry.id}.${field.name} needs a modeField`).toBeDefined();

          for (const condition of conditions) {
            expect(modeField?.options ?? [])
              .withContext(`${entry.id}.${field.name} gates on unknown "${condition}"`)
              .toContain(condition);
          }
        }
      }
    });

    it('gives every select a non-empty vocabulary and every field a unique name', () => {
      for (const entry of TOOL_DESCRIPTORS) {
        const names = entry.fields.map(field => field.name);
        expect(new Set(names).size).withContext(`${entry.id} repeats a field name`).toBe(names.length);

        for (const field of entry.fields) {
          if (field.kind === 'select') {
            expect((field.options ?? []).length).withContext(`${entry.id}.${field.name}`).toBeGreaterThan(0);
          }
        }
      }
    });

    it('walks the gateway vocabulary, not a guess', () => {
      // Copied from `functions/src/handlers/webrain-tools.ts`. Pinned here
      // because the gateway exposes no endpoint that reports them, so a drift
      // would surface as a 400 rather than as a failing test.
      expect(tool('search').fields.find(f => f.name === 'engine')?.options)
        .toEqual(['duckduckgo', 'google', 'bing', 'brave']);
      expect(tool('extract').fields.find(f => f.name === 'mode')?.options)
        .toEqual(['schema', 'regex', 'jsonld', 'table', 'autoschema', 'bm25']);
      expect(tool('pdf').fields.find(f => f.name === 'op')?.options)
        .toEqual(['page', 'extract', 'render', 'images']);
      expect(tool('batch').fields.find(f => f.name === 'op')?.options)
        .toEqual(['fetch', 'extract', 'screenshot']);
      expect(tool('spider').fields.find(f => f.name === 'mode')?.options)
        .toEqual(['spider', 'sitemap', 'scan', 'validate']);
      expect(tool('spider').fields.find(f => f.name === 'strategy')?.options)
        .toEqual(['bfs', 'dfs', 'bestfirst']);
    });
  });

  describe('the field visibility follows the mode', () => {
    it('reveals and hides the fields a mode gates', () => {
      // The regression this pins: `visibleFields` was a `computed` reading a
      // FormControl's value, which is not a signal, so it cached the first mode
      // and the conditional fields never appeared at all.
      //
      // It uses `schema` and `patterns` because those are the fields whose
      // VISIBILITY is gated. `selector` and `query` are not: the gateway maps
      // either one whenever it is present and only insists on them for `schema`
      // and `bm25`, so they are conditionally REQUIRED, not conditionally
      // shown. Hiding them outside their mode would withhold a request the API
      // accepts -- see the sibling test below.
      component.selectTool(tool('extract'));

      expect(component.visibleFields().map(field => field.name)).not.toContain('schema');
      expect(component.visibleFields().map(field => field.name)).not.toContain('patterns');

      component.controlFor('mode').setValue('schema');
      expect(component.visibleFields().map(field => field.name)).toContain('schema');
      expect(component.visibleFields().map(field => field.name)).not.toContain('patterns');

      component.controlFor('mode').setValue('regex');
      expect(component.visibleFields().map(field => field.name)).toContain('patterns');
      expect(component.visibleFields().map(field => field.name)).not.toContain('schema');
    });

    it('keeps a conditionally-required field visible in every mode', () => {
      // `selector` is required only for `schema`, `query` only for `bm25`, but
      // the gateway maps either whenever it is sent. A form that hid them would
      // make a legitimate request unexpressible, which is the failure mode the
      // original version of the test above would have talked us into.
      component.selectTool(tool('extract'));

      for (const mode of ['schema', 'regex', 'jsonld', 'table', 'autoschema', 'bm25']) {
        component.controlFor('mode').setValue(mode);

        const names = component.visibleFields().map(field => field.name);
        expect(names).withContext(mode).toContain('selector');
        expect(names).withContext(mode).toContain('query');
      }
    });
  });

  describe('the body it sends', () => {
    it('omits a blank optional field rather than sending an empty string', () => {
      component.controlFor('q').setValue('pizza');
      component.submit();

      expect(StubJobs.called).toBe('search');
      expect(StubJobs.sent).toEqual({ q: 'pizza' });
    });

    it('includes a chosen select value', () => {
      component.controlFor('q').setValue('pizza');
      component.controlFor('engine').setValue('brave');
      component.submit();

      expect(StubJobs.sent).toEqual({ q: 'pizza', engine: 'brave' });
    });

    it('refuses to send when a mode-required field is blank', () => {
      component.selectTool(tool('extract'));
      component.controlFor('mode').setValue('bm25');
      component.submit();

      expect(StubJobs.sent).toBeNull();
      expect(component.formError()).toBe('TOOLS.FORM_REQUIRED');
    });

    it('refuses to send unparseable JSON', () => {
      component.selectTool(tool('extract'));
      component.controlFor('mode').setValue('regex');
      component.controlFor('patterns').setValue('[not json');
      component.submit();

      expect(StubJobs.sent).toBeNull();
      expect(component.formError()).toBe('TOOLS.FORM_BAD_JSON');
    });

    it('parses JSON and numbers rather than passing them as strings', () => {
      component.selectTool(tool('extract'));
      component.controlFor('mode').setValue('regex');
      component.controlFor('patterns').setValue('["a+","b+"]');
      component.controlFor('top_k').setValue('25');
      component.submit();

      expect(StubJobs.sent).toEqual({ mode: 'regex', patterns: ['a+', 'b+'], top_k: 25 });
    });

    it('sends a flag only when it is on', () => {
      component.selectTool(tool('extract'));
      component.controlFor('mode').setValue('table');
      component.setFlag('adaptive', false);
      component.submit();
      expect(StubJobs.sent).toEqual({ mode: 'table' });

      component.setFlag('adaptive', true);
      component.submit();
      expect(StubJobs.sent).toEqual({ mode: 'table', adaptive: true });
    });

    it('clears the reply and the fields when the tool changes', () => {
      component.controlFor('q').setValue('pizza');
      component.submit();
      expect(component.state()).toBe('ready');

      component.selectTool(tool('pdf'));

      expect(component.state()).toBe('idle');
      expect(component.controlFor('q').value).toBe('');
    });
  });

  describe('the job it queues', () => {
    it('queues the call and names the tool on the operations row', () => {
      // The point of queueing is that the work outlives this tab, so the row
      // `/operations` lists has to say WHICH tool ran -- "Completed" alone tells
      // a caller nothing about which of seven tools produced it.
      component.controlFor('q').setValue('pizza');
      component.submit();

      expect(StubJobs.called).toBe('search');
      expect(StubJobs.operation?.name).toBe('search');
      expect(component.jobId()).toBe('job-1');
    });

    it('renders the finished job as the reply', () => {
      component.controlFor('q').setValue('pizza');
      component.submit();

      expect(component.state()).toBe('ready');
      expect(component.envelope()?.data).toEqual({ ok: true });
    });
  });
});
