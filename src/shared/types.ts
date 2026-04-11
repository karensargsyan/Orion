// ─── API Capabilities ────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string
  name: string
  supportsVision: boolean
  contextLength?: number
}

export interface APICapabilities {
  baseUrl: string
  authToken?: string
  apiFormat: 'openai' | 'anthropic' | 'both'
  supportsVision: boolean
  supportsEmbeddings: boolean
  supportsStreaming: boolean
  supportsReasoning?: boolean
  availableModels: ModelInfo[]
  defaultModel: string
  serverType: string
  probedAt: number
}

// ─── Page Analysis ───────────────────────────────────────────────────────────

export interface FieldOption {
  value: string
  label: string
  selected: boolean
}

export interface FormField {
  selector: string
  type: string
  name: string
  label: string
  required: boolean
  autocomplete: string
  value?: string
  options?: FieldOption[]
  checked?: boolean
  groupName?: string
}

export interface FormInfo {
  selector: string
  action: string
  method: string
  fields: FormField[]
}

export interface PageButton {
  selector: string
  text: string
  role: string
}

export interface PageLink {
  href: string
  text: string
  isNav: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  timestamp: number
  tabId?: number
  forms: FormInfo[]
  buttons: PageButton[]
  links: PageLink[]
  headings: string[]
  metaDescription: string
  screenshot?: string
  pageText?: string
  /** Full body text (viewport + off-screen + typical DOM-hidden copy); capped at extraction time. */
  completePageText?: string
  selectedText?: string
  visibleText?: string
}

// ─── User Actions ─────────────────────────────────────────────────────────────

export type ActionType =
  | 'click'
  | 'input'
  | 'submit'
  | 'focus'
  | 'navigate'
  | 'scroll'
  | 'move'
  | 'pointer'
  | 'wheel'
  | 'keydown'

