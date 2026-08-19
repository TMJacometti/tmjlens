/**
 * Base64-encodes text for the `save_bytes_to_downloads` command.
 *
 * Encoded in chunks because `String.fromCharCode(...bytes)` passes every byte as its
 * own argument, which overflows the call stack somewhere in the tens of thousands —
 * well within reach of a deployment document carrying its managedFields.
 */
const CHUNK = 0x8000;

export function textToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
