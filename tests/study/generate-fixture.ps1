param([string]$OutputPath = (Join-Path $PSScriptRoot 'assignment-fixture.png'))
Add-Type -AssemblyName System.Drawing
$canvas = [System.Drawing.Bitmap]::new(1400, 760)
$drawing = [System.Drawing.Graphics]::FromImage($canvas)
$drawing.Clear([System.Drawing.Color]::White)
$drawing.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$headingFont = [System.Drawing.Font]::new('Arial', 34, [System.Drawing.FontStyle]::Bold)
$bodyFont = [System.Drawing.Font]::new('Arial', 27)
$drawing.DrawString('SYNTHETIC TEST - Academic English', $headingFont, [System.Drawing.Brushes]::Navy, 45, 45)
$lines = @('Assignment: Write a 500-word report on memory and learning.', 'Deadline: next Friday at 5 pm.', 'Use three academic sources. Submit as a PDF in the portal.', 'Final exam: October 20 at 9 am. Bring your student ID.', 'No exam year is stated on this sheet.')
for ($index = 0; $index -lt $lines.Count; $index++) {
  $drawing.DrawString($lines[$index], $bodyFont, [System.Drawing.Brushes]::Black, 45, (155 + $index * 98))
}
$canvas.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$drawing.Dispose(); $canvas.Dispose(); $headingFont.Dispose(); $bodyFont.Dispose()
Write-Output $OutputPath