export interface UserActionEvent {
  type: ActionType
  selector: string
  tagName: string
  text?: string
  value?: string
  /** Extra compact context, e.g. coordinates "1200,400" or key name */
  detail?: string
  url: string
  timestamp: number
  tabId?: number
  /** HTML input type (text, email, tel, password, search, etc.) */
  inputType?: string
  /** Human-readable field label from <label>, placeholder, or aria-label */
  fieldLabel?: string
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export type SessionMemoryType = 'page_visit' | 'action' | 'form_detected' | 'ai_summary' | 'email_detected' | 'calendar_detected' | 'habit_pattern' | 'text_rewrite' | 'learning_snapshot'

export interface SessionMemoryEntry {
  id?: number
  type: SessionMemoryType
  url: string
  domain: string
  content: string
  tags: string[]
  timestamp: number
  sessionId: string
  tabId?: number
}

export interface LearningSnapshot {
  timestamp: number
  url: string
  domain: string
  screenshot?: string
  pageTitle: string
  accessibilityTree: string
  recentActions: UserActionEvent[]
  visibleText: string
}

export interface LearningSession {
  id: string
  startedAt: number
  endedAt?: number
  tabId: number
  domain: string
  snapshots: LearningSnapshot[]
  analysis?: string
}

export interface GlobalMemoryEntry {
  id?: number
  domain: string
  summary: string
  tags: string[]
  importance: number
  timestamp: number
  sourceCount: number
}

// ─── Vault ────────────────────────────────────────────────────────────────────

export type VaultCategory = 'credential' | 'address' | 'card' | 'contact' | 'identity' | 'custom'

export interface VaultEntry {
  id: string
  category: VaultCategory
  label: string
  encryptedData: EncryptedBlob
  createdAt: number
  updatedAt: number
  /** If true, this entry was auto-collected from user input and awaits approval */
  autoCollected?: boolean
  /** Domain where the data was collected from */
  sourceDomain?: string
}

// ─── Local Memory ─────────────────────────────────────────────────────────────

export type LocalMemoryCategory = 'error' | 'success' | 'lesson' | 'domain_knowledge' | 'session_push'

export interface LocalMemoryEntry {
  id?: number
  category: LocalMemoryCategory
  domain: string
  content: string
  source: string
  keywords: string[]
  timestamp: number
  accessCount: number
  lastAccessed: number
}

export interface EncryptedBlob {
  iv: string
  ct: string
}

export interface CredentialData {
  username: string
  password: string
  url?: string
  notes?: string
}

export interface AddressData {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  zip: string
  country: string
  phone?: string
}

export interface CardData {
  cardholderName: string
  number: string
  expiry: string
  cvv: string
  billingZip?: string
}

export interface ContactData {
  firstName: string
  lastName: string
  email: string
  phone?: string
  company?: string
  birthday?: string
}

export interface IdentityData {
  firstName: string
  lastName: string
  email: string
  phone?: string
  birthday?: string
  address?: Partial<AddressData>
}

export type VaultData = CredentialData | AddressData | CardData | ContactData | IdentityData | Record<string, string>

// ─── Input Journal (Total Recall) ─────────────────────────────────────────────

export type InputFieldType =
  | 'firstName' | 'lastName' | 'fullName'
  | 'email' | 'phone'
  | 'username' | 'password'
  | 'street' | 'city' | 'state' | 'zip' | 'country'
  | 'cardNumber' | 'cardExpiry' | 'cardCvv' | 'cardholderName'
  | 'birthday' | 'company'
  | 'unknown'

export interface InputJournalEntry {
  id?: number
  fieldType: InputFieldType
  fieldLabel: string
  value: string
  encrypted: boolean
  domain: string
  url: string
  inputType: string
  timestamp: number
  source: 'user_action' | 'form_fill' | 'chat_pii'
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id?: number
  sessionId: string
  role: ChatRole
  content: string
  timestamp: number
  url?: string
  tabId?: number
  imageData?: string
}

// ─── Supervised Learning ─────────────────────────────────────────────────────

export type STTProvider = 'web-speech' | 'whisper-local'

export interface SupervisedInteraction {
  command: string
  actions: UserActionEvent[]
  snapshots: LearningSnapshot[]
  startedAt: number
  endedAt?: number
}

export interface SupervisedSession {
  id: string
  startedAt: number
  endedAt?: number
  tabId: number
  domain: string
  interactions: SupervisedInteraction[]
  analysis?: string
}

export interface LearnedPlaybook {
  id: string
  triggers: string[]
  steps: string[]
  selectors: string[]
  domain: string
  confidence: number
  successCount: number
  failureCount: number
  createdAt: number
  updatedAt: number
}

// ─── AI Provider Types ────────────────────────────────────────────────────────

export type AIProvider = 'local' | 'gemini' | 'openai' | 'anthropic'

export interface ExternalProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  activeProvider: AIProvider
  lmStudioUrl: string
  lmStudioModel: string
  authToken: string
  apiCapabilities?: APICapabilities
  rateLimitRpm: number
  geminiApiKey?: string
  geminiModel?: string
  openaiApiKey?: string
  openaiModel?: string
  anthropicApiKey?: string
  anthropicModel?: string
  monitoringEnabled: boolean
  visionEnabled: boolean
  maxContextMessages: number
  hasPinSetup: boolean
  pbkdf2SaltB64?: string
  screenshotIntervalSec: number
  textRewriteEnabled: boolean
  safetyBorderEnabled: boolean
  composeAssistantEnabled: boolean
  aiActionLearningEnabled: boolean
  mempalaceBridgeEnabled?: boolean
  mempalaceBridgeUrl?: string
  mempalaceWing?: string
  localMemoryEnabled?: boolean
  localMemoryMaxEntries?: number
  autoCollectEnabled?: boolean
  autoCollectMinFields?: number
  autoCollectExcludeDomains?: string[]
  calendarDetectionEnabled: boolean
  onboardingComplete: boolean
  learningModeActive: boolean
  learningSnapshotIntervalSec: number
  sttProvider: STTProvider
  whisperEndpoint: string
  confirmationPreferences: ConfirmationPreference[]
  globalAutoAccept: boolean
  /** Context window in tokens (for token-aware truncation). 0 = auto-detect. */
  contextWindowTokens: number
  /** Use simplified prompt + fewer actions for small local models */
  liteMode: boolean
  /** Telegram bot integration */
  telegramBotEnabled?: boolean
  telegramBotToken?: string
  telegramAllowedChatIds?: string[]
  telegramPollIntervalSec?: number
  /** Automation preference: 'ask' prompts per-task, 'auto' runs automatically, 'guided' highlights for user */
  automationPreference?: 'ask' | 'auto' | 'guided'
  /** Total Recall: capture all form inputs for later recall */
  inputJournalEnabled?: boolean
  /** Vault auto-lock after idle minutes (0 = never) */
  vaultLockTimeoutMin?: number
  /** UI theme preference */
  theme?: 'system' | 'dark' | 'light'
}

// ─── Confirmation ─────────────────────────────────────────────────────────────

export type ConfirmationLevel = 'always_ask' | 'auto_accept'

export interface ConfirmationPreference {
  actionType: string
  domain?: string
  level: ConfirmationLevel
  updatedAt: number
}

export type ConfirmResponseType = 'once' | 'always_this' | 'always_all' | 'decline'

// ─── Form Fill Assignment ─────────────────────────────────────────────────────

export interface FillAssignment {
  selector: string
  value: string
  inputType: string
}

// ─── AI Action Commands ───────────────────────────────────────────────────────

export type AIActionType = 'click' | 'type' | 'fill_form' | 'scroll' | 'select' | 'navigate' | 'read' | 'screenshot' | 'select_option' | 'check' | 'clear' | 'wait' | 'read_options' | 'get_page_state' | 'get_page_text' | 'read_page' | 'hover' | 'doubleclick' | 'keypress' | 'focus' | 'back' | 'forward' | 'scroll_to' | 'select_text' | 'search' | 'open_tab' | 'read_tab' | 'close_tab' | 'batch_read' | 'analyze_file' | 'toggle' | 'sitemap_screenshot' | 'research_done' | 'form_coach'

