const fs = require("node:fs")
const path = require("node:path")
const {spawnSync} = require("node:child_process")

const rootDir = path.resolve(__dirname, "..")
const configPath = path.resolve(rootDir, ".deploy-secrets.json")

// The JSON is DERIVED from the env file, and it used to be hand-copied: the
// migration script existed and nothing called it, so a key added to the env file
// never reached the secret. Regenerated here because every entry point
// (`npm run deploy`, `make deploy-json`, `make deploy-all`) funnels through this
// script, so this is the one place to get the order right.
const migrate = spawnSync(
  process.execPath,
  [path.join(__dirname, "migrate-env-to-json.cjs")],
  {cwd: rootDir, stdio: "inherit"},
)
if (migrate.status !== 0) {
  // Fail closed: pushing the stale JSON would silently unset whatever the env
  // file was supposed to add, which is how BROWSER_MACHINE_IMAGE went missing.
  console.error("Refusing to deploy: the env file could not be turned into the secret JSON.")
  process.exit(migrate.status || 1)
}

if (!fs.existsSync(configPath)) {
  console.error(`Missing deploy config JSON: ${configPath}`)
  console.error(
    "The migration step above should have written it; check that " +
    "functions/.env (or FUNCTIONS_ENV_SOURCE) exists and has KEY=value lines.")
  process.exit(1)
}

// A publish REPLACES the whole secret, so the guard that matters is "never lose a
// key". Runs before the set; every entry point (`npm run deploy`, `make
// deploy-json`, `make deploy-functions`, `make deploy-all`) comes through here.
const guard = spawnSync(
  process.execPath,
  [path.join(__dirname, "check-env-json.cjs")],
  {cwd: rootDir, stdio: "inherit"},
)
if (guard.status !== 0) {
  console.error("Refusing to publish: this JSON would drop keys production has.")
  process.exit(guard.status || 1)
}

const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...extraEnv,
    },
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

run("firebase", ["functions:secrets:set", "FUNCTIONS_ENV_JSON", "--data-file", configPath])
run("firebase", ["deploy", "--only", "functions,hosting"], { BUILD_ENV: "production" })