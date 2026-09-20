/* eslint-disable max-len */
/**
 * Guards the Firestore index config against the mistake that silently disabled
 * the whole analytics pipeline.
 *
 * `firestore.indexes.json` has two arrays with different jobs: `indexes` holds
 * COMPOSITE (multi-field) indexes, `fieldOverrides` holds single-field index
 * configuration. A single-field entry placed in `indexes` is not a composite
 * index, so the CLI drops it from the deploy request without error: the deploy
 * reports success and the index never exists. The analytics queries then fail
 * at runtime with FAILED_PRECONDITION, which surfaces in the UI as "no data"
 * rather than as an error.
 *
 * These assertions are source-level on purpose. Nothing in the deploy path
 * reports the mistake, so the file itself is the only place to catch it.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"

type IndexField = {fieldPath: string, order?: string, arrayConfig?: string}
type CompositeIndex = {collectionGroup: string, queryScope: string, fields: IndexField[]}
type FieldOverride = {
  collectionGroup: string,
  fieldPath: string,
  indexes: Array<{order?: string, arrayConfig?: string, queryScope?: string}>,
}

const readIndexConfig = (): {indexes: CompositeIndex[], fieldOverrides: FieldOverride[]} =>
  JSON.parse(readFileSync(join(__dirname, "../../../firestore.indexes.json"), "utf8"))

/**
 * Every `collectionGroup(...).where(...)` in the codebase needs a
 * COLLECTION_GROUP-scoped index. Auto-created single-field indexes are
 * COLLECTION-scoped only, so each of these fails at runtime with
 * FAILED_PRECONDITION until it is declared explicitly.
 */
const COLLECTION_GROUP_FIELDS: Array<[string, string]> = [
  ["login_history_Info", "timestamp"], // analytics drain, range metrics, backfill
  ["billing", "plan"], // expireTrialsToFree
]

const COLLECTION_GROUP_COMPOSITES: Array<[string, string[]]> = [
  ["credits_ledger", ["operation", "expiresAt"]], // expireStaleCredits
]

/**
 * firestore index config
 */
describe("firestore index config", () => {
  /**
   * keeps single-field indexes out of the composite-only array
   */
  it("keeps single-field indexes out of the composite-only array", () => {
    const {indexes} = readIndexConfig()
    /**
     * callback
     * @param {*} entry
     */
    const singleField = indexes.filter((entry) => entry.fields.length < 2)

    assert.deepEqual(
      singleField.map((entry) => `${entry.collectionGroup}.${entry.fields[0]?.fieldPath}`),
      [],
      "a single-field index in `indexes` is dropped by the CLI and never deployed; move it to `fieldOverrides`",
    )
  })

  /**
   * declares a collection-group index for every single-filter wildcard query
   */
  it("declares a collection-group index for every single-filter wildcard query", () => {
    const {fieldOverrides} = readIndexConfig()

    for (const [collectionGroup, fieldPath] of COLLECTION_GROUP_FIELDS) {
      const override = fieldOverrides.find(
        (entry) => entry.collectionGroup === collectionGroup && entry.fieldPath === fieldPath,
      )

      assert.ok(
        override,
        `${collectionGroup}.${fieldPath} has a collectionGroup() query but no fieldOverride, so it fails with FAILED_PRECONDITION`,
      )
      assert.ok(
        override.indexes.some((entry) => entry.queryScope === "COLLECTION_GROUP"),
        `${collectionGroup}.${fieldPath} must declare a COLLECTION_GROUP index, not just a COLLECTION one`,
      )
    }
  })

  /**
   * declares a collection-group composite index for every multi-filter wildcard query
   */
  it("declares a collection-group composite index for every multi-filter wildcard query", () => {
    const {indexes} = readIndexConfig()

    for (const [collectionGroup, fields] of COLLECTION_GROUP_COMPOSITES) {
      const declared = indexes.some(
        (entry) =>
          entry.collectionGroup === collectionGroup &&
          entry.queryScope === "COLLECTION_GROUP" &&
          fields.every((field) => entry.fields.some((declaredField) => declaredField.fieldPath === field)),
      )

      assert.ok(
        declared,
        `${collectionGroup} (${fields.join(", ")}) needs a COLLECTION_GROUP composite index`,
      )
    }
  })
})
