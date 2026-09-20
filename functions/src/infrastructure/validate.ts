/* eslint-disable max-len */
/**
 * Zod-based request validation for Firebase v2 callable functions.
 *
 * Each callable should declare a Zod schema for its `data` payload and call
 * `validateCallableData(schema, request.data)` at the top of the handler. This
 * rejects malformed / oversized / unexpected inputs before business logic runs,
 * closing OWASP-style broken-property-level and injection surface.
 *
 * Rejects with a generic HttpsError (invalid-argument) so no schema details
 * leak to the client.
 */

import {z} from "zod"
import {HttpsError} from "firebase-functions/v2/https"

/**
 * Validate callable request data against a Zod schema.
 * @template {z.ZodTypeAny} S Zod schema type.
 * @param {S} schema Schema the payload must satisfy.
 * @param {unknown} data Raw callable payload (`request.data`).
 * @return {z.infer<S>} Parsed data, typed from the schema's output.
 */
/**
 * validateCallableData
 * @param {*} schema
 * @param {*} data
 * @return {*}
 */
export function validateCallableData<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new HttpsError("invalid-argument", "Invalid request payload")
  }
  return result.data as z.infer<S>
}
