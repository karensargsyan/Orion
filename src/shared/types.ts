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
  selectedText?: string
  visibleText?: string
}

// ─── User Actions ─────────────────────────────────────────────────────────────

export type ActionType = 'click' | 'input' | 'submit' | 'focus' | 'navigate' | 'scroll'

export interface UserActionEvent {
  type: ActionType
  selector: string
  tagName: string
  text?: string
  value?: string
  url: string
  timestamp: number
  tabId?: number
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export type SessionMemoryType = 'page_visit' | 'action' | 'form_detected' | 'ai_summary' | 'email_detected' | 'calendar_detected' | 'habit_pattern' | 'text_rewrite'

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

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  lmStudioUrl: string
  lmStudioModel: string
  authToken: string
  apiCapabilities?: APICapabilities
  rateLimitRpm: number
  monitoringEnabled: boolean
  visionEnabled: boolean
  maxContextMessages: number
  hasPinSetup: boolean
  pbkdf2SaltB64?: string
  screenshotIntervalSec: number
  textRewriteEnabled: boolean
  calendarDetectionEnabled: boolean
  onboardingComplete: boolean
}

// ─── Form Fill Assignment ─────────────────────────────────────────────────────

export interface FillAssignment {
  selector: string
  value: string
  inputType: string
}

// ─── AI Action Commands ───────────────────────────────────────────────────────

export type AIActionType = 'click' | 'type' | 'fill_form' | 'scroll' | 'select' | 'navigate' | 'read' | 'screenshot' | 'select_option' | 'check' | 'clear' | 'wait' | 'read_options' | 'get_page_state'

export interface AIAction {
  action: AIActionType
  selector?: string
  value?: string
  url?: string
  assignments?: FillAssignment[]
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
