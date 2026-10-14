param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskRoot = $PSScriptRoot
$taskNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($taskNode) { $taskNodePath = $taskNode.Source }
else {
  $taskBundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if (Test-Path -LiteralPath $taskBundledNode) { $taskNodePath = $taskBundledNode }
  else { throw 'Node.js was not found. Install Node.js or open Codex once to initialize its runtime.' }
}
$taskServerPath = Join-Path $taskRoot 'server.mjs'
if (-not (Test-Path -LiteralPath $taskServerPath)) { throw 'server.mjs is missing. Extract the entire player ZIP first.' }
$taskArguments = @($taskServerPath)
if (-not $NoOpen) { $taskArguments += '--open' }
& $taskNodePath @taskArguments
exit $LASTEXITCODE
