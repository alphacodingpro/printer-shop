import * as jazzcash from './jazzcash.js';
import * as easypaisa from './easypaisa.js';
import { config } from '../config.js';

export const providers = { jazzcash, easypaisa };

export const gatewayFormHosts = [...jazzcash.FORM_HOSTS, ...easypaisa.FORM_HOSTS];

export function requiredFields(provider) {
  return providers[provider]?.REQUIRED ?? [];
}

export function availableProviders() {
  const list = ['easypaisa', 'jazzcash', 'cash'];
  if (config.enableMockPayments) list.push('mock');
  return list;
}
