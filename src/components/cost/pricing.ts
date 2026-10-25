// ClickHouse Cloud list prices, copied from the pricing calculator data on
// https://clickhouse.com/pricing. Compute is $ per unit-hour (1 unit = 8 GiB
// RAM, 2 vCPU per replica), storage $ per TB-month (also used for backups),
// data transfer $ per GB. Users can override any value in Settings.
export const LIST_PRICES_SOURCE = 'https://clickhouse.com/pricing';
export const LIST_PRICES_FETCHED = '2026-10-25';

export type Tier = 'basic' | 'scale' | 'enterprise';
export const TIERS: Tier[] = ['basic', 'scale', 'enterprise'];

export interface RegionPrice {
  label: string;
  compute: Record<Tier, number>;
  storageTbMonth: number;
  internetEgressGb: number;
  interRegionEgressGb: number;
}

export const LIST_PRICES: Record<string, RegionPrice> = {
  'af-south-1': { label: "Cape Town (af-south-1)", compute: { basic: 0.28952, scale: 0.39619, enterprise: 0.5181 }, storageTbMonth: 30.14, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'ap-east-1': { label: "Hong Kong (ap-east-1)", compute: { basic: 0.29917, scale: 0.4094, enterprise: 0.53537 }, storageTbMonth: 27.5, internetEgressGb: 0.1512, interRegionEgressGb: 0.1152 },
  'ap-northeast-1': { label: "Tokyo (ap-northeast-1)", compute: { basic: 0.2818, scale: 0.38563, enterprise: 0.50428 }, storageTbMonth: 27.5, internetEgressGb: 0.144, interRegionEgressGb: 0.1152 },
  'ap-northeast-2': { label: "Seoul (ap-northeast-2)", compute: { basic: 0.26829, scale: 0.36714, enterprise: 0.4801 }, storageTbMonth: 27.5, internetEgressGb: 0.144, interRegionEgressGb: 0.1248 },
  'ap-south-1': { label: "Mumbai (ap-south-1)", compute: { basic: 0.23548, scale: 0.32223, enterprise: 0.42138 }, storageTbMonth: 27.5, internetEgressGb: 0.1384, interRegionEgressGb: 0.1104 },
  'ap-southeast-1': { label: "Singapore (ap-southeast-1)", compute: { basic: 0.27215, scale: 0.37242, enterprise: 0.48701 }, storageTbMonth: 27.5, internetEgressGb: 0.1512, interRegionEgressGb: 0.1152 },
  'ap-southeast-2': { label: "Sydney (ap-southeast-2)", compute: { basic: 0.27408, scale: 0.37506, enterprise: 0.49046 }, storageTbMonth: 27.5, internetEgressGb: 0.144, interRegionEgressGb: 0.1248 },
  'ap-southeast-3': { label: "Jakarta (ap-southeast-3)", compute: { basic: 0.27215, scale: 0.37242, enterprise: 0.48701 }, storageTbMonth: 27.5, internetEgressGb: 0.144, interRegionEgressGb: 0.1248 },
  'azure-australiaeast': { label: "Australia East (australiaeast)", compute: { basic: 0.30293, scale: 0.41454, enterprise: 0.54209 }, storageTbMonth: 27.5, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'azure-eastus2': { label: "Virginia (eastus2)", compute: { basic: 0.24107, scale: 0.32988, enterprise: 0.43138 }, storageTbMonth: 25.3, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'azure-germanywestcentral': { label: "Frankfurt (germanywestcentral)", compute: { basic: 0.29013, scale: 0.39702, enterprise: 0.51919 }, storageTbMonth: 24.75, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'azure-japaneast': { label: "Tokyo (japaneast)", compute: { basic: 0.31147, scale: 0.42622, enterprise: 0.55736 }, storageTbMonth: 27.5, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'azure-uaenorth': { label: "Dubai (uaenorth)", compute: { basic: 0.29573, scale: 0.40469, enterprise: 0.52921 }, storageTbMonth: 27.8784, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'azure-westus3': { label: "Arizona (westus3)", compute: { basic: 0.24107, scale: 0.32988, enterprise: 0.43138 }, storageTbMonth: 25.3, internetEgressGb: 0.102, interRegionEgressGb: 0.03 },
  'ca-central-1': { label: "Canada (ca-central-1)", compute: { basic: 0.2432, scale: 0.3328, enterprise: 0.4352 }, storageTbMonth: 27.5, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'eu-central-1': { label: "Frankfurt (eu-central-1)", compute: { basic: 0.2625, scale: 0.35921, enterprise: 0.46974 }, storageTbMonth: 26.95, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'eu-north-1': { label: "Stockholm (eu-north-1)", compute: { basic: 0.23162, scale: 0.31695, enterprise: 0.41448 }, storageTbMonth: 25.3, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'eu-west-1': { label: "Ireland (eu-west-1)", compute: { basic: 0.2432, scale: 0.3328, enterprise: 0.4352 }, storageTbMonth: 25.3, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'eu-west-2': { label: "London (eu-west-2)", compute: { basic: 0.25285, scale: 0.34601, enterprise: 0.45247 }, storageTbMonth: 26.4, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'gcp-asia-northeast1': { label: "Tokyo (asia-northeast1)", compute: { basic: 0.23497, scale: 0.32153, enterprise: 0.42046 }, storageTbMonth: 25.3, internetEgressGb: 0.114, interRegionEgressGb: 0.162 },
  'gcp-asia-southeast1': { label: "Singapore (asia-southeast1)", compute: { basic: 0.22297, scale: 0.30512, enterprise: 0.399 }, storageTbMonth: 22, internetEgressGb: 0.144, interRegionEgressGb: 0.162 },
  'gcp-australia-southeast1': { label: "Sydney (australia-southeast1)", compute: { basic: 0.25814, scale: 0.35325, enterprise: 0.46194 }, storageTbMonth: 25.3, internetEgressGb: 0.114, interRegionEgressGb: 0.162 },
  'gcp-europe-west2': { label: "London (europe-west2)", compute: { basic: 0.23387, scale: 0.32003, enterprise: 0.4185 }, storageTbMonth: 25.3, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-europe-west3': { label: "Frankfurt (europe-west3)", compute: { basic: 0.23387, scale: 0.32003, enterprise: 0.4185 }, storageTbMonth: 25.3, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-europe-west4': { label: "Netherlands (europe-west4)", compute: { basic: 0.20133, scale: 0.2755, enterprise: 0.36027 }, storageTbMonth: 22, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-europe-west6': { label: "Zurich (europe-west6)", compute: { basic: 0.25388, scale: 0.34741, enterprise: 0.45431 }, storageTbMonth: 27.5, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-northamerica-northeast1': { label: "Montr\u00e9al (northamerica-northeast1)", compute: { basic: 0.20133, scale: 0.2755, enterprise: 0.36027 }, storageTbMonth: 25.3, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-us-central1': { label: "Iowa (us-central1)", compute: { basic: 0.18289, scale: 0.25027, enterprise: 0.32727 }, storageTbMonth: 22, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-us-east1': { label: "South Carolina (us-east1)", compute: { basic: 0.18289, scale: 0.25027, enterprise: 0.32727 }, storageTbMonth: 22, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'gcp-us-west1': { label: "Oregon (us-west1)", compute: { basic: 0.18289, scale: 0.25027, enterprise: 0.32727 }, storageTbMonth: 22, internetEgressGb: 0.114, interRegionEgressGb: 0.036 },
  'il-central-1': { label: "Tel Aviv (il-central-1)", compute: { basic: 0.25538, scale: 0.34947, enterprise: 0.457 }, storageTbMonth: 27.5, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'mx-central-1': { label: "Mexico (mx-central-1)", compute: { basic: 0.22939, scale: 0.3139, enterprise: 0.41049 }, storageTbMonth: 26.565, internetEgressGb: 0.1512, interRegionEgressGb: 0.1152 },
  'sa-east-1': { label: "S\u00e3o Paulo (sa-east-1)", compute: { basic: 0.34743, scale: 0.47543, enterprise: 0.62171 }, storageTbMonth: 44.55, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'us-east-1': { label: "N. Virginia (us-east-1)", compute: { basic: 0.21811, scale: 0.29846, enterprise: 0.3903 }, storageTbMonth: 25.3, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'us-east-2': { label: "Ohio (us-east-2)", compute: { basic: 0.21811, scale: 0.29846, enterprise: 0.3903 }, storageTbMonth: 25.3, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
  'us-west-2': { label: "Oregon (us-west-2)", compute: { basic: 0.21811, scale: 0.29846, enterprise: 0.3903 }, storageTbMonth: 25.3, internetEgressGb: 0.1152, interRegionEgressGb: 0.0312 },
};

// Region keys follow the pricing page: AWS regions as-is, GCP / Azure prefixed.
export function regionKey(provider: string | null | undefined, region: string | null | undefined): string {
  const p = (provider || 'aws').toLowerCase();
  const r = (region || '').toLowerCase();
  return p === 'aws' ? r : `${p}-${r}`;
}

// Map the API's organizationTier (BASIC/SCALE/ENTERPRISE) or legacy service
// tier (development/production) onto a price tier.
export function toTier(value: string | null | undefined): Tier {
  const v = (value || '').toLowerCase();
  if (v === 'basic' || v === 'development') return 'basic';
  if (v === 'enterprise' || v.startsWith('dedicated')) return 'enterprise';
  return 'scale';
}

export const DAYS_PER_MONTH = 30.4;
export const GIB_PER_UNIT = 8;
