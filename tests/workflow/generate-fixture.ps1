Add-Type -AssemblyName System.Speech
$fixtureDirectory=Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $fixtureDirectory | Out-Null
$speaker=[System.Speech.Synthesis.SpeechSynthesizer]::new()
try{
  $speaker.SelectVoice('Microsoft Huihui Desktop');$speaker.Rate=-1
  $speaker.SetOutputToWaveFile((Join-Path $fixtureDirectory 'mandarin-exam.wav'))
  $speaker.Speak('同学们请注意，期末考试安排在十月二十日上午九点。考试范围包括第三章和工作记忆。请在下周五下午五点之前提交报告。如果有问题，请课后联系老师。')
}finally{$speaker.Dispose()}
