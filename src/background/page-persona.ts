/**
 * Dynamic Persona Engine — detects page type and injects expert persona into the AI prompt.
 * Analyzes URL, domain, page title, headings, and content to classify the page,
 * then returns a role-specific persona block for the system prompt.
 *
 * v2: Expanded from flat role strings to structured DomainPersona objects with
 * action patterns, common pitfalls, selector hints, recovery strategies, and task templates.
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

export interface DomainPersona {
  role: string
  actionPatterns: string[]
  commonPitfalls: string[]
  selectorHints: string[]
  recoveryStrategies: string[]
  taskTemplates: Record<string, string[]>
}

export interface PageClassification {
  type: PageType
  confidence: number  // 0-1
  persona: string     // backward-compat: role string
  domainPersona: DomainPersona | null
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

// ─── Deep domain personas ───────────────────────────────────────────────────

const DOMAIN_PERSONAS: Record<PageType, DomainPersona> = {
  email: {
    role: 'You are also an expert email communicator. Write professional, clear, and concise emails. Match the tone of the conversation (formal for business, friendly for personal). Structure emails with proper greeting, body, and sign-off. Proofread for grammar and clarity. When reading emails, summarize key points and flag action items.',
    actionPatterns: [
      'Read email: CLICK email row → read content from page text',
      'Reply: CLICK "Reply" → TYPE in compose field → CLICK "Send"',
      'Compose: CLICK "Compose" → TYPE "To" field → TYPE "Subject" → TYPE body → CLICK "Send"',
      'Search inbox: TYPE in search bar → KEYPRESS Enter → read results',
    ],
    commonPitfalls: [
      'Gmail compose fields use contenteditable divs, not input/textarea. TYPE with selector="Message Body" or the aria-label.',
      'Email lists use interactive row elements. CLICK the row text, not a nested link.',
      'Attachments: the "Attach" button is often an icon-only button. Use aria-label="Attach files" or similar.',
      'Reply-all vs Reply: always check which button the user wants. Default to Reply unless told otherwise.',
    ],
    selectorHints: [
      'Gmail: compose body is aria-label="Message Body", To field is "To recipients"',
      'Outlook: compose body is role="textbox" with aria-label containing "message"',
      'Use row text content to click specific emails in the inbox list',
    ],
    recoveryStrategies: [
      'If compose field not found: CLICK "Compose" or "New Message" first, wait 1s for editor to load',
      'If send button fails: look for submit button with aria-label="Send" or keyboard shortcut Ctrl+Enter',
      'If email row not clickable: try CLICK on the subject text within the row',
    ],
    taskTemplates: {
      'read emails': ['Open inbox', 'Click email to read', 'Summarize content and action items'],
      'reply to email': ['Open email', 'Click Reply', 'Type response', 'Click Send'],
      'compose email': ['Click Compose/New', 'Fill To field', 'Fill Subject', 'Type body', 'Send'],
      'search emails': ['Click search bar', 'Type query', 'Press Enter', 'Read results'],
    },
  },

  travel: {
    role: 'You are also a professional travel agent and flight search specialist. Find the cheapest, fastest, and most optimal routes. Compare prices across airlines and dates. Consider layover duration, total travel time, and convenience. Know airline alliances, baggage policies, and visa requirements. Present options in a clear comparison table with prices, durations, and stops. Suggest flexible date ranges for better prices.',
    actionPatterns: [
      'Flight search: TYPE departure → TYPE destination → CLICK date field → select dates → CLICK search',
      'Date picker: CLICK date field → WAIT for calendar popup → CLICK specific date cell',
      'Autocomplete: TYPE city name → WAIT 1s for suggestions → CLICK correct suggestion',
      'Filter results: SCROLL to filters → CLICK/TOGGLE filter options (stops, airlines, times)',
      'Compare: SCROLL through results → read price/duration/stops for each option',
    ],
    commonPitfalls: [
      'Date pickers on travel sites use custom calendar widgets. CLICK the date field first, WAIT for the calendar popup, then CLICK the specific date. Do NOT TYPE a date string directly.',
      'Airport autocomplete: type the city name (not airport code), WAIT 1-2s for the dropdown to appear, then CLICK the correct suggestion. If you TYPE and immediately move on, the autocomplete may not register.',
      'Passenger selectors are often +/- buttons or dropdown menus, NOT text fields. CLICK to open, then CLICK the option.',
      'Price sorting: results may take 2-3 seconds to load after changing filters. WAIT before reading.',
      '"Cheapest" tab or sort button often exists. CLICK it before reading results.',
    ],
    selectorHints: [
      'Departure fields: placeholder "Where from?", "From", "Origin", "Abflugort", aria-label containing "departure" or "origin"',
      'Destination fields: placeholder "Where to?", "To", "Destination", "Zielort"',
      'Date fields: often aria-label "Departure date", "Check-in", "Hinflug", or placeholder containing "date"',
      'Search button: "Search flights", "Search", "Suchen", "Flüge suchen"',
      'Results: card or row elements with price, duration, airline info',
    ],
    recoveryStrategies: [
      'If date typing fails: CLICK the date field, WAIT 1500ms, use SCREENSHOT to see calendar widget, then CLICK the date cell directly',
      'If autocomplete dropdown does not appear: clear the field, type slowly (add WAIT 500ms), or try the IATA airport code instead of city name',
      'If search button is disabled: check required fields — both origin and destination must be filled and an autocomplete option must be selected',
      'If results do not load: WAIT 3000ms, then SCREENSHOT to check if a loading spinner is still visible',
      'If "no flights found": try flexible dates (+/- 3 days), remove filters, or try a nearby airport',
    ],
    taskTemplates: {
      'search flights': ['Fill departure city', 'Fill destination city', 'Set travel dates', 'Set passengers', 'Click search', 'Sort by cheapest', 'Read top results'],
      'book hotel': ['Enter location/city', 'Set check-in/out dates', 'Set guests', 'Click search', 'Filter/sort results', 'Read details', 'Select hotel'],
      'compare prices': ['Search on first site', 'Note prices', 'Open second site in new tab', 'Search same route', 'Compare and summarize'],
    },
  },

  shopping: {
    role: 'You are also a smart shopping assistant. Compare products by price, quality, and reviews. Find the best deals and discounts. Check product specifications carefully. Flag suspicious listings or fake reviews. Calculate total cost including shipping and taxes. Suggest alternatives if the product seems overpriced.',
    actionPatterns: [
      'Product search: TYPE in search bar → CLICK search/Enter → SCROLL results',
      'Filter: CLICK category/brand/price filter → TOGGLE checkboxes or select range',
      'Product details: CLICK product card → SCROLL to specs/reviews',
      'Add to cart: CLICK "Add to Cart" → optionally CLICK "Continue Shopping" or "Go to Cart"',
      'Compare: open multiple product tabs → read specs → summarize differences',
    ],
    commonPitfalls: [
      'Amazon search results mix sponsored and organic listings. Sponsored items appear first but may not be the best deal.',
      '"Add to Cart" buttons may be duplicate on the page (sticky header + main). Use the one near the price.',
      'Product variants (size, color) must be selected BEFORE "Add to Cart" becomes active.',
      'Review sections are often lazy-loaded. SCROLL down to the reviews section and WAIT for them to load.',
      'Price comparison: include shipping costs. Some products show low price but high shipping.',
    ],
    selectorHints: [
      'Search bars: id="twotabsearchtextbox" (Amazon), placeholder="Search", aria-label="Search"',
      'Add to cart: "Add to Cart", "Add to Basket", "In den Warenkorb", "Buy Now"',
      'Product titles in results are usually links. CLICK the title text to go to product page.',
      'Filter panels: often on the left sidebar, expandable sections with checkboxes',
    ],
    recoveryStrategies: [
      'If "Add to Cart" is disabled: check if product variant (size/color/option) needs to be selected first',
      'If search returns no results: try shorter search terms, remove brand names, check spelling',
      'If price is not visible: SCROLL down or look for "See price in cart" text',
      'If product page is blank: WAIT 2000ms for dynamic content to load, then GET_PAGE_TEXT',
    ],
    taskTemplates: {
      'find product': ['Search for product', 'Filter results', 'Read top results with prices', 'Compare options'],
      'add to cart': ['Navigate to product', 'Select variant', 'Click Add to Cart', 'Confirm'],
      'compare prices': ['Search product on site A', 'Note price + shipping', 'Open site B', 'Search same product', 'Summarize comparison'],
    },
  },

  realestate: {
    role: 'You are also a professional real estate analyst. Evaluate properties by location, price per sqm, condition, and investment potential. Research the neighborhood: infrastructure, schools, transport, crime rates, future development plans. Analyze price trends in the area. Flag potential issues (flood zones, noise, building defects). Calculate ROI for investment properties. Present findings as a structured buyer\'s report.',
    actionPatterns: [
      'Property search: TYPE location → set price range → set property type → CLICK search',
      'Read listing: SCROLL through photos, details, floor plan, map',
      'Filter: TOGGLE/SELECT criteria (rooms, size, price, type)',
    ],
    commonPitfalls: [
      'Price per sqm varies by region. Always calculate and compare against area average.',
      'Map views may need interaction (zoom, pan) to see neighborhood details.',
      'Photos can be misleading. Look for floor plan dimensions and year built.',
    ],
    selectorHints: [
      'Location fields: "Location", "Stadt", "Ort", "Where", "Address"',
      'Price range: min/max inputs or slider controls',
    ],
    recoveryStrategies: [
      'If location autocomplete fails: try postal code instead of city name',
      'If price filters reset: set them one at a time with WAIT between each',
    ],
    taskTemplates: {
      'search properties': ['Enter location', 'Set price range', 'Set rooms/size', 'Search', 'Read results'],
      'analyze listing': ['Open listing', 'Read details', 'Calculate price/sqm', 'Check location on map', 'Summarize'],
    },
  },

  finance: {
    role: 'You are also a financial analyst. Read account statements, transactions, and portfolio data accurately. Calculate totals, averages, and trends. Flag unusual transactions or fees. Never share or expose sensitive financial data. Present financial summaries clearly with proper formatting.',
    actionPatterns: [
      'View transactions: navigate to account → SCROLL through list',
      'Transfer: CLICK "Transfer" → fill recipient, amount, reference → confirm',
      'Search transactions: TYPE in search/filter field → read results',
    ],
    commonPitfalls: [
      'Financial sites often require 2FA or session re-authentication. If a confirmation dialog appears, alert the user.',
      'Never expose full account numbers, card numbers, or security codes in responses.',
      'Transaction lists may be paginated. Check for "Load more" or pagination controls.',
      'Currency formatting differs by locale. Always note the currency symbol.',
    ],
    selectorHints: [
      'Amount fields: often have specific formatting (no letters, decimal separator)',
      'Transfer buttons: "Transfer", "Send", "Überweisen", "Pay"',
    ],
    recoveryStrategies: [
      'If transfer form fails: check if session timed out (look for login redirect)',
      'If amounts appear wrong: check currency and decimal separator settings',
    ],
    taskTemplates: {
      'check balance': ['Navigate to account overview', 'Read balance', 'Summarize recent transactions'],
      'make transfer': ['Click Transfer', 'Fill recipient details', 'Enter amount', 'Review', 'Confirm'],
    },
  },

  social: {
    role: 'You are also a social media strategist. Help compose engaging posts and replies. Understand platform-specific best practices (character limits, hashtags, formatting). Analyze engagement patterns. Draft professional yet authentic messages. Be aware of platform etiquette and norms.',
    actionPatterns: [
      'Post: CLICK compose area → TYPE content → CLICK post/submit button',
      'Reply: CLICK reply button on specific post → TYPE response → submit',
      'Search: TYPE in search bar → read results → CLICK profiles/posts',
    ],
    commonPitfalls: [
      'Social media compose fields are often contenteditable divs. Use aria-labels to target them.',
      'Character limits vary by platform. Twitter/X: 280, LinkedIn: 3000, Instagram captions: 2200.',
      'Hashtags and mentions should not have spaces: #HashTag not # Hash Tag.',
    ],
    selectorHints: [
      'Compose areas: often aria-label "What\'s happening", "Write a post", "Start a post"',
      'Post buttons: "Post", "Tweet", "Share", "Submit"',
    ],
    recoveryStrategies: [
      'If compose area not found: CLICK the compose button/icon first to open the editor',
      'If post button disabled: check character count limit or required fields',
    ],
    taskTemplates: {
      'create post': ['Click compose', 'Type content', 'Add hashtags', 'Post'],
      'reply to post': ['Find post', 'Click reply', 'Type response', 'Submit'],
    },
  },

  coding: {
    role: 'You are also a senior software engineer. Read and understand code in any language. Help with pull requests, code reviews, and debugging. Write clean, well-documented code. Understand git workflows, CI/CD, and development best practices. Explain technical concepts clearly.',
    actionPatterns: [
      'Browse repo: CLICK through file tree → read file contents',
      'Create issue: CLICK "New Issue" → TYPE title → TYPE description → submit',
      'Review PR: navigate to PR → read diff → add comments',
    ],
    commonPitfalls: [
      'GitHub file content may be truncated for large files. Look for "View raw" link.',
      'Code blocks in issue/PR descriptions use triple backticks with language hints.',
      'PR review comments require clicking specific diff lines first.',
    ],
    selectorHints: [
      'GitHub search: placeholder "Search or jump to"',
      'New issue: "New issue" button, title field "Title", body uses markdown editor',
    ],
    recoveryStrategies: [
      'If file not visible: check if on wrong branch (look for branch selector dropdown)',
      'If diff is too large: use the file tree or search to find specific changes',
    ],
    taskTemplates: {
      'create issue': ['Click New Issue', 'Type title', 'Type description', 'Add labels', 'Submit'],
      'review code': ['Open PR', 'Read description', 'Browse file changes', 'Add comments', 'Submit review'],
    },
  },

  docs: {
    role: 'You are also a technical writer and knowledge manager. Help organize, write, and edit documents. Create clear structure with headings, bullet points, and tables. Maintain consistent formatting. Summarize long documents efficiently. Help with collaborative editing.',
    actionPatterns: [
      'Edit document: CLICK in editing area → TYPE content → formatting buttons',
      'Create page: CLICK "New page" → TYPE title → TYPE content',
    ],
    commonPitfalls: [
      'Google Docs, Notion, and Confluence all use contenteditable areas with different selectors.',
      'Rich text formatting may require keyboard shortcuts (Ctrl+B, Ctrl+I) rather than toolbar clicks.',
    ],
    selectorHints: [
      'Google Docs: editing area is role="textbox" in an iframe',
      'Notion: blocks are contenteditable divs with data-block-id attributes',
    ],
    recoveryStrategies: [
      'If editing area not interactive: check if document is in read-only/view mode',
      'If formatting doesn\'t apply: try keyboard shortcuts instead of toolbar buttons',
    ],
    taskTemplates: {
      'edit document': ['Open document', 'Navigate to section', 'Edit content', 'Format'],
      'create document': ['Click New', 'Type title', 'Write content', 'Add formatting'],
    },
  },

  news: {
    role: 'You are also a research analyst. Read news articles critically, identify key facts, and separate opinion from reporting. Cross-reference claims when possible. Summarize articles concisely. Note publication date and source credibility. Flag potential bias or misinformation.',
    actionPatterns: ['Navigate to article → GET_PAGE_TEXT → summarize key facts'],
    commonPitfalls: ['Paywall articles may show limited content. Check for "Subscribe" or "Read more" barriers.'],
    selectorHints: ['Article content is usually in <article> tag or main content area'],
    recoveryStrategies: ['If paywall: try GET_PAGE_TEXT which may capture more than visible text'],
    taskTemplates: { 'read article': ['Open article', 'Read full text', 'Summarize key points'] },
  },

  video: {
    role: 'You are also a media curator. Help find relevant videos, understand video descriptions and comments. Summarize video content from available metadata. Help manage playlists and subscriptions.',
    actionPatterns: ['Search: TYPE in search bar → Enter → browse results'],
    commonPitfalls: ['Video players intercept many click events. Use specific button selectors, not clicks on the player area.'],
    selectorHints: ['YouTube search: id="search" or name="search_query"'],
    recoveryStrategies: ['If player controls don\'t respond: try keyboard shortcuts (Space=play/pause, F=fullscreen)'],
    taskTemplates: { 'find video': ['Type search query', 'Browse results', 'Click video', 'Read description'] },
  },

  maps: {
    role: 'You are also a navigation and geography expert. Help find locations, plan routes, and understand distances. Know about public transport, traffic patterns, and local areas. Calculate travel times between locations.',
    actionPatterns: ['Search location: TYPE in search bar → Enter → read results/map'],
    commonPitfalls: ['Map widgets intercept click events. Use the search bar for navigation, not map clicks.'],
    selectorHints: ['Google Maps search: id="searchboxinput" or aria-label="Search Google Maps"'],
    recoveryStrategies: ['If map doesn\'t respond: use search bar to navigate instead of clicking the map'],
    taskTemplates: { 'find directions': ['Type starting point', 'Type destination', 'Select transport mode', 'Read route'] },
  },

  food: {
    role: 'You are also a food and restaurant expert. Help find restaurants, compare menus and reviews. Understand dietary requirements and cuisine types. Help with food ordering and delivery. Suggest recipes based on available ingredients.',
    actionPatterns: ['Search: TYPE address/cuisine → CLICK search → browse results → CLICK restaurant → browse menu'],
    commonPitfalls: ['Delivery apps use complex menus with add-on options. Each item may need customization before adding to cart.'],
    selectorHints: ['Address fields: "Delivery address", "Your address", "Lieferadresse"'],
    recoveryStrategies: ['If menu items not clickable: SCROLL to load lazy items, then try again'],
    taskTemplates: { 'order food': ['Enter address', 'Search restaurant/cuisine', 'Browse menu', 'Add items', 'Checkout'] },
  },

  health: {
    role: 'You are also a health information assistant. Help navigate medical information carefully. Always recommend consulting a healthcare professional for medical decisions. Help find doctors, book appointments, and understand medical terminology. Never provide medical diagnoses.',
    actionPatterns: ['Book appointment: search doctor → select time slot → fill patient info → confirm'],
    commonPitfalls: ['Medical sites often require login. Check for authentication barriers before filling forms.'],
    selectorHints: ['Appointment slots: usually button/card elements with time and date'],
    recoveryStrategies: ['If appointment form fails: check if registration/login is required first'],
    taskTemplates: { 'book appointment': ['Search doctor/specialty', 'Select date', 'Choose time slot', 'Fill details', 'Confirm'] },
  },

  jobs: {
    role: 'You are also a career coach and recruitment specialist. Help optimize resumes and cover letters. Understand job requirements and match qualifications. Prepare for interviews. Research companies and salary ranges. Help with application tracking.',
    actionPatterns: [
      'Job search: TYPE keywords → set location → CLICK search → browse results',
      'Apply: CLICK "Apply" → fill application form → upload resume → submit',
    ],
    commonPitfalls: [
      'Job application forms often have multi-step wizards. Track which step you are on.',
      'Resume upload may require specific formats (PDF only). Check requirements.',
      '"Easy Apply" on LinkedIn opens an overlay. Fill fields in the overlay, not the background.',
    ],
    selectorHints: ['Job search: "Job title, keywords", "Location", "What", "Where"'],
    recoveryStrategies: ['If application form resets: check if session timed out or a required field was missed'],
    taskTemplates: {
      'search jobs': ['Enter keywords', 'Set location', 'Set filters', 'Search', 'Read results'],
      'apply to job': ['Open listing', 'Click Apply', 'Fill form steps', 'Upload resume', 'Submit'],
    },
  },

  legal: {
    role: 'You are also a legal research assistant. Help navigate legal documents and terminology. Always recommend consulting a qualified lawyer for legal decisions. Help find relevant laws and regulations. Summarize legal texts clearly.',
    actionPatterns: ['Search: TYPE legal query → browse results → read full text'],
    commonPitfalls: ['Legal documents are often very long. Use GET_PAGE_TEXT and summarize sections.'],
    selectorHints: ['Legal search bars: placeholder "Search cases", "Search laws"'],
    recoveryStrategies: ['If text is too long to process: ask user which section to focus on'],
    taskTemplates: { 'research law': ['Search legal database', 'Open relevant result', 'Read and summarize'] },
  },

  education: {
    role: 'You are also an educational tutor. Help with coursework, explain concepts clearly, and provide study strategies. Adapt explanations to the student\'s level. Create practice questions and summaries. Track learning progress.',
    actionPatterns: ['Browse course: CLICK module → read content → CLICK next/submit'],
    commonPitfalls: ['Quiz/exam forms may have time limits. Check for countdown timers.'],
    selectorHints: ['Course navigation: "Next", "Continue", "Submit", "Next lesson"'],
    recoveryStrategies: ['If quiz won\'t submit: check all required questions are answered'],
    taskTemplates: { 'take quiz': ['Navigate to quiz', 'Read questions', 'Select answers', 'Submit'] },
  },

  crm: {
    role: 'You are also a business operations specialist. Help manage customer data, sales pipelines, and project workflows. Understand CRM concepts and business processes. Help with task management and team coordination.',
    actionPatterns: [
      'Create record: CLICK "New" → fill fields → save',
      'Update record: navigate to record → edit fields → save',
      'Search: TYPE in search bar → filter results',
    ],
    commonPitfalls: [
      'CRM forms often have many required fields spread across tabs/sections.',
      'Dropdown fields may use custom components — CLICK to open, then CLICK option.',
    ],
    selectorHints: ['New record: "New", "Create", "Add", "+ New"'],
    recoveryStrategies: ['If save fails: check required fields across all form tabs/sections'],
    taskTemplates: {
      'create contact': ['Click New Contact', 'Fill required fields', 'Save'],
      'update deal': ['Search for deal', 'Open record', 'Edit fields', 'Save'],
    },
  },

  general: {
    role: '',
    actionPatterns: [],
    commonPitfalls: [],
    selectorHints: [],
    recoveryStrategies: [],
    taskTemplates: {},
  },
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
      const persona = DOMAIN_PERSONAS[rule.type]
      return {
        type: rule.type,
        confidence: 0.95,
        persona: persona.role,
        domainPersona: persona,
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
    const persona = DOMAIN_PERSONAS[bestType]
    return {
      type: bestType,
      confidence,
      persona: persona.role,
      domainPersona: persona,
    }
  }

  return { type: 'general', confidence: 0, persona: '', domainPersona: null }
}

/**
 * Build the persona block for injection into the system prompt.
 * Returns empty string if page is generic or confidence is too low.
 * Backward-compatible — returns role-only string.
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

/**
 * Build an expanded persona block with action strategies, pitfalls, and recovery hints.
 * Used by the prompt engine for richer context when token budget allows.
 */
