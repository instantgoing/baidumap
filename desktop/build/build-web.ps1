$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $desktopRoot
$variableNames = @('VITE_DATA_MODE', 'VITE_API_BASE_URL', 'VITE_API_TIMEOUT_MS', 'VITE_BAIDU_BROWSER_AK')
$previousValues = @{}

foreach ($name in $variableNames) {
  $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  $previousValues[$name] = if ($null -eq $item) { $null } else { $item.Value }
}

try {
  $env:VITE_DATA_MODE = 'online'
  $env:VITE_API_BASE_URL = '/api'
  $env:VITE_API_TIMEOUT_MS = '180000'
  $env:VITE_BAIDU_BROWSER_AK = '__BAIDUMAP_RUNTIME_BROWSER_AK__'

  Push-Location $repositoryRoot
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
  }
  finally {
    Pop-Location
  }

  $occurrences = 0
  Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'dist') -Recurse -File -Filter '*.js' | ForEach-Object {
    $content = Get-Content -Raw -LiteralPath $_.FullName
    $occurrences += [regex]::Matches($content, [regex]::Escape('__BAIDUMAP_RUNTIME_BROWSER_AK__')).Count
  }
  if ($occurrences -lt 1) {
    throw 'Frontend build does not contain the runtime browser AK placeholder.'
  }
  Write-Host "Frontend desktop build ready; browser AK placeholder occurrences: $occurrences"
}
finally {
  foreach ($name in $variableNames) {
    $previous = $previousValues[$name]
    if ($null -eq $previous) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:$name" -Value $previous }
  }
}

