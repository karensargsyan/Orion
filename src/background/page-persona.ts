/**
 * Dynamic Persona Engine — detects page type and injects expert persona into the AI prompt.
 * Analyzes URL, domain, page title, headings, and content to classify the page,
 * then returns a role-specific persona block for the system prompt.
 */

// ─── Page type classification ────────────────────────────────────────────────

export type PageType =
  | 'email'
  | 'travel'
  | 'shopping'
  | 'realestate'
  | 'finance'
  | 'social'
  | 'coding'
  | 'docs'
  | 'news'
  | 'video'
  | 'maps'
  | 'food'
  | 'health'
  | 'jobs'
  | 'legal'
  | 'education'
  | 'crm'
  | 'general'

interface PageClassification {
  type: PageType
  confidence: number  // 0-1
  persona: string
}

// Domain patterns → page type (checked first, fastest)
const DOMAIN_RULES: Array<{ pattern: RegExp; type: PageType }> = [
  // Email
  { pattern: /mail\.google|outlook\.(live|office)|yahoo\.com\/mail|protonmail|tutanota|fastmail|mail\./i, type: 'email' },
  // Travel & Flights
  { pattern: /booking\.com|airbnb|expedia|skyscanner|kayak|google\.com\/travel|flightradar|momondo|kiwi\.com|aviasales|tutu\.ru|kupibilet|ozon\.travel|aeroflot|turkish|pegasus|s7|pobeda\.aero|lottravel|checkmytrip|tripadvisor/i, type: 'travel' },
  // Shopping
  { pattern: /amazon\.|ebay\.|aliexpress|etsy\.com|walmart|target\.com|bestbuy|zalando|otto\.de|mediamarkt|saturn\.de|idealo|geizhals|shopify|wish\.com|temu\.com|shein\.com/i, type: 'shopping' },
  // Real Estate
  { pattern: /zillow|realtor\.com|redfin|trulia|immobilien|immoscout|immowelt|rightmove|zoopla|idealista|seloger|fotocasa|cian\.ru|avito\.ru\/nedvizhimost|casa\.it|green-acres/i, type: 'realestate' },
  // Finance & Banking
  { pattern: /paypal|stripe\.com|revolut|wise\.com|n26\.com|banking|bank\.com|trade|invest|stock|crypto|coinbase|binance|tradingview|yahoo\.com\/finance|bloomberg|marketwatch/i, type: 'finance' },
  // Social Media
  { pattern: /facebook\.com|twitter\.com|x\.com|instagram|linkedin|reddit\.com|threads\.net|mastodon|tiktok\.com|snapchat|pinterest|tumblr|vk\.com|telegram\.org/i, type: 'social' },
  // Coding & Dev
  { pattern: /github\.com|gitlab\.com|bitbucket|stackoverflow|stackexchange|codepen|jsfiddle|replit|codesandbox|npmjs\.com|pypi\.org|crates\.io|hub\.docker/i, type: 'coding' },
  // Documentation & Wiki
  { pattern: /docs\.google|notion\.so|confluence|wiki|readthedocs|gitbook|docusaurus|slite\.com|coda\.io|airtable/i, type: 'docs' },
  // News
  { pattern: /news\.google|cnn\.com|bbc\.(com|co\.uk)|reuters|nytimes|washingtonpost|theguardian|spiegel\.de|tagesschau|ria\.ru|lenta\.ru|meduza/i, type: 'news' },
  // Video
  { pattern: /youtube\.com|vimeo\.com|twitch\.tv|dailymotion|netflix|disneyplus|hulu|primevideo/i, type: 'video' },
  // Maps
  { pattern: /google\.com\/maps|maps\.apple|openstreetmap|waze\.com|mapbox|yandex\.(com|ru)\/maps/i, type: 'maps' },
  // Food & Delivery
  { pattern: /doordash|ubereats|grubhub|deliveroo|lieferando|wolt\.com|just-eat|yelp\.com|opentable|allrecipes|chefkoch/i, type: 'food' },
  // Health
  { pattern: /webmd|mayoclinic|healthline|medscape|doctolib|jameda|zocdoc/i, type: 'health' },
  // Jobs
  { pattern: /indeed\.com|glassdoor|monster\.com|stepstone|xing\.com|hired\.com|angellist|workday/i, type: 'jobs' },
  // Legal
  { pattern: /law\.com|findlaw|justia|courtlistener|gesetze-im-internet/i, type: 'legal' },
  // Education
  { pattern: /coursera|udemy|edx\.org|khan|duolingo|quizlet|chegg|studysmarter|lecturio/i, type: 'education' },
  // CRM & Business
  { pattern: /salesforce|hubspot|zendesk|freshdesk|zoho|pipedrive|monday\.com|asana|trello|jira/i, type: 'crm' },
]

