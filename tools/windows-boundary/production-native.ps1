param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$requestData = Get-Content -Raw -LiteralPath $Request | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'AmabieConfinedLauncher.cs')
switch ($requestData.mode) {
  'identity' {
    [System.IO.File]::WriteAllText($requestData.result, [AmabieConfined]::Identity([bool]$requestData.delete, $requestData.name))
  }
  'run' {
    $runProfile = if ($requestData.profile) { [string]$requestData.profile } else { $null }
    exit [AmabieConfined]::Run($requestData.command, $requestData.cwd, $requestData.side, $requestData.package, $false, $runProfile, [bool]$requestData.gitDirectoryAlias)
  }
  'broker' {
    Add-Type -Path (Join-Path $PSScriptRoot 'AmabieBroker.cs')
    exit [AmabieBroker.Program]::Main([string[]]$requestData.argv)
  }
  default { throw 'unknown native operation' }
}
