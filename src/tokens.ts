export function newTokenUser(): string {
  return (globalThis.crypto ?? require("crypto")).randomUUID();
}