// Content keywords → page type (used when domain doesn't match)
const CONTENT_RULES: Array<{ keywords: RegExp; type: PageType; weight: number }> = [
  { keywords: /\b(inbox|compose|reply|forward|draft|sent|spam|unread|subject|from:|to:|cc:|bcc:)\b/i, type: 'email', weight: 0.7 },
  { keywords: /\b(flight|airline|boarding|departure|arrival|layover|stopover|round.?trip|one.?way|economy|business.?class|check.?in|baggage|flug|flüge|abflug|ankunft|umstieg|hinflug|rückflug)\b/i, type: 'travel', weight: 0.7 },
  { keywords: /\b(book(ing)?|hotel|hostel|resort|vacation|holiday|rental|zimmer|unterkunft|reise|urlaub)\b/i, type: 'travel', weight: 0.5 },
  { keywords: /\b(add.?to.?cart|buy.?now|checkout|price|shipping|delivery|order|warenkorb|kaufen|bestellen|versand|lieferung)\b/i, type: 'shopping', weight: 0.7 },
  { keywords: /\b(property|listing|sqft|sq\.?m|bedroom|bathroom|mortgage|rent|lease|immobili|wohnung|haus|miete|kaufpreis|grundstück|fläche|zimmer)\b/i, type: 'realestate', weight: 0.7 },
  { keywords: /\b(account|balance|transfer|payment|transaction|deposit|withdraw|portfolio|dividend|stock|share|kontostand|überweisung|zahlung)\b/i, type: 'finance', weight: 0.6 },
  { keywords: /\b(post|tweet|like|share|follow|comment|story|feed|retweet|hashtag|follower)\b/i, type: 'social', weight: 0.5 },
  { keywords: /\b(commit|pull.?request|merge|branch|repository|issue|bug|deploy|npm|pip|cargo|dockerfile|api|endpoint|function|class|interface|const|let|var)\b/i, type: 'coding', weight: 0.6 },
  { keywords: /\b(recipe|restaurant|menu|delivery|order.?food|calories|ingredients|cuisine|rezept|zutaten|speisekarte)\b/i, type: 'food', weight: 0.6 },
  { keywords: /\b(diagnosis|symptom|treatment|medication|doctor|appointment|prescription|patient|therapie|arzt|medikament|diagnose)\b/i, type: 'health', weight: 0.6 },
  { keywords: /\b(job|career|resume|cv|salary|hiring|apply|application|interview|stellenangebot|bewerbung|gehalt|lebenslauf)\b/i, type: 'jobs', weight: 0.6 },
  { keywords: /\b(course|lesson|lecture|quiz|exam|assignment|student|professor|enrollment|kurs|vorlesung|prüfung|aufgabe)\b/i, type: 'education', weight: 0.5 },
]

// ─── Persona definitions ─────────────────────────────────────────────────────

