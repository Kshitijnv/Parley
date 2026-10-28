import type { CompanyHit } from './types'

// Static company list for the S07 autocomplete. Logos are added by main when a
// logo.dev key is saved; without one the field shows initials.
const COMPANIES: Array<[string, string]> = [
  ['Microsoft', 'microsoft.com'],
  ['Google', 'google.com'],
  ['Amazon', 'amazon.com'],
  ['Meta', 'meta.com'],
  ['Apple', 'apple.com'],
  ['Netflix', 'netflix.com'],
  ['Salesforce', 'salesforce.com'],
  ['Atlassian', 'atlassian.com'],
  ['Adobe', 'adobe.com'],
  ['Infosys', 'infosys.com'],
  ['Tata Consultancy Services', 'tcs.com'],
  ['Wipro', 'wipro.com'],
  ['Accenture', 'accenture.com'],
  ['Deloitte', 'deloitte.com'],
  ['Flipkart', 'flipkart.com'],
  ['Zomato', 'zomato.com'],
  ['Swiggy', 'swiggy.com'],
  ['Razorpay', 'razorpay.com'],
  ['Freshworks', 'freshworks.com'],
  ['Zoho', 'zoho.com'],
  ['Shopify', 'shopify.com'],
  ['Stripe', 'stripe.com'],
  ['Uber', 'uber.com'],
  ['Oracle', 'oracle.com'],
  ['SAP', 'sap.com'],
  ['IBM', 'ibm.com'],
  ['Intel', 'intel.com'],
  ['NVIDIA', 'nvidia.com'],
  ['Cisco', 'cisco.com'],
  ['JPMorgan Chase', 'jpmorganchase.com'],
  ['Goldman Sachs', 'goldmansachs.com'],
]

export function searchCompanies(q: string): CompanyHit[] {
  const t = q.trim().toLowerCase()
  if (!t) return []
  return COMPANIES.filter(([n, d]) => n.toLowerCase().includes(t) || d.startsWith(t))
    .sort(([a], [b]) => Number(!a.toLowerCase().startsWith(t)) - Number(!b.toLowerCase().startsWith(t)))
    .slice(0, 6)
    .map(([name, domain]) => ({ name, domain, logoUrl: null }))
}
