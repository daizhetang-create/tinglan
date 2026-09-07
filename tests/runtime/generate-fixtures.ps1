[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'fixtures')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$runtimeRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
if (-not $resolvedOutput.StartsWith("$runtimeRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Fixture output must stay inside $runtimeRoot"
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

function New-SpeechFixture {
  param(
    [Parameter(Mandatory)] [string]$Voice,
    [Parameter(Mandatory)] [string]$Text,
    [Parameter(Mandatory)] [string]$FileName
  )
  $target = Join-Path $resolvedOutput $FileName
  $speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $speaker.SelectVoice($Voice)
    $speaker.Rate = -1
    $speaker.SetOutputToWaveFile($target)
    $speaker.Speak($Text)
  } finally {
    $speaker.Dispose()
  }
  Write-Host "Generated $target"
}

New-SpeechFixture `
  -Voice 'Microsoft Huihui Desktop' `
  -FileName 'mandarin-classroom.wav' `
  -Text '同学们请注意，今天的核心概念是工作记忆。作业是阅读第三章，并且在下周五之前提交一份报告。这些内容会出现在期末考试中。'

New-SpeechFixture `
  -Voice 'Microsoft Zira Desktop' `
  -FileName 'english-classroom.wav' `
  -Text 'Please remember that working memory is the key concept. Read chapter three and submit the assignment by next Friday. This topic will appear on the final exam.'
