import { Component, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

interface AgentStat {
  k: string;
  d: string;
  accent: 'cyan' | 'rose';
}

interface AgentCapability {
  icon: string;
  title: string;
  description: string;
  accent: 'cyan' | 'rose';
}

interface AgentTool {
  name: string;
  hint?: string;
}

@Component({
  selector: 'app-landing-agent',
  standalone: true,
  imports: [NgClass, LucideAngularModule, TranslateModule, RevealDirective],
  templateUrl: './landing-agent.component.html',
  styleUrl: './landing-agent.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingAgentComponent {
  readonly icons = myIcons;

  readonly constellationImage = 'assets/images/landing/agent-constellation.webp';

  readonly stats: AgentStat[] = [
    { k: 'AGENT.STAT_1_K', d: 'AGENT.STAT_1_D', accent: 'cyan' },
    { k: 'AGENT.STAT_2_K', d: 'AGENT.STAT_2_D', accent: 'rose' },
    { k: 'AGENT.STAT_3_K', d: 'AGENT.STAT_3_D', accent: 'cyan' },
    { k: 'AGENT.STAT_4_K', d: 'AGENT.STAT_4_D', accent: 'rose' },
  ];

  readonly capabilities: AgentCapability[] = [
    {
      icon: 'search',
      title: 'AGENT.F1_T',
      description: 'AGENT.F1_D',
      accent: 'cyan',
    },
    {
      icon: 'key-round',
      title: 'AGENT.F2_T',
      description: 'AGENT.F2_D',
      accent: 'rose',
    },
    {
      icon: 'database',
      title: 'AGENT.F3_T',
      description: 'AGENT.F3_D',
      accent: 'cyan',
    },
    {
      icon: 'filetext',
      title: 'AGENT.F4_T',
      description: 'AGENT.F4_D',
      accent: 'rose',
    },
  ];

  /** Real intent-based MCP tools surfaced to the landing (webrain surface). */
  readonly tools: AgentTool[] = [
    { name: 'webrain_search' },
    { name: 'webrain_serp' },
    { name: 'webrain_navigate' },
    { name: 'webrain_observe' },
    { name: 'webrain_interact' },
    { name: 'webrain_extract', hint: 'autoschema' },
    { name: 'webrain_crawl', hint: 'spider · sitemap' },
    { name: 'webrain_batch' },
    { name: 'webrain_session', hint: 'login · vault' },
    { name: 'webrain_vision', hint: 'captcha' },
    { name: 'webrain_pdf' },
    { name: 'webrain_watch', hint: 'video → transcript' },
    { name: 'webrain_download' },
    { name: 'webrain_eval' },
  ];

  readonly consoleSteps = [
    { tool: 'AGENT.TOOL_1', detail: 'AGENT.TOOL_1_D', accent: 'cyan' as const },
    { tool: 'AGENT.TOOL_2', detail: 'AGENT.TOOL_2_D', accent: 'rose' as const },
    { tool: 'AGENT.TOOL_3', detail: 'AGENT.TOOL_3_D', accent: 'cyan' as const },
  ];

  /** Tools repeated twice so the CSS marquee loops seamlessly. */
  get doubledTools(): AgentTool[] {
    return [...this.tools, ...this.tools];
  }
}
