# Upload server folder to Hostinger VPS and print next steps
# Usage: .\scripts\upload-to-vps.ps1

param(
  [string]$HostIp = "200.234.32.222",
  [string]$User = "root",
  [string]$RemoteDir = "/opt/satpuda-upload"
)

$ErrorActionPreference = "Stop"
$ServerRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Uploading $ServerRoot -> ${User}@${HostIp}:${RemoteDir}"
ssh "${User}@${HostIp}" "mkdir -p $RemoteDir"
scp -r "$ServerRoot\*" "${User}@${HostIp}:${RemoteDir}/"

Write-Host ""
Write-Host "Upload done. SSH in and run:"
Write-Host "  ssh ${User}@${HostIp}"
Write-Host "  cd $RemoteDir"
Write-Host "  chmod +x scripts/deploy.sh"
Write-Host "  bash scripts/deploy.sh"
