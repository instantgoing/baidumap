param(
  [switch]$SkipDependencies,
  [switch]$SkipFrontend,
  [switch]$SkipBackend,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $desktopRoot
$venvPython = Join-Path $desktopRoot '.venv\Scripts\python.exe'

Push-Location $desktopRoot
try {
  if (-not $SkipDependencies) {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    & npx install-electron
    if ($LASTEXITCODE -ne 0) { throw "Electron runtime download failed with exit code $LASTEXITCODE" }

    if (-not (Test-Path -LiteralPath $venvPython)) {
      & python -m venv (Join-Path $desktopRoot '.venv')
      if ($LASTEXITCODE -ne 0) { throw "Python venv creation failed with exit code $LASTEXITCODE" }
    }
    & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $desktopRoot 'backend\requirements-build.lock.txt')
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipFrontend) {
    & (Join-Path $desktopRoot 'build\build-web.ps1')
    if ($LASTEXITCODE -ne 0) { throw "Desktop frontend build failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipBackend) {
    if (-not (Test-Path -LiteralPath $venvPython)) { throw 'Desktop build venv is missing. Run without -SkipDependencies first.' }
    $distPath = Join-Path $desktopRoot 'out\backend'
    $workPath = Join-Path $desktopRoot 'out\pyinstaller-work'
    & $venvPython -m PyInstaller --noconfirm --clean --distpath $distPath --workpath $workPath (Join-Path $desktopRoot 'backend\baidumap-backend.spec')
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }
  }

  $frontendIndex = Join-Path $repositoryRoot 'dist\index.html'
  $backendExe = Join-Path $desktopRoot 'out\backend\baidumap-backend\baidumap-backend.exe'
  if (-not (Test-Path -LiteralPath $frontendIndex)) { throw "Missing frontend artifact: $frontendIndex" }
  if (-not (Test-Path -LiteralPath $backendExe)) { throw "Missing backend artifact: $backendExe" }

  & npm run test
  if ($LASTEXITCODE -ne 0) { throw "Desktop tests failed with exit code $LASTEXITCODE" }
  & node (Join-Path $desktopRoot 'scripts\smoke-backend.cjs') $backendExe
  if ($LASTEXITCODE -ne 0) { throw "Packaged backend smoke test failed with exit code $LASTEXITCODE" }
  & npm run dist
  if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed with exit code $LASTEXITCODE" }

  $installer = Join-Path $desktopRoot 'release\NeighborhoodRadius-Setup-0.6.0-x64.exe'
  if (-not (Test-Path -LiteralPath $installer)) { throw "Missing installer artifact: $installer" }
  $installerHash = Get-FileHash -Algorithm SHA256 -LiteralPath $installer
  $checksumLine = "$($installerHash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($installer))"
  Set-Content -LiteralPath (Join-Path $desktopRoot 'release\SHA256SUMS.txt') -Value $checksumLine -Encoding ascii

  if (-not $SkipSmoke) {
    $packagedExe = Join-Path $desktopRoot 'release\win-unpacked\NeighborhoodRadius.exe'
    $smokeUserData = Join-Path $desktopRoot 'out\packaged-build-smoke'
    $smoke = Start-Process -FilePath $packagedExe -ArgumentList @('--smoke-test', "--user-data-dir=$smokeUserData") -WindowStyle Hidden -Wait -PassThru
    if ($smoke.ExitCode -ne 0) { throw "Packaged Electron smoke test failed with exit code $($smoke.ExitCode)" }
  }

  Write-Host "Windows installer created under $(Join-Path $desktopRoot 'release')"
}
finally {
  Pop-Location
}
