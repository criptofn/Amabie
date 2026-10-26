param(
  [Parameter(Mandatory=$true)][ValidateSet('launcher','broker','identity')][string]$Mode,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'AmabieConfinedLauncher.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'AmabieBroker.cs')
# Windows PowerShell collapses a single-element array to a scalar, which would pass one
# space-joined string instead of N arguments. Force enumeration through an explicit array.
function Invoke-Native([object[]]$argv) {
  switch ($Mode) {
    'identity' { $code = [AmabieConfined]::Main([object[]](@('identity') + $argv)); exit $code }
    'launcher' { $code = [AmabieConfined]::Main([object[]](@('run') + $argv)); exit $code }
    'broker'   { $code = [AmabieBroker.Program]::Main($argv); exit $code }
    default    { Write-Error "unknown mode $Mode"; exit 2 }
  }
}
Invoke-Native -argv ([object[]]@($Rest))
