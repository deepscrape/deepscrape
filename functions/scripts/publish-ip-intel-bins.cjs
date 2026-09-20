/**
 * Publish IP intelligence databases to Cloud Storage and output checksum env payload.
 *
 * Usage:
 *   node scripts/publish-ip-intel-bins.cjs bucket=<bucket-name> [prefix=ip-intel] [upload]
 *
 * Examples:
 *   node scripts/publish-ip-intel-bins.cjs bucket=my-project.appspot.com prefix=ip-intel/v2026-05-03
 *   node scripts/publish-ip-intel-bins.cjs bucket=my-project.appspot.com prefix=ip-intel/v2026-05-03 upload
 */

const crypto = require("node:crypto")
const { createReadStream, existsSync } = require("node:fs")
const { stat } = require("node:fs/promises")
const path = require("node:path")
const { spawn } = require("node:child_process")

const DB_DIR = path.resolve(__dirname, "../databases")

const DATABASES = [
  { envPath: "IP2LOCATION_GCS_PATH", envSha: "IP2LOCATION_SHA256", file: "IP2LOCATION-LITE-DB11.BIN" },
  { envPath: "IP2LOCATION_ASN_GCS_PATH", envSha: "IP2LOCATION_ASN_SHA256", file: "IP2LOCATION-LITE-ASN.CSV" },
  { envPath: "IP2PROXY_GCS_PATH", envSha: "IP2PROXY_SHA256", file: "IP2PROXY-LITE-PX12.CSV" },
]

const args = process.argv.slice(2)
const shouldUpload = args.includes("upload")
const bucket = (args.find((arg) => arg.startsWith("bucket=")) || "").split("=")[1] || ""
const prefix = (args.find((arg) => arg.startsWith("prefix=")) || "prefix=geo").split("=")[1] || "geo"

if (!bucket) {
  console.error("Missing required argument: bucket=<bucket-name>")
  process.exit(1)
}

function run(command, commandArgs) {
  // ponytail: `shell` stays because gsutil is a .cmd shim on Windows and
  // CreateProcess will not resolve it without one — dropping it silently breaks
  // the publish on Windows. That makes every argument shell-interpretable, so
  // reject metacharacters HERE, at the one place all callers route through,
  // instead of at each call site. Previously `node publish-ip-intel-bins.cjs
  // "bucket=x&calc.exe"` executed a second command with the developer's creds.
  const UNSAFE_SHELL = /[&|;<>^`$()\r\n"']/
  for (const arg of [command, ...commandArgs]) {
    if (UNSAFE_SHELL.test(String(arg))) {
      return Promise.reject(new Error(`unsafe shell argument rejected: ${arg}`))
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32" })
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined)
        return
      }
      reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

async function main() {
  const envPayload = {}

  for (const db of DATABASES) {
    const localPath = path.join(DB_DIR, db.file)
    if (!existsSync(localPath)) {
      throw new Error(`Missing required local IP intelligence asset: ${localPath}`)
    }

    const fileStat = await stat(localPath)
    if (fileStat.size < 1024 * 1024) {
      throw new Error(`Suspiciously small IP intelligence asset (${fileStat.size} bytes): ${localPath}`)
    }

    const checksum = await sha256(localPath)
    const objectPath = `${prefix.replace(/\/+$/, "")}/${db.file}`
    const gsPath = `gs://${bucket}/${objectPath}`

    if (shouldUpload) {
      console.log(`Uploading ${db.file} -> ${gsPath}`)
      await run("gsutil", ["cp", localPath, gsPath])
    } else {
      console.log(`Dry run: ${db.file} -> ${gsPath}`)
    }

    envPayload[db.envPath] = gsPath
    envPayload[db.envSha] = checksum
  }

  console.log("\nFUNCTIONS_ENV_JSON fragment:")
  console.log(JSON.stringify(envPayload, null, 2))
}

main().catch((error) => {
  console.error("Failed to publish IP intelligence BINs:", error)
  process.exit(1)
})
