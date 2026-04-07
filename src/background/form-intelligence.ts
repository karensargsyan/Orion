/**
 * Form Intelligence — classifies form fields and matches vault profiles to form fields.
 */

import type {
  FormInfo,
  FormField,
  FillAssignment,
  VaultData,
  AddressData,
  CardData,
  ContactData,
  CredentialData,
  IdentityData,
} from '../shared/types'

type FieldHint =
  | 'firstName' | 'lastName' | 'fullName'
  | 'email' | 'phone'
  | 'username' | 'password'
  | 'street' | 'city' | 'state' | 'zip' | 'country'
  | 'cardNumber' | 'cardExpiry' | 'cardCvv' | 'cardholderName'
  | 'birthday' | 'company'
  | 'unknown'

const HINT_PATTERNS: Array<{ hint: FieldHint; patterns: RegExp[] }> = [
  {
    hint: 'firstName',
    patterns: [/first.?name/i, /vorname/i, /prénom/i, /given.?name/i, /fname/i],
  },
  {
    hint: 'lastName',
    patterns: [/last.?name/i, /nachname/i, /family.?name/i, /surname/i, /lname/i],
  },
  {
    hint: 'fullName',
    patterns: [/full.?name/i, /^name$/i, /your.?name/i, /display.?name/i],
  },
  {
    hint: 'email',
    patterns: [/e.?mail/i, /email.?address/i],
  },
  {
    hint: 'phone',
    patterns: [/phone/i, /mobile/i, /tel(ephone)?/i, /handy/i],
  },
  {
    hint: 'username',
    patterns: [/user.?name/i, /login/i, /account/i, /handle/i],
  },
  {
    hint: 'password',
    patterns: [/password/i, /passwort/i, /passwd/i, /pin/i],
  },
  {
    hint: 'street',
    patterns: [/street/i, /address.?1/i, /addr1/i, /line.?1/i, /straße/i],
  },
  {
    hint: 'city',
    patterns: [/city/i, /town/i, /ort/i, /locality/i],
  },
  {
    hint: 'state',
    patterns: [/state/i, /province/i, /region/i, /bundesland/i],
  },
  {
    hint: 'zip',
    patterns: [/zip/i, /postal/i, /postcode/i, /plz/i],
  },
  {
    hint: 'country',
    patterns: [/country/i, /land/i, /nation/i],
  },
  {
    hint: 'cardNumber',
    patterns: [/card.?num/i, /card.?no/i, /cc.?num/i, /credit.?card/i, /pan/i],
  },
  {
    hint: 'cardExpiry',
    patterns: [/expir/i, /exp.?date/i, /exp.?month/i, /mm.?yy/i, /valid/i],
  },
  {
    hint: 'cardCvv',
    patterns: [/cvv/i, /cvc/i, /csc/i, /security.?code/i, /card.?code/i],
  },
  {
    hint: 'cardholderName',
    patterns: [/cardholder/i, /name.?on.?card/i, /card.?name/i],
  },
  {
    hint: 'birthday',
    patterns: [/birth/i, /dob/i, /date.?of.?birth/i, /geburtstag/i],
  },
  {
    hint: 'company',
    patterns: [/company/i, /organization/i, /firm/i, /business/i, /employer/i],
  },
]

/** Classify a form field into a semantic hint. */
export function classifyField(field: FormField): FieldHint {
  // Check input type first
  if (field.type === 'email') return 'email'
  if (field.type === 'password') return 'password'
  if (field.type === 'tel') return 'phone'

  const searchIn = [field.name, field.label, field.autocomplete].join(' ')

  for (const { hint, patterns } of HINT_PATTERNS) {
    if (patterns.some(p => p.test(searchIn))) return hint
  }

  return 'unknown'
}

/** Generate fill assignments from a vault data object for a given form. */
export function matchVaultToForm(form: FormInfo, vaultData: VaultData): FillAssignment[] {
  const assignments: FillAssignment[] = []

  for (const field of form.fields) {
    const hint = classifyField(field)
    if (hint === 'unknown' || hint === 'password') continue // skip unknown and passwords (security)

    const value = resolveValue(hint, vaultData)
    if (value) {
      assignments.push({
        selector: field.selector,
        value,
        inputType: field.type,
      })
    }
  }

  return assignments
}

/** Also include password if explicitly requested (credential fill). */
export function matchCredentialsToForm(form: FormInfo, vaultData: VaultData): FillAssignment[] {
  const assignments: FillAssignment[] = []

  for (const field of form.fields) {
    const hint = classifyField(field)
    const value = resolveValue(hint, vaultData)
    if (value) {
      assignments.push({
        selector: field.selector,
        value,
        inputType: field.type,
      })
    }
  }

  return assignments
}

function resolveValue(hint: FieldHint, data: VaultData): string {
  const d = data as Record<string, string>

  switch (hint) {
    case 'firstName':   return d.firstName ?? ''
    case 'lastName':    return d.lastName ?? ''
    case 'fullName':    return [d.firstName, d.lastName].filter(Boolean).join(' ')
    case 'email':       return d.email ?? ''
    case 'phone':       return d.phone ?? ''
    case 'username':    return d.username ?? d.email ?? ''
    case 'password':    return d.password ?? ''
    case 'street':      return d.street ?? ''
    case 'city':        return d.city ?? ''
    case 'state':       return d.state ?? ''
    case 'zip':         return d.zip ?? ''
    case 'country':     return d.country ?? ''
    case 'cardNumber':  return d.number ?? ''
    case 'cardExpiry':  return d.expiry ?? ''
    case 'cardCvv':     return d.cvv ?? ''
    case 'cardholderName': return d.cardholderName ?? [d.firstName, d.lastName].filter(Boolean).join(' ')
    case 'birthday':    return d.birthday ?? ''
    case 'company':     return d.company ?? ''
    default:            return ''
  }
}

/** Describe a form in natural language for the AI. */
export function describeForm(form: FormInfo): string {
  const fields = form.fields.map(f => {
    const hint = classifyField(f)
    return `  - ${f.label || f.name || f.selector} [${hint !== 'unknown' ? hint : f.type}]${f.required ? ' (required)' : ''}`
  }).join('\n')
  return `Form (${form.method.toUpperCase()} ${form.action}):\n${fields}`
}
