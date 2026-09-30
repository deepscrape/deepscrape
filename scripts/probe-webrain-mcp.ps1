<#
.SYNOPSIS
  End-to-end probe of a locally running webrain MCP HTTP server.

.DESCRIPTION
  Local-wiring harness for the deepscrape <-> webrain path. It checks the
  transport guards, then the two classes of work the Angular app depends on:

    * stateless scrape work  - what a SHARED container must serve (free tier)
    * stateful work          - what a shared container must REFUSE

  Start the server first (a shared, free-tier shape):

    $env:WEBRAIN_HTTP_TOKEN = 'local-dev-probe-secret'
    $env:WEBRAIN_NO_STATE   = '1'
    webrain.exe mcp --http 9333

  Usage:
    pwsh -File scripts/probe-webrain-mcp.ps1
    pwsh -File scripts/probe-webrain-mcp.ps1 -SkipStateless   # transport only

  The token is a local throwaway whose whole purpose is to prove the guard
  works. Nothing secret is read, printed or stored, and no tool result is
  echoed beyond its status - scrape output can be large and may be sensitive.

  Reference for the surfaces probed here:
  Rust/webrain/scripts/probe_http_transport.ps1 (transport only)
  Rust/webrain/docs/PLATFORM_EXPOSURE_PLAN.md  §4, §7
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1:9333',
  [string]$Token = 'local-dev-probe-secret',
  [switch]$SkipStateless
)

$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

function Write-Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  if ($Ok) {
    $script:Pass++
    Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
  } else {
    $script:Fail++
    Write-Host ("  FAIL  {0}  {1}" -f $Name, $Detail) -ForegroundColor Red
  }
}

function Write-Skip {
  param([string]$Name, [string]$Why)
  $script:Skip++
  Write-Host ("  SKIP  {0}  ({1})" -f $Name, $Why) -ForegroundColor DarkYellow
}

function Invoke-Rpc {
  <#
    One JSON-RPC call over the streamable-HTTP transport. Returns @{ Status; Json }.
    Returns Status=0 when the connection itself failed, so a refused socket is
    distinguishable from an unauthorized response.
  #>
  param(
    [string]$Method,
    [hashtable]$Params = @{},
    [switch]$NoAuth
  )

  $headers = @{
    'Accept' = 'application/json, text/event-stream'
  }
  if (-not $NoAuth) {
    $headers['Authorization'] = "Bearer $Token"
  }

  $payload = @{
    jsonrpc = '2.0'
    id      = 1
    method  = $Method
    params  = $Params
  } | ConvertTo-Json -Depth 12 -Compress

  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/" -Method POST -Headers $headers `
      -ContentType 'application/json' -Body $payload -UseBasicParsing
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $code; Json = $null }
  }

  # Streamable HTTP may answer as SSE: take the LAST `data:` line, which is the
  # response to this request rather than an earlier notification.
  $text = $response.Content
  $dataLines = @($text -split "`n" | Where-Object { $_ -match '^\s*data:\s*' })
  if ($dataLines.Count -gt 0) {
    $text = ($dataLines[-1] -replace '^\s*data:\s*', '').Trim()
  }

  $json = $null
  try { $json = $text | ConvertFrom-Json } catch { }

  return @{ Status = [int]$response.StatusCode; Json = $json }
}

function Get-ToolNames {
  param($ToolsResponse)
  if (-not $ToolsResponse -or -not $ToolsResponse.result -or -not $ToolsResponse.result.tools) {
    return @()
  }
  return @($ToolsResponse.result.tools | ForEach-Object { $_.name })
}

# ── transport ───────────────────────────────────────────────────────────────

Write-Host ''
Write-Host "webrain MCP probe  ->  $BaseUrl" -ForegroundColor Cyan
Write-Host ''
Write-Host 'transport guards'

try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/health" -UseBasicParsing
  Write-Check '/health is 200 and unauthenticated' ($health.StatusCode -eq 200) "status=$($health.StatusCode)"
  # The body is asserted only for shape: the plan says it reports nothing else.
  Write-Check '/health reports ok' ($health.Content -match '"status"\s*:\s*"ok"') "body=$($health.Content)"
} catch {
  Write-Check '/health is 200 and unauthenticated' $false $_.Exception.Message
}

$noAuth = Invoke-Rpc -Method 'tools/list' -NoAuth
Write-Check 'tools/list without a token is 401' ($noAuth.Status -eq 401) "status=$($noAuth.Status)"

$badAuth = Invoke-Rpc -Method 'tools/list'
Write-Check 'tools/list with the token is 200' ($badAuth.Status -eq 200) "status=$($badAuth.Status)"