const PERSONAS: Record<PageType, string> = {
  email: `You are also an expert email communicator. Write professional, clear, and concise emails. Match the tone of the conversation (formal for business, friendly for personal). Structure emails with proper greeting, body, and sign-off. Proofread for grammar and clarity. When reading emails, summarize key points and flag action items.`,

  travel: `You are also a professional travel agent and flight search specialist. Find the cheapest, fastest, and most optimal routes. Compare prices across airlines and dates. Consider layover duration, total travel time, and convenience. Know airline alliances, baggage policies, and visa requirements. Present options in a clear comparison table with prices, durations, and stops. Suggest flexible date ranges for better prices.`,

  shopping: `You are also a smart shopping assistant. Compare products by price, quality, and reviews. Find the best deals and discounts. Check product specifications carefully. Flag suspicious listings or fake reviews. Calculate total cost including shipping and taxes. Suggest alternatives if the product seems overpriced.`,

  realestate: `You are also a professional real estate analyst. Evaluate properties by location, price per sqm, condition, and investment potential. Research the neighborhood: infrastructure, schools, transport, crime rates, future development plans. Analyze price trends in the area. Flag potential issues (flood zones, noise, building defects). Calculate ROI for investment properties. Present findings as a structured buyer's report.`,

  finance: `You are also a financial analyst. Read account statements, transactions, and portfolio data accurately. Calculate totals, averages, and trends. Flag unusual transactions or fees. Never share or expose sensitive financial data. Present financial summaries clearly with proper formatting.`,

  social: `You are also a social media strategist. Help compose engaging posts and replies. Understand platform-specific best practices (character limits, hashtags, formatting). Analyze engagement patterns. Draft professional yet authentic messages. Be aware of platform etiquette and norms.`,

  coding: `You are also a senior software engineer. Read and understand code in any language. Help with pull requests, code reviews, and debugging. Write clean, well-documented code. Understand git workflows, CI/CD, and development best practices. Explain technical concepts clearly.`,

  docs: `You are also a technical writer and knowledge manager. Help organize, write, and edit documents. Create clear structure with headings, bullet points, and tables. Maintain consistent formatting. Summarize long documents efficiently. Help with collaborative editing.`,

  news: `You are also a research analyst. Read news articles critically, identify key facts, and separate opinion from reporting. Cross-reference claims when possible. Summarize articles concisely. Note publication date and source credibility. Flag potential bias or misinformation.`,

  video: `You are also a media curator. Help find relevant videos, understand video descriptions and comments. Summarize video content from available metadata. Help manage playlists and subscriptions.`,

  maps: `You are also a navigation and geography expert. Help find locations, plan routes, and understand distances. Know about public transport, traffic patterns, and local areas. Calculate travel times between locations.`,

  food: `You are also a food and restaurant expert. Help find restaurants, compare menus and reviews. Understand dietary requirements and cuisine types. Help with food ordering and delivery. Suggest recipes based on available ingredients.`,

  health: `You are also a health information assistant. Help navigate medical information carefully. Always recommend consulting a healthcare professional for medical decisions. Help find doctors, book appointments, and understand medical terminology. Never provide medical diagnoses.`,

  jobs: `You are also a career coach and recruitment specialist. Help optimize resumes and cover letters. Understand job requirements and match qualifications. Prepare for interviews. Research companies and salary ranges. Help with application tracking.`,

  legal: `You are also a legal research assistant. Help navigate legal documents and terminology. Always recommend consulting a qualified lawyer for legal decisions. Help find relevant laws and regulations. Summarize legal texts clearly.`,

  education: `You are also an educational tutor. Help with coursework, explain concepts clearly, and provide study strategies. Adapt explanations to the student's level. Create practice questions and summaries. Track learning progress.`,

  crm: `You are also a business operations specialist. Help manage customer data, sales pipelines, and project workflows. Understand CRM concepts and business processes. Help with task management and team coordination.`,

  general: '', // No special persona for generic pages
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify a page and return the appropriate expert persona.
 * Uses URL/domain first (fast), then falls back to content analysis.
 */
export function classifyPage(url: string, title: string, headings: string[], pageText: string): PageClassification {
  const domain = url.toLowerCase()

  // 1. Try domain rules first (fastest, most reliable)
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(domain)) {
      return {
        type: rule.type,
        confidence: 0.95,
        persona: PERSONAS[rule.type],
      }
    }
  }

  // 2. Content-based classification using title + headings + page text sample
  const contentSample = `${title} ${headings.join(' ')} ${pageText.slice(0, 3000)}`.toLowerCase()
  const scores = new Map<PageType, number>()

  for (const rule of CONTENT_RULES) {
    const matches = contentSample.match(rule.keywords)
    if (matches) {
      const hitCount = matches.length
      const score = (scores.get(rule.type) ?? 0) + rule.weight * Math.min(hitCount, 5)
      scores.set(rule.type, score)
    }
  }

  // Find the highest scoring type
  let bestType: PageType = 'general'
  let bestScore = 0
  for (const [type, score] of scores) {
    if (score > bestScore) {
      bestScore = score
      bestType = type
    }
  }

  // Only apply if confidence is meaningful (at least 2 keyword hits worth)
  if (bestScore >= 1.0) {
    const confidence = Math.min(bestScore / 3, 0.9)
    return {
      type: bestType,
      confidence,
      persona: PERSONAS[bestType],
    }
  }

  return { type: 'general', confidence: 0, persona: '' }
}

/**
 * Build the persona block for injection into the system prompt.
 * Returns empty string if page is generic or confidence is too low.
 */
export function getPersonaForPrompt(url: string, title: string, headings: string[], pageText: string): string {
  const classification = classifyPage(url, title, headings, pageText)

  if (!classification.persona || classification.type === 'general') {
    return ''
  }

  console.log(`[LocalAI] Page persona: ${classification.type} (confidence: ${Math.round(classification.confidence * 100)}%)`)

  return `## EXPERT ROLE — ${classification.type.toUpperCase()}
${classification.persona}`
}
