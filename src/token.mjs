export const tokenRequirement = '32–64 printable ASCII characters including uppercase, lowercase, a digit and a special character';

export function isValidToken(value) {
  return typeof value === 'string'
    && /^[!-~]{32,64}$/.test(value)
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /[0-9]/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}
