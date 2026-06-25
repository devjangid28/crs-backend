param([int]$Port = 5000)

$found = $false
$connections = netstat -ano | Select-String ":$Port\s"
foreach ($conn in $connections) {
  $parts = ($conn.ToString()) -split '\s+'
  $procId = $parts[-1]
  if ($procId -match '^\d+$') {
    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
      Write-Host "Killing $($proc.ProcessName) (PID: $procId) on port $Port..." -ForegroundColor Yellow
      Stop-Process -Id $procId -Force
      $found = $true
    } catch {}
  }
}

if ($found) {
  Write-Host "Waiting for port $Port to be released..." -ForegroundColor Yellow
  Start-Sleep -Seconds 2
}

Write-Host "Starting CRS Backend on port $Port..." -ForegroundColor Green
& "node" "src/server.js"
