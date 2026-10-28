/** Client-side crypto boundary. Implement with reviewed Web Crypto primitives. */
export interface ConversationCrypto {
  encrypt(plaintext: Uint8Array, key: CryptoKey): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }>;
  decrypt(ciphertext: Uint8Array, nonce: Uint8Array, key: CryptoKey): Promise<Uint8Array>;
}

/** Hash invitation secrets before persistence or lookup. */
export interface SecretHasher {
  digest(secret: Uint8Array): Promise<Uint8Array>;
}
