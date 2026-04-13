import type { PageSnapshot } from '../../src/shared/types'
import { buildPromptPipeline, classifyIntent } from '../../src/background/prompt-engine'

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://github.com/acme/repo/branches',
    title: 'Branches · acme/repo',
    timestamp: Date.now(),
    forms: [],
    buttons: [],
    links: [],
    headings: ['Branches'],
    metaDescription: '',
    pageText: 'main Updated 4 days ago Default branch gh-pages Updated Apr 13 2026 master Updated Apr 13 2026 Pull request #1',
    completePageText: 'Branches\nmain Updated 4 days ago Default branch\ngh-pages Updated Apr 13 2026\nmaster Updated Apr 13 2026 Pull request #1',
    ...overrides,
  }
}

describe('prompt engine', () => {
  it('detects branch-management analysis intent from natural language', () => {
    const intent = classifyIntent(
      'here are many branches, analyse them tell me if i can get rid of main?',
      'coding',
      makeSnapshot()
    )

    expect(intent.category).toBe('analyze')
    expect(intent.entities.analysisType).toBe('branch_management')
    expect(intent.entities.targetElement).toBe('main')
    expect(intent.complexity).toBe('multi_step')
  })

  it('injects direct branch-analysis guidance into the system prompt', () => {
    const result = buildPromptPipeline({
      userText: 'here are many branches, analyse them tell me if i can get rid of main?',
      pageSnapshot: makeSnapshot(),
      accessibilityTree: '',
      viewportMeta: undefined,
      memories: '',
      skills: '',
      behaviors: '',
      instructions: '',
      mempalace: '',
      sitemap: '',
      capabilities: { supportsVision: false },
      isLocal: false,
      contextWindow: 32768,
      liteMode: false,
    })

    expect(result.intent.entities.analysisType).toBe('branch_management')
    expect(result.enhancedUserMessage).toContain('Decision requested')
    expect(result.systemPrompt).toContain('## GIT / BRANCH ANALYSIS')
    expect(result.systemPrompt).toContain('Do NOT ask the user to narrow the request')
  })

  it('enables file-priority mode when an attached file marker is present', () => {
    const result = buildPromptPipeline({
      userText: '[Attached file: data.json]\n```\n{"ok":true}\n```\n\nanalyze this',
      pageSnapshot: makeSnapshot({ url: 'https://example.com', title: 'Example', pageText: '', completePageText: '' }),
      accessibilityTree: '',
      viewportMeta: undefined,
      memories: '',
      skills: '',
      behaviors: '',
      instructions: 'Always monitor this website.',
      mempalace: '',
      sitemap: '',
      capabilities: { supportsVision: false },
      isLocal: false,
      contextWindow: 32768,
      liteMode: false,
    })

    expect(result.systemPrompt).toContain('FILE ANALYSIS PRIORITY MODE')
    expect(result.systemPrompt).toContain('IGNORE all permanent user instructions')
  })
})