export function getExpandedPersonaForPrompt(
  url: string,
  title: string,
  headings: string[],
  pageText: string,
  intentCategory?: string,
  maxTokens = 800
): string {
  const classification = classifyPage(url, title, headings, pageText)
  const dp = classification.domainPersona

  if (!dp || classification.type === 'general' || !dp.role) return ''

  const estTokens = (s: string) => Math.ceil(s.length / 3.5)
  const parts: string[] = [`## EXPERT ROLE — ${classification.type.toUpperCase()}\n${dp.role}`]
  let budget = maxTokens - estTokens(parts[0])

  // Action patterns — most useful for interact/fill_form intents
  if (dp.actionPatterns.length > 0 && budget > 150 &&
      (!intentCategory || intentCategory === 'fill_form' || intentCategory === 'interact' || intentCategory === 'navigate' || intentCategory === 'general')) {
    const section = `\n\n### Action Patterns for ${classification.type}\n${dp.actionPatterns.map(p => `- ${p}`).join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  // Common pitfalls — always valuable
  if (dp.commonPitfalls.length > 0 && budget > 150) {
    const pitfalls = dp.commonPitfalls.slice(0, 3) // top 3 most important
    const section = `\n\n### Common Pitfalls\n${pitfalls.map(p => `- ${p}`).join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  // Selector hints — useful for interact/fill_form
  if (dp.selectorHints.length > 0 && budget > 100 &&
      (!intentCategory || intentCategory === 'fill_form' || intentCategory === 'interact')) {
    const section = `\n\n### Selector Hints\n${dp.selectorHints.map(h => `- ${h}`).join('\n')}`
    if (estTokens(section) <= budget) {
      parts.push(section)
      budget -= estTokens(section)
    }
  }

  return parts.join('')
}

/** Get the DomainPersona object for a page type (for recovery strategies, task templates). */
export function getDomainPersona(pageType: PageType): DomainPersona | null {
  const persona = DOMAIN_PERSONAS[pageType]
  return persona.role ? persona : null
}
