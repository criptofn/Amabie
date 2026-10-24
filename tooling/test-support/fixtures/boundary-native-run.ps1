param([string]$Work,[string]$Store,[string]$Package,[string]$HostAddress,[int]$Port,[string]$Side,[string]$Symlink = 'absent',[string]$SecretPath,[string]$AuthorityTargets = 'absent')
$ErrorActionPreference = 'Stop'
Add-Type -Path @((Join-Path $PSScriptRoot '../../../tools/windows-boundary/AmabieConfinedLauncher.cs'),
  (Join-Path $PSScriptRoot 'boundary-native-parent.cs'))
$exe = Join-Path $Work 'native-child.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    # PowerShell Core's Add-Type only emits libraries. Compile the same
    # Framework child executable with the inbox .NET Framework compiler so the
    # AppContainer process and its security assertions stay identical.
    $compiler = @(
      (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
      (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $compiler) { throw 'the .NET Framework C# compiler is unavailable for the native AppContainer fixture' }
    $framework = Split-Path -Parent $compiler
    $compileArgs = @('/nologo','/target:exe',"/out:$exe",
      "/reference:$(Join-Path $framework 'System.dll')",
      "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')",
      (Join-Path $PSScriptRoot 'boundary-native-child.cs'))
    $compileOutput = & $compiler @compileArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "native AppContainer fixture compilation failed: $($compileOutput -join ' ')" }
  } else {
    Add-Type -Path (Join-Path $PSScriptRoot 'boundary-native-child.cs') -OutputAssembly $exe -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll','System.Web.Extensions.dll')
  }
}
$secret = if ($SecretPath) { $SecretPath } else { Join-Path $Store 'native-secret.txt' }
if (-not $SecretPath) { [System.IO.File]::WriteAllText($secret, 'test-only native handle secret') }
[System.IO.File]::WriteAllText($secret + '.rename', 'test-only rename target')
$file = [BoundaryNativeParent]::OpenFile($secret)
$process = [BoundaryNativeParent]::OpenSelf()
function Command([string]$report) {
  (@($exe,$report,$secret,$Work,$file.ToInt64(),$process.ToInt64(),$PID,$HostAddress,$Port,$Symlink,$AuthorityTargets) |
    ForEach-Object { '"' + [string]$_ + '"' }) -join ' '
}
try {
  if ($AuthorityTargets -ne 'absent') { $env:AMABIE_PRODUCTION_SENTINEL = 'trusted-parent-only-test-value' }
  $control = [BoundaryNativeParent]::RunControl((Command (Join-Path $Work 'native-control.json')),$Work)
  if ($control -ne 0) { throw "native control exit $control" }
  [System.IO.File]::WriteAllText($secret + '.rename', 'test-only rename target')
  Remove-Item -LiteralPath (Join-Path $Work 'copied-secret'),(Join-Path $Work 'renamed-secret') -Force -ErrorAction SilentlyContinue
  $restricted = [AmabieConfined]::Run((Command (Join-Path $Work 'native-restricted.json')),$Work,$Side,$Package,$false)
  exit $restricted
} finally {
  [void][BoundaryNativeParent]::CloseHandle($file)
  [void][BoundaryNativeParent]::CloseHandle($process)
}