export type ReadPageFilter = 'interactive' | 'forms' | 'text' | 'all'

export interface AIAction {
  action: AIActionType
  selector?: string
  value?: string
  url?: string
  assignments?: FillAssignment[]
  markerId?: number
}

export interface AIActionResult {
  action: AIActionType
  success: boolean
  result?: string
  error?: string
  userActive?: boolean
  snapshot?: PageSnapshot
}

// ─── Calendar Events ──────────────────────────────────────────────────────────

export interface DetectedCalendarEvent {
  title: string
  date: string
  time?: string
  endTime?: string
  location?: string
  description?: string
  source: string
  confidence: number
  detectedAt: number
}

// ─── Message Payloads ─────────────────────────────────────────────────────────

export interface MsgPageSnapshot {
  type: 'PAGE_SNAPSHOT'
  payload: PageSnapshot
}

export interface MsgUserAction {
  type: 'USER_ACTION'
  event: UserActionEvent
}

export interface MsgAIChat {
  type: 'AI_CHAT'
  text: string
  sessionId: string
  tabId?: number
}

export interface MsgAIRecall {
  type: 'AI_RECALL'
  query: string
  sessionId: string
  tabId?: number
}

export interface MsgFillForm {
  type: 'FILL_FORM'
  formSelector: string
  vaultId: string
  tabId?: number
}

export interface MsgDoFill {
  type: 'DO_FILL'
  assignments: FillAssignment[]
}

export interface MsgStreamChunk {
  type: 'STREAM_CHUNK'
  chunk: string
}

export interface MsgStreamEnd {
  type: 'STREAM_END'
  fullText: string
}

export interface MsgStreamError {
  type: 'STREAM_ERROR'
  error: string
}

export interface MsgVaultSet {
  type: 'VAULT_SET'
  id: string
  category: VaultCategory
  label: string
  data: VaultData
}

export interface MsgVaultGet {
  type: 'VAULT_GET'
  id: string
}

export interface MsgVaultDelete {
  type: 'VAULT_DELETE'
  id: string
}

export interface MsgSetupPin {
  type: 'SETUP_PIN'
  pin: string
}

export interface MsgUnlockSession {
  type: 'UNLOCK_SESSION'
  pin: string
}

export interface MsgSettingsSet {
  type: 'SETTINGS_SET'
  partial: Partial<Settings>
}

export interface MsgMemoryQuery {
  type: 'MEMORY_QUERY'
  query: string
  sessionId: string
  tabId?: number
}

// ─── Web Research ──────────────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface PageContent {
  title: string
  url: string
  text: string
}

// ─── PII Detection ─────────────────────────────────────────────────────────

export type PIIType = 'email' | 'phone' | 'card' | 'name' | 'address'

export interface PIIMatch {
  type: PIIType
  value: string
  masked: string
}

// ─── Domain Skills ────────────────────────────────────────────────────────────

export interface DomainSkill {
  id?: number
  domain: string
  taskPattern: string
  actionSequence: string
  successCount: number
  failureCount: number
  lastUsed: number
  createdAt: number
}

// ─── Behavioral Knowledge ──────────────────────────────────────────────────────

export type BehaviorCategory =
  | 'workflow'
  | 'preference'
  | 'shortcut'
  | 'site_pattern'
  | 'form_habit'
  | 'navigation'
  | 'interaction_style'

export interface UserBehavior {
  id?: number
  domain: string
  category: BehaviorCategory
  description: string
  evidence: string
  confidence: number
  occurrences: number
  lastSeen: number
  createdAt: number
}

// ─── Visual Sitemap ──────────────────────────────────────────────────────────

/** One page entry in the per-domain sitemap. */
export interface SitemapPageEntry {
  /** URL path (without origin), e.g. "/settings/account" */
  path: string
  /** Full URL */
  url: string
  /** Page title */
  title: string
  /** Same-domain navigation links found on this page */
  navLinks: { href: string; text: string }[]
  /** Headings found on the page */
  headings: string[]
  /** Low-res JPEG screenshot (base64 data URL) — latest capture only */
  screenshotDataUrl?: string
  /** Last visit/capture timestamp */
  lastSeen: number
  /** How many times visited during automation */
  visitCount: number
}

/** Per-domain sitemap stored in IDB and cached in memory. */
export interface DomainSitemap {
  /** IDB key: the hostname, e.g. "mail.google.com" */
  domain: string
  /** Map from normalized URL path to page entry */
  pages: Record<string, SitemapPageEntry>
  /** When this sitemap was last persisted to IDB */
  lastPersisted: number
  /** When any page was last updated */
  lastUpdated: number
}
