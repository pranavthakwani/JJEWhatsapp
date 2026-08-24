$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location -LiteralPath '$backend'; node src\server.js"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location -LiteralPath '$backend'; node src\worker.js"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location -LiteralPath '$frontend'; node node_modules\vite\bin\vite.js --host 0.0.0.0 --port 5176"

Write-Host "JJEWA backend starting on http://localhost:4500"
Write-Host "JJEWA worker starting"
Write-Host "JJEWA frontend starting on http://localhost:5176"
