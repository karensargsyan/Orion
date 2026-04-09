/** Centralized DOM selectors for the side panel UI */
export const SEL = {
  // Chat
  chatInput: '.chat-input-tab',
  sendBtn: '.btn-send-tab',
  stopBtn: '.btn-stop-tab',
  assistantMsg: '.message-assistant',
  userMsg: '.message-user',
  errorMsg: '.message-error',
  typingIndicator: '.typing-indicator',
  chatContainer: '.chat-container',

  // Tab bar
  tabBtn: (name: string) => `.tab-btn[data-tab="${name}"]`,

  // Onboarding
  onboarding: '.onboarding',
  onboardingUrl: '#onboarding-url',
  onboardingDetect: '#onboarding-detect',
  onboardingModel: '#onboarding-model',
  onboardingStart: '#onboarding-start',

  // Settings
  providerSelect: '#active-provider',
  localUrlInput: '#lm-studio-url',
  testConnectionBtn: '#test-connection',
  connectionStatus: '#connection-status',

  // Quick actions
  quickActions: '.quick-actions',
  quickActionBtn: '.quick-action-btn',

  // Messages
  messageActions: '.message-actions',
  copyBtn: '.btn-copy',
  retryBtn: '.btn-retry',
} as const
