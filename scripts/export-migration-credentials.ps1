#requires -Version 7.0

[CmdletBinding()]
param(
  [string]$InputWorkbook,
  [string]$OutputCsv,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$script:ExpectedAlgorithm = 'RSA-OAEP-256+A256GCM'
$script:PublicKeyConfigurationPath = Join-Path $PSScriptRoot '..\src-tauri\migration-public-key.json'

function Get-AdminCertificate {
  param([Parameter(Mandatory)][string]$KeyId)

  $normalizedKeyId = ($KeyId -replace '\s', '').ToUpperInvariant()
  $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$normalizedKeyId" -ErrorAction SilentlyContinue
  if (-not $certificate -or -not $certificate.HasPrivateKey) {
    throw "Der private EDV-Schlüssel '$normalizedKeyId' ist für diesen Windows-Benutzer auf diesem PC nicht vorhanden."
  }
  return $certificate
}

function Get-AuthenticatedMetadata {
  param(
    [Parameter(Mandatory)][int]$Version,
    [Parameter(Mandatory)][string]$SubmissionId,
    [Parameter(Mandatory)][string]$CapturedAt,
    [Parameter(Mandatory)][string]$Computer,
    [Parameter(Mandatory)][string]$KeyId
  )

  $value = "AKM$Version`n$SubmissionId`n$CapturedAt`n$Computer`n$KeyId"
  return [Text.Encoding]::UTF8.GetBytes($value)
}

function Unprotect-MigrationEnvelope {
  param([Parameter(Mandatory)]$Envelope)

  if ([int]$Envelope.Version -ne 1) {
    throw "Nicht unterstützte Paketversion '$($Envelope.Version)'."
  }
  if ([string]$Envelope.Algorithm -ne $script:ExpectedAlgorithm) {
    throw "Nicht unterstütztes Verschlüsselungsverfahren '$($Envelope.Algorithm)'."
  }

  $certificate = Get-AdminCertificate -KeyId ([string]$Envelope.KeyId)
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
  $wrappedKey = [Convert]::FromBase64String([string]$Envelope.WrappedKey)
  $nonce = [Convert]::FromBase64String([string]$Envelope.Nonce)
  $combinedCiphertext = [Convert]::FromBase64String([string]$Envelope.Ciphertext)
  $aad = Get-AuthenticatedMetadata `
    -Version ([int]$Envelope.Version) `
    -SubmissionId ([string]$Envelope.SubmissionId) `
    -CapturedAt ([string]$Envelope.CapturedAt) `
    -Computer ([string]$Envelope.Computer) `
    -KeyId ([string]$Envelope.KeyId)

  $dataKey = $null
  $plaintext = $null
  $aes = $null
  try {
    $dataKey = $rsa.Decrypt($wrappedKey, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    if ($dataKey.Length -ne 32) { throw 'Das entschlüsselte Sitzungsschlüssel-Format ist ungültig.' }
    if ($nonce.Length -ne 12) { throw 'Das Nonce-Format ist ungültig.' }
    if ($combinedCiphertext.Length -le 16) { throw 'Das verschlüsselte Datenfeld ist ungültig.' }

    $ciphertextLength = $combinedCiphertext.Length - 16
    $ciphertext = [byte[]]::new($ciphertextLength)
    $tag = [byte[]]::new(16)
    [Array]::Copy($combinedCiphertext, 0, $ciphertext, 0, $ciphertextLength)
    [Array]::Copy($combinedCiphertext, $ciphertextLength, $tag, 0, 16)
    $plaintext = [byte[]]::new($ciphertextLength)
    $aes = [Security.Cryptography.AesGcm]::new($dataKey, 16)
    $aes.Decrypt($nonce, $ciphertext, $tag, $plaintext, $aad)

    $json = [Text.Encoding]::UTF8.GetString($plaintext)
    return $json | ConvertFrom-Json
  }
  finally {
    if ($aes) { $aes.Dispose() }
    if ($rsa) { $rsa.Dispose() }
    if ($dataKey) { [Array]::Clear($dataKey, 0, $dataKey.Length) }
    if ($plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    [Array]::Clear($wrappedKey, 0, $wrappedKey.Length)
    [Array]::Clear($combinedCiphertext, 0, $combinedCiphertext.Length)
  }
}

function Get-EncryptedRowsFromWorkbook {
  param([Parameter(Mandatory)][string]$Path)

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $excel = $null
  $workbook = $null
  $worksheet = $null
  $table = $null
  $headerRange = $null
  $dataRange = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $workbook = $excel.Workbooks.Open($resolvedPath, 0, $true)
    $worksheet = $workbook.Worksheets.Item('IMAP-Migration')
    $table = $worksheet.ListObjects.Item('MigrationPasswords')
    if (-not $table.DataBodyRange) { return @() }

    $headerRange = $table.HeaderRowRange
    $dataRange = $table.DataBodyRange
    $headers = $headerRange.Value2
    $values = $dataRange.Value2
    $rowCount = [int]$table.ListRows.Count
    $columnCount = [int]$table.ListColumns.Count
    $rows = [Collections.Generic.List[object]]::new()

    for ($rowIndex = 1; $rowIndex -le $rowCount; $rowIndex++) {
      $row = [ordered]@{}
      for ($columnIndex = 1; $columnIndex -le $columnCount; $columnIndex++) {
        $row[[string]$headers[1, $columnIndex]] = $values[$rowIndex, $columnIndex]
      }
      $rows.Add([pscustomobject]$row)
    }
    return $rows.ToArray()
  }
  finally {
    if ($workbook) { $workbook.Close($false) }
    if ($excel) { $excel.Quit() }
    foreach ($item in @($dataRange, $headerRange, $table, $worksheet, $workbook, $excel)) {
      if ($item) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}

function Get-RowValue {
  param(
    [Parameter(Mandatory)]$Row,
    [Parameter(Mandatory)][string]$Name
  )

  $property = $Row.PSObject.Properties[$Name]
  if (-not $property) { throw "Die erforderliche Excel-Spalte '$Name' fehlt." }
  return $property.Value
}

function Select-InputWorkbook {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = 'Verschlüsselte SharePoint-Arbeitsmappe auswählen'
  $dialog.Filter = 'Excel-Arbeitsmappe (*.xlsx)|*.xlsx'
  if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return $null }
  return $dialog.FileName
}

function Select-OutputCsv {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = [Windows.Forms.SaveFileDialog]::new()
  $dialog.Title = 'Entschlüsselte Zugangsdaten speichern'
  $dialog.Filter = 'CSV-Datei (*.csv)|*.csv'
  $dialog.FileName = 'IMAP-zu-Exchange.csv'
  if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return $null }
  return $dialog.FileName
}

function Protect-OutputForCurrentUser {
  param([Parameter(Mandatory)][string]$Path)

  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  }
  catch {
    Write-Warning 'Die CSV wurde erstellt, ihre Windows-Dateiberechtigungen konnten jedoch nicht zusätzlich eingeschränkt werden.'
  }
}

function Invoke-SelfTest {
  $configuration = Get-Content -Raw -LiteralPath $script:PublicKeyConfigurationPath | ConvertFrom-Json
  $certificate = Get-AdminCertificate -KeyId ([string]$configuration.keyId)
  $publicRsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
  $dataKey = [byte[]]::new(32)
  $nonce = [byte[]]::new(12)
  [Security.Cryptography.RandomNumberGenerator]::Fill($dataKey)
  [Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
  $submissionId = '00000000-0000-0000-0000-000000000001'
  $capturedAt = '2026-07-15T12:00:00Z'
  $computer = 'SELFTEST-PC'
  $keyId = [string]$configuration.keyId
  $aad = Get-AuthenticatedMetadata -Version 1 -SubmissionId $submissionId -CapturedAt $capturedAt -Computer $computer -KeyId $keyId
  $plaintext = [Text.Encoding]::UTF8.GetBytes('{"accounts":[{"accountName":"Test","email":"test@example.invalid","incomingUser":"test","incomingServer":"imap.example.invalid","incomingPort":993,"password":"dummy-secret"}]}')
  $ciphertext = [byte[]]::new($plaintext.Length)
  $tag = [byte[]]::new(16)
  $aes = [Security.Cryptography.AesGcm]::new($dataKey, 16)
  $aes.Encrypt($nonce, $plaintext, $ciphertext, $tag, $aad)
  $combined = [byte[]]::new($ciphertext.Length + $tag.Length)
  [Array]::Copy($ciphertext, 0, $combined, 0, $ciphertext.Length)
  [Array]::Copy($tag, 0, $combined, $ciphertext.Length, $tag.Length)
  $wrappedKey = $publicRsa.Encrypt($dataKey, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  $envelope = [pscustomobject]@{
    Version = 1
    SubmissionId = $submissionId
    CapturedAt = $capturedAt
    Computer = $computer
    KeyId = $keyId
    Algorithm = $script:ExpectedAlgorithm
    WrappedKey = [Convert]::ToBase64String($wrappedKey)
    Nonce = [Convert]::ToBase64String($nonce)
    Ciphertext = [Convert]::ToBase64String($combined)
  }
  try {
    $result = Unprotect-MigrationEnvelope -Envelope $envelope
    if ($result.accounts[0].password -ne 'dummy-secret') { throw 'Der Selbsttest lieferte einen falschen Inhalt.' }
    Write-Host 'Selbsttest erfolgreich: Die lokale private Schlüsselverwendung und AES-GCM-Entschlüsselung funktionieren.' -ForegroundColor Green
  }
  finally {
    $aes.Dispose()
    $publicRsa.Dispose()
    foreach ($buffer in @($dataKey, $plaintext)) { [Array]::Clear($buffer, 0, $buffer.Length) }
  }
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

if ([string]::IsNullOrWhiteSpace($InputWorkbook)) { $InputWorkbook = Select-InputWorkbook }
if ([string]::IsNullOrWhiteSpace($InputWorkbook)) { Write-Host 'Abgebrochen.'; exit 0 }
if ([string]::IsNullOrWhiteSpace($OutputCsv)) { $OutputCsv = Select-OutputCsv }
if ([string]::IsNullOrWhiteSpace($OutputCsv)) { Write-Host 'Abgebrochen.'; exit 0 }

$encryptedRows = @(Get-EncryptedRowsFromWorkbook -Path $InputWorkbook)
if ($encryptedRows.Count -eq 0) { throw 'Die Arbeitsmappe enthält noch keine verschlüsselten Übertragungen.' }

$seenSubmissions = @{}
$exportRows = [Collections.Generic.List[object]]::new()
foreach ($row in $encryptedRows) {
  $submissionId = [string](Get-RowValue -Row $row -Name 'Übertragungs-ID')
  if ($seenSubmissions.ContainsKey($submissionId)) { continue }
  $seenSubmissions[$submissionId] = $true

  $envelope = [pscustomobject]@{
    Version = [int](Get-RowValue -Row $row -Name 'Version')
    SubmissionId = $submissionId
    CapturedAt = [string](Get-RowValue -Row $row -Name 'Erfasst am')
    Computer = [string](Get-RowValue -Row $row -Name 'Computer')
    KeyId = [string](Get-RowValue -Row $row -Name 'Schlüssel-ID')
    Algorithm = [string](Get-RowValue -Row $row -Name 'Algorithmus')
    WrappedKey = [string](Get-RowValue -Row $row -Name 'Verschlüsselter Schlüssel')
    Nonce = [string](Get-RowValue -Row $row -Name 'Nonce')
    Ciphertext = [string](Get-RowValue -Row $row -Name 'Verschlüsselte Daten')
  }
  $content = Unprotect-MigrationEnvelope -Envelope $envelope
  foreach ($account in @($content.accounts)) {
    $exportRows.Add([pscustomobject][ordered]@{
      'E-Mail-Adresse' = [string]$account.email
      'IMAP-Benutzer' = [string]$account.incomingUser
      'Kennwort' = [string]$account.password
      'IMAP-Server' = [string]$account.incomingServer
      'IMAP-Port' = [int]$account.incomingPort
      'Kontoname' = [string]$account.accountName
      'Computer' = [string]$envelope.Computer
      'Erfasst am' = [string]$envelope.CapturedAt
      'Übertragungs-ID' = [string]$envelope.SubmissionId
    })
  }
}

if ($exportRows.Count -eq 0) { throw 'Es wurden keine IMAP-Konten in den Paketen gefunden.' }
$resolvedCsv = [IO.Path]::GetFullPath($OutputCsv)
$exportRows | Export-Csv -LiteralPath $resolvedCsv -Delimiter ';' -NoTypeInformation -Encoding utf8BOM
Protect-OutputForCurrentUser -Path $resolvedCsv

Write-Host "CSV erfolgreich erstellt: $resolvedCsv" -ForegroundColor Green
Write-Warning 'Diese CSV enthält Kennwörter im Klartext. Laden Sie sie direkt in das Migrationssystem und löschen Sie sie anschließend sicher.'