if ($badAuth.Status -ne 200) {
  Write-Host ''
  Write-Host 'Transport is not usable; stopping before the tool checks.' -ForegroundColor Red
  Write-Host ("pass={0} fail={1} skip={2}" -f $script:Pass, $script:Fail, $script:Skip)
  exit 1
}

$tools = Get-ToolNames -ToolsResponse $badAuth.Json
Write-Check 'tools/list returns the 17-tool surface' ($tools.Count -eq 17) "count=$($tools.Count)"
Write-Host ("        tools: {0}" -f ($tools -join ', ')) -ForegroundColor DarkGray

# ── stateless work (what the shared pool must serve) ────────────────────────

if ($SkipStateless) {
  Write-Skip 'stateless scrape' '-SkipStateless'
} else {
  Write-Host ''
  Write-Host 'stateless work (shared / free tier)'

  $scrape = Invoke-Rpc -Method 'tools/call' -Params @{
    name      = 'webrain_scrape'
    arguments = @{ url = 'https://example.com' }
  }

  $scrapeOk = $scrape.Status -eq 200 -and $scrape.Json -and -not $scrape.Json.result.isError
  Write-Check 'webrain_scrape reaches the network' $scrapeOk "status=$($scrape.Status)"

  if ($scrapeOk) {
    # Every response is stamped with the token cost - the plan relies on that for
    # per-tenant accounting, so its absence is worth failing on.
    $cost = $scrape.Json.result.tokens
    Write-Check 'the response carries a token cost stamp' ($null -ne $cost) "tokens=$cost"
  } else {
    Write-Host '        (no network or no browser available - see detail above)' -ForegroundColor DarkGray
  }

  $guide = Invoke-Rpc -Method 'tools/call' -Params @{ name = 'webrain_guide'; arguments = @{} }
  Write-Check 'webrain_guide answers (agent entry point)' `
    ($guide.Status -eq 200 -and $guide.Json -and -not $guide.Json.result.isError) "status=$($guide.Status)"
}

# ── stateful work (what a shared container must refuse) ─────────────────────

Write-Host ''
Write-Host 'stateful work (must be refused while WEBRAIN_NO_STATE=1)'

function Test-Refused {
  # NOT `-Args`: that name collides with PowerShell's automatic $args, so every
  # call failed to bind and the counter reported a pass it never made.
  param([string]$Tool, [hashtable]$ToolArguments)

  $call = Invoke-Rpc -Method 'tools/call' -Params @{ name = $Tool; arguments = $ToolArguments }
  $isError = $call.Json -and $call.Json.result -and $call.Json.result.isError
  $text = ''
  if ($call.Json -and $call.Json.result -and $call.Json.result.content) {
    $text = ($call.Json.result.content | ForEach-Object { $_.text }) -join ' '
  }
  # The exact message is `<tool> is disabled on this instance: WEBRAIN_NO_STATE is set`
  # (webrain-mcp/src/lib.rs:151). The plan quotes a different string that does not
  # exist in the code, so assert on the flag name rather than the prose.
  Write-Check "$Tool is refused" ([bool]$isError -and $text -match 'WEBRAIN_NO_STATE') `
    "isError=$isError text=$text"
}

# The three names in webrain's STATEFUL_TOOLS const.
Test-Refused -Tool 'webrain_profiles' -ToolArguments @{}
Test-Refused -Tool 'webrain_launch' -ToolArguments @{}
Test-Refused -Tool 'webrain_login' -ToolArguments @{}

# Known gap, asserted as a KNOWN GAP rather than a pass: these reach the same
# on-disk profile store but are NOT in STATEFUL_TOOLS, so a shared container
# serves them. See ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md §9a - this is why
# the gateway needs its own allowlist.
Write-Host ''
Write-Host 'known gaps in the no_state guard (expected to be reachable today)'

$gap = Invoke-Rpc -Method 'tools/call' -Params @{
  name      = 'webrain_session'
  arguments = @{ op = 'list' }
}
$gapRefused = $gap.Json -and $gap.Json.result -and $gap.Json.result.isError
if ($gapRefused) {
  Write-Host '  GAP CLOSED  webrain_session(op=list) is refused' -ForegroundColor Green
} else {
  Write-Host '  GAP OPEN    webrain_session(op=list) is served on a shared instance' -ForegroundColor DarkYellow
  Write-Host '              => gateway-side allowlist is load-bearing (ADR §9a)' -ForegroundColor DarkYellow
}

# ── summary ─────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host ("pass={0} fail={1} skip={2}" -f $script:Pass, $script:Fail, $script:Skip) -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 }
exit 0
