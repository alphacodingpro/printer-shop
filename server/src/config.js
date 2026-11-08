import 'dotenv/config';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL === 'true',
  jwtSecret: env.JWT_SECRET,
  encryptionKey: env.ENCRYPTION_KEY,
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  storageDir: env.STORAGE_DIR || './storage',
  maxFileMb: Number(env.MAX_FILE_MB || 25),
  maxPages: Number(env.MAX_PAGES || 300),
  requireApproval: env.REQUIRE_SHOP_APPROVAL === 'true',
  trialDays: Number(env.TRIAL_DAYS || 14),
  enableMockPayments: (env.ENABLE_MOCK_PAYMENTS ?? (isProd ? 'false' : 'true')) === 'true' && !isProd,
  sofficePath: env.SOFFICE_PATH || 'soffice',
  agentDownloadUrl: env.AGENT_DOWNLOAD_URL || null,
  adminEmail: env.ADMIN_EMAIL,
  adminPassword: env.ADMIN_PASSWORD,
};

const problems = [];
if (!config.databaseUrl) problems.push('DATABASE_URL is required');
if (!config.jwtSecret || config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey || '')) problems.push('ENCRYPTION_KEY must be 64 hex characters');
if (isProd && /^0+$/.test(config.encryptionKey || '')) problems.push('ENCRYPTION_KEY must not be the example value in production');
if (problems.length) {
  console.error('Configuration error:\n - ' + problems.join('\n - '));
  process.exit(1);
}
