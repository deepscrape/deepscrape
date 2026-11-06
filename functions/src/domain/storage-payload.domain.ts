/**
 * The bytes of a stored payload, from whichever field the caller sent.
 *
 * Two fields rather than one sniffed field, and that is the whole reason this
 * is a function rather than three lines in the route: a text payload has to
 * stay text, and guessing "does this string look like base64?" would corrupt a
 * JSON body that happens to decode as it. The caller says which it sent.
 *
 * Base64 is how a browser sends a file it holds: a PNG is not valid UTF-8, and
 * the route's other contract (`content`) is defined as UTF-8 text. Nothing here
 * decides what the bytes mean -- the declared `contentType` does, and that is
 * the route's business.
 */

/** What a payload field decoded to, or why it could not be read. */
export type PayloadDecode =
  | {readonly ok: true; readonly bytes: Buffer}
  | {readonly ok: false; readonly code: string}

/**
 * Read `content` or `contentBase64` from a request body.
 *
 * An empty result is a refusal rather than a zero-byte object: a stored object
 * nobody can read is worse than an error the caller can correct.
 * @param {Record<string, unknown>} body The parsed request body.
 * @return {PayloadDecode} The bytes, or a machine-readable refusal.
 */
export const decodePayload = (
  body: Record<string, unknown>
): PayloadDecode => {
  const text = typeof body["content"] === "string" ? body["content"] : null
  const encoded =
    typeof body["contentBase64"] === "string" ? body["contentBase64"] : null

  if (text === null && encoded === null) {
    return {ok: false, code: "invalid_content"}
  }

  // Base64 decoding is lenient: junk yields zero bytes instead of throwing, so
  // the emptiness check below is also the validity check.
  const bytes =
    encoded === null ?
      Buffer.from(text ?? "", "utf8") :
      Buffer.from(encoded, "base64")

  if (bytes.length === 0) {
    return {ok: false, code: "empty_content"}
  }

  return {ok: true, bytes}
}
