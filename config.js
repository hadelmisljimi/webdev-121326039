// Load and validate required environment variables at start-up.
// Проверка на задължителните променливи на средата при стартиране.

const requiredVars = ['DATABASE_URL', 'SESSION_SECRET'];
const missing = requiredVars.filter((name) => !process.env[name] || !String(process.env[name]).trim());

if (missing.length > 0) {
  console.error(
    `missing ${missing.join(', ')}: see .env.example | Липсва(т) задължителна(и) променлива(и): ${missing.join(', ')} (виж .env.example)`
  );
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

export const config = {
  port,
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  publicBaseUrl,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleCallbackUrl: `${publicBaseUrl.replace(/\/+$/, '')}/auth/google/callback`,
  modelName: process.env.MODEL_NAME || 'gemini-1.5-flash',
};