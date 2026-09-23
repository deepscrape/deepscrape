# Fails when a component whose template uses form directives does not list the matching
# module in its own `imports` array.
#
#   pwsh scripts/check-forms-imports.ps1              # defaults to src/app
#   pwsh scripts/check-forms-imports.ps1 -Root <dir>  # used by the fixture self-test
#
# Why this exists: standalone components never inherit template directives from the root
# injector, so `importProvidersFrom(ReactiveFormsModule)` in app.config.ts only bundled
# @angular/forms — it never supplied `formControl`/`formGroup`/`ngModel` to a template.
# A missing entry is therefore a runtime NG0303 ("Can't bind to 'formControl' since it
# isn't a known property of 'input'"), and with strictTemplates off the build stays green,
# so the compiler alone does not catch it. Run this after any change to root providers,
# barrels, or a component's imports array.
#
# ponytail: only the two form directives are mapped. Add (Pattern, Module) pairs to $needs
# when another provider-backed directive starts being assumed app-wide.

# `param` must be the first statement in a script, so it sits above everything else.
param(
  [string] $Root = (Join-Path $PSScriptRoot '..\src\app')
)

$needs = @(
  @{ Pattern = 'formControlName|formGroupName|formArrayName|\[formControl\]|\[formGroup\]|\[formArray\]|\[formControlName\]'; Module = 'ReactiveFormsModule' },
  # the lookbehind stops ReactiveFormsModule from satisfying the FormsModule check
  @{ Pattern = '\[\(ngModel\)\]|\[ngModel\]|\(ngModelChange\)'; Module = '(?<!Reactive)FormsModule' }
)

function Get-ImportsBlock([string] $source) {
  $i = $source.IndexOf('imports:')
  if ($i -lt 0) { return '' }
  $j = $source.IndexOf('[', $i)
  if ($j -lt 0) { return '' }
  $depth = 0
  for ($k = $j; $k -lt $source.Length; $k++) {
    if ($source[$k] -eq '[') { $depth++ }
    elseif ($source[$k] -eq ']') {
      $depth--
      if ($depth -eq 0) { return $source.Substring($j, $k - $j + 1) }
    }
  }
  return ''
}

function Get-Template([string] $source, [string] $tsPath) {
  $m = [regex]::Match($source, "templateUrl\s*:\s*['""](?<p>[^'""]+)['""]")
  if ($m.Success) {
    $html = Join-Path (Split-Path $tsPath) $m.Groups['p'].Value
    if (Test-Path $html) { return Get-Content $html -Raw }
    return ''
  }
  $m = [regex]::Match($source, '(?s)template\s*:\s*`(?<p>.*?)`')
  if ($m.Success) { return $m.Groups['p'].Value }
  $m = [regex]::Match($source, "template\s*:\s*'(?<p>[^']*)'")
  if ($m.Success) { return $m.Groups['p'].Value }
  $m = [regex]::Match($source, 'template\s*:\s*"(?<p>[^"]*)"')
  if ($m.Success) { return $m.Groups['p'].Value }
  return ''
}

$problems = @()
Get-ChildItem $root -Recurse -Filter *.ts |
  Where-Object { $_.Name -notlike '*.spec.ts' } |
  ForEach-Object {
    $source = Get-Content $_.FullName -Raw
    if ($source -notmatch '@Component') { return }
    $template = Get-Template $source $_.FullName
    if (-not $template) { return }
    $block = Get-ImportsBlock $source
    foreach ($need in $needs) {
      if ($template -match $need.Pattern -and $block -notmatch $need.Module) {
        $problems += "$($_.FullName): template uses $($need.Module) directives but the component imports array does not list it"
      }
    }
  }

if ($problems.Count) {
  $problems | ForEach-Object { Write-Output $_ }
  # SetShouldExit keeps a non-zero status for CI without killing an interactive host;
  # $LASTEXITCODE is set too so `& script.ps1; $LASTEXITCODE` is honest.
  $host.SetShouldExit(1)
  $global:LASTEXITCODE = 1
  return
}

Write-Output 'OK: every form-using template lists its module in the component imports'
