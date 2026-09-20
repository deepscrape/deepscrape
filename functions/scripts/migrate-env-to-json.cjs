const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")

const rootDir = path.resolve(__dirname, "..")
const sourcePath = path.resolve(rootDir, ".env.dev")
const targetPath = path.resolve(rootDir, ".deploy-secrets.json")

const IP_INTEL_DATABASES = [
  // {
  //   fileName: "IP2LOCATION-LITE-DB11.BIN",
  //   envPathKey: "IP2LOCATION_GCS_PATH",
  //   envShaKey: "IP2LOCATION_SHA256",
  // },
  // {
  //   fileName: "IP2LOCATION-LITE-ASN.CSV",
  //   envPathKey: "IP2LOCATION_ASN_GCS_PATH",
  //   envShaKey: "IP2LOCATION_ASN_SHA256",
  // },
  // {
  //   fileName: "IP2PROXY-LITE-PX12.CSV",
  //   envPathKey: "IP2PROXY_GCS_PATH",
  //   envShaKey: "IP2PROXY_SHA256",
  // },
]

const parseEnvFile = (content) => {
  const lines = content.split(/\r?\n/)
  const result = {}

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()

    if (!key) {
      continue
    }

    if ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

const computeSha256 = (filePath) => {
  const hash = crypto.createHash("sha256")
  const content = fs.readFileSync(filePath)
  hash.update(content)
  return hash.digest("hex").toLowerCase()
}

const parseGsPath = (value) => {
  const input = String(value || "").trim()
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(input)
  if (!match) {
    return null
  }

  return {
    bucket: match[1],
    objectPath: match[2],
  }
}

const deriveStorageTarget = (parsedEnv) => {
  const explicitBucket = (process.env.IP_INTEL_BUCKET || "").trim()
  const explicitPrefix = (process.env.IP_INTEL_PREFIX || "").trim().replace(/^\/+|\/+$/g, "")

  if (explicitBucket) {
    return {
      bucket: explicitBucket,
      prefix: explicitPrefix || "geo",
    }
  }

  const geoPath = parseGsPath(parsedEnv.IP2LOCATION_GCS_PATH)
  if (geoPath) {
    const prefix = path.posix.dirname(geoPath.objectPath)
    return {
      bucket: geoPath.bucket,
      prefix: prefix && prefix !== "." ? prefix : "geo",
    }
  }

  return {
    bucket: "libnet-d76db.appspot.com",
    prefix: "geo",
  }
}

const syncEnvVar = (rawContent, key, value) => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^${escapedKey}=.*$`, "m")
  const newLine = `${key}=${value}`

  if (pattern.test(rawContent)) {
    return rawContent.replace(pattern, newLine)
  }

  const trimmed = rawContent.trimEnd()
  return `${trimmed}\n${newLine}\n`
}

const uploadIpIntelDatabasesAndSyncEnv = (envContent, parsedEnv) => {
  const target = deriveStorageTarget(parsedEnv)
  let updatedEnvContent = envContent

  console.log(`Using storage bucket: ${target.bucket}`)
  console.log(`Using storage prefix: ${target.prefix}`)

  for (const db of IP_INTEL_DATABASES) {
    const localPath = path.resolve(rootDir, "databases", db.fileName)
    if (!fs.existsSync(localPath)) {
      console.error(`Missing required IP intelligence asset: ${localPath}`)
      process.exit(1)
    }

    const checksum = computeSha256(localPath)
    const gsPath = `gs://${target.bucket}/${target.prefix}/${db.fileName}`
    const currentChecksum = String(parsedEnv[db.envShaKey] || "").trim().toLowerCase()
    const currentPath = String(parsedEnv[db.envPathKey] || "").trim()
    const shouldUpload = currentChecksum !== checksum || currentPath !== gsPath

    if (shouldUpload) {
      console.log(`Uploading ${db.fileName} to ${gsPath}`)

      // ponytail: `shell: true` stays — gsutil is a .cmd shim on Windows and
      // spawnSync without a shell cannot resolve it, so removing it would break
      // `make ip2location-refresh`. The cost is that gsPath is shell-interpretable,
      // and it is built from IP_INTEL_BUCKET / IP_INTEL_PREFIX (or .env.dev), so a
      // value containing `;`, `&`, `|` or `$()` was command injection.
      const UNSAFE_SHELL = /[&|;<>^`$()\r\n"']/
      if (UNSAFE_SHELL.test(gsPath) || UNSAFE_SHELL.test(localPath)) {
        console.error(`Refusing to upload, unsafe characters in path: ${gsPath}`)
        process.exit(1)
      }

      const upload = spawnSync("gsutil", ["cp", localPath, gsPath], {
        cwd: rootDir,
        stdio: "inherit",
        shell: true,
      })

      if (upload.status !== 0) {
        console.error(`gsutil upload failed for ${db.fileName}`)
        process.exit(upload.status || 1)
      }
    } else {
      console.log(`${db.fileName} unchanged. Skipping upload.`)
    }

    parsedEnv[db.envPathKey] = gsPath
    parsedEnv[db.envShaKey] = checksum
    updatedEnvContent = syncEnvVar(updatedEnvContent, db.envPathKey, gsPath)
    updatedEnvContent = syncEnvVar(updatedEnvContent, db.envShaKey, checksum)
  }

  return { updatedEnvContent, updatedParsedEnv: parsedEnv }
}

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing source env file: ${sourcePath}`)
  process.exit(1)
}

const envContent = fs.readFileSync(sourcePath, "utf8")
const parsed = parseEnvFile(envContent)

const { updatedEnvContent, updatedParsedEnv } = uploadIpIntelDatabasesAndSyncEnv(envContent, parsed)
fs.writeFileSync(sourcePath, updatedEnvContent, "utf8")
console.log("Updated .env.dev with IP intelligence storage paths and checksums")

fs.writeFileSync(targetPath, `${JSON.stringify(updatedParsedEnv, null, 2)}\n`, "utf8")

console.log(`Wrote ${Object.keys(updatedParsedEnv).length} keys to ${targetPath}`)