export const DEFAULT_REDACTED_KEYS = ['password', 'authorization', 'token', 'cookie', 'set-cookie', 'secret', 'cvv', 'credit_card', 'cardNum', 'email', 'phone'];

export const getRedactionPaths = (): string[] => {
  const envKeys = process.env.REDACTED_KEYS ? process.env.REDACTED_KEYS.split(',') : [];
  return Array.from(new Set([...DEFAULT_REDACTED_KEYS, ...envKeys]));
};

export const getRedactionConfig = () => ({
  paths: getRedactionPaths(),
  censor: '[REDACTED]',
});
