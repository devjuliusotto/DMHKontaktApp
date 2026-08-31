use super::{hidden_command, powershell_single_quote, CalendarEvent};
use serde::{Deserialize, Serialize};
use std::{env, fs};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlookCalendarExportPayload {
    events: Vec<CalendarEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutlookCalendarPushData {
    created: usize,
    updated: usize,
    errors: usize,
    folder_path: String,
    store_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlookCalendarPushResult {
    pub total: usize,
    pub created: usize,
    pub updated: usize,
    pub errors: usize,
    pub folder_path: String,
    pub store_name: String,
}

#[tauri::command]
pub fn push_project_appointments_to_outlook(
    events: Vec<CalendarEvent>,
    target_email: Option<String>,
) -> Result<OutlookCalendarPushResult, String> {
    let events = active_events(events);
    let total = events.len();
    if total == 0 {
        return Ok(OutlookCalendarPushResult {
            total: 0,
            created: 0,
            updated: 0,
            errors: 0,
            folder_path: String::new(),
            store_name: String::new(),
        });
    }

    let payload = OutlookCalendarExportPayload { events };
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let json_path = env::temp_dir().join(format!(
        "agendakontakte-outlook-calendar-{}.json",
        Uuid::new_v4()
    ));
    fs::write(&json_path, json).map_err(|error| error.to_string())?;

    let escaped_path = powershell_single_quote(&json_path.to_string_lossy());
    let target_email = powershell_single_quote(target_email.as_deref().unwrap_or_default().trim());
    let script = OUTLOOK_CALENDAR_EXPORT_SCRIPT
        .replace("__EVENTS_PATH__", &escaped_path)
        .replace("__TARGET_EMAIL__", &target_email);

    let output = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script.as_str(),
        ])
        .output()
        .map_err(|error| format!("Outlook Classic konnte nicht gestartet werden: {error}"));

    let _ = fs::remove_file(&json_path);
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Die Termine konnten nicht an Outlook Classic übertragen werden. {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data = serde_json::from_str::<OutlookCalendarPushData>(stdout.trim()).map_err(|error| {
        format!("Die Outlook-Kalenderantwort konnte nicht ausgewertet werden: {error}. Ausgabe: {stdout}")
    })?;
    Ok(OutlookCalendarPushResult {
        total,
        created: data.created,
        updated: data.updated,
        errors: data.errors,
        folder_path: data.folder_path,
        store_name: data.store_name,
    })
}

fn active_events(events: Vec<CalendarEvent>) -> Vec<CalendarEvent> {
    events
        .into_iter()
        .filter(|event| {
            !event.starts_at.trim().is_empty()
                && event
                    .deleted_at
                    .as_deref()
                    .is_none_or(|deleted_at| deleted_at.trim().is_empty())
        })
        .collect()
}

const OUTLOOK_CALENDAR_EXPORT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$eventsPath = __EVENTS_PATH__
$targetEmail = __TARGET_EMAIL__
$payload = Get-Content -LiteralPath $eventsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$localEvents = @($payload.events | ForEach-Object { $_ })
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$targetAccount = $null
$calendarFolder = $null

if (-not [string]::IsNullOrWhiteSpace($targetEmail)) {
  for ($accountIndex = 1; $accountIndex -le $namespace.Accounts.Count; $accountIndex++) {
    $candidate = $namespace.Accounts.Item($accountIndex)
    if (([string]$candidate.SmtpAddress).Trim().ToLowerInvariant() -eq $targetEmail.Trim().ToLowerInvariant()) {
      $targetAccount = $candidate
      try { $calendarFolder = $candidate.DeliveryStore.GetDefaultFolder(9) } catch {}
      break
    }
  }
  if ($null -eq $targetAccount) { throw "Das Outlook-IMAP-Konto '$targetEmail' wurde im aktuellen Outlook-Profil nicht gefunden." }
  if ($null -eq $calendarFolder) { throw "Für das Outlook-IMAP-Konto '$targetEmail' wurde kein lokaler Kalender gefunden." }
}
if ($null -eq $calendarFolder) { $calendarFolder = $namespace.GetDefaultFolder(9) }

$createdCount = 0
$updatedCount = 0
$errorCount = 0
$storeName = ''
try { $storeName = [string]$calendarFolder.Store.DisplayName } catch {}
$folderItems = New-Object System.Collections.ArrayList
try {
  $items = $calendarFolder.Items
  for ($index = 1; $index -le $items.Count; $index++) {
    try {
      $item = $items.Item($index)
      if ([string]$item.MessageClass -like 'IPM.Appointment*') { $folderItems.Add($item) | Out-Null }
    } catch {}
  }
} catch {}

function Get-Scalar($value) {
  if ($null -eq $value) { return '' }
  if ($value -is [System.Array]) {
    if ($value.Count -eq 0) { return '' }
    return $value[0]
  }
  return $value
}

function Convert-ToOutlookDate($value) {
  $text = ([string](Get-Scalar $value)).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  $date = [datetime]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
  if ($date.Kind -eq [System.DateTimeKind]::Utc) { return $date.ToLocalTime() }
  return $date
}

function Find-Outlook-Appointment($local, $start, $end) {
  $localId = ([string](Get-Scalar $local.id)).Trim()
  $title = ([string](Get-Scalar $local.title)).Trim()
  $location = ([string](Get-Scalar $local.location)).Trim()
  foreach ($item in $folderItems.ToArray()) {
    try {
      if (-not [string]::IsNullOrWhiteSpace($localId)) {
        $property = $item.UserProperties.Find('DMHLocalEventId')
        if ($null -ne $property -and ([string]$property.Value).Trim() -eq $localId) { return $item }
      }
      if (([string]$item.Subject).Trim() -eq $title -and
          ([datetime]$item.Start) -eq $start -and
          ([datetime]$item.End) -eq $end -and
          ([string]$item.Location).Trim() -eq $location) { return $item }
    } catch {}
  }
  return $null
}

function Get-DayOfWeekMask($days) {
  $mask = 0
  foreach ($dayValue in @($days)) {
    $day = [int]$dayValue
    if ($day -ge 0 -and $day -le 6) { $mask = $mask -bor (1 -shl $day) }
  }
  return $mask
}

function Ensure-Outlook-Category($nameValue, $colorValue) {
  $name = ([string](Get-Scalar $nameValue)).Trim()
  if ([string]::IsNullOrWhiteSpace($name)) { return }
  try { $namespace.Categories.Item($name) | Out-Null; return } catch {}
  $color = switch (([string](Get-Scalar $colorValue)).Trim().ToLowerInvariant()) {
    'red' { 1 }
    'yellow' { 4 }
    'green' { 5 }
    'purple' { 9 }
    'gray' { 13 }
    default { 8 }
  }
  try { $namespace.Categories.Add($name, $color) | Out-Null } catch {}
}

function Set-Outlook-Recurrence($item, $local, $start, $end) {
  $recurrence = $local.recurrence
  if ($null -eq $recurrence) {
    try { if ([bool]$item.IsRecurring) { $item.ClearRecurrencePattern() } } catch {}
    return
  }

  try { if ([bool]$item.IsRecurring) { $item.ClearRecurrencePattern(); $item.Save() } } catch {}
  $frequency = ([string](Get-Scalar $recurrence.frequency)).Trim().ToLowerInvariant()
  $weekOfMonth = [int](Get-Scalar $recurrence.weekOfMonth)
  $type = switch ($frequency) {
    'daily' { 0 }
    'weekly' { 1 }
    'monthly' { if ($weekOfMonth -ne 0) { 3 } else { 2 } }
    'yearly' { if ($weekOfMonth -ne 0) { 6 } else { 5 } }
    default { $null }
  }
  if ($null -eq $type) { return }

  $pattern = $item.GetRecurrencePattern()
  $pattern.RecurrenceType = $type
  $pattern.PatternStartDate = $start.Date
  $pattern.StartTime = $start
  $pattern.EndTime = $end
  $pattern.Duration = [Math]::Max(1, [int]($end - $start).TotalMinutes)
  $interval = [Math]::Max(1, [int](Get-Scalar $recurrence.interval))
  $pattern.Interval = $interval

  $mask = Get-DayOfWeekMask $recurrence.daysOfWeek
  if ($type -in 1, 3, 6 -and $mask -gt 0) { $pattern.DayOfWeekMask = $mask }
  if ($type -in 2, 5) {
    $dayOfMonth = [int](Get-Scalar $recurrence.dayOfMonth)
    $pattern.DayOfMonth = if ($dayOfMonth -gt 0) { $dayOfMonth } else { $start.Day }
  }
  if ($type -in 5, 6) {
    $monthOfYear = [int](Get-Scalar $recurrence.monthOfYear)
    $pattern.MonthOfYear = if ($monthOfYear -gt 0) { $monthOfYear } else { $start.Month }
  }
  if ($type -in 3, 6) { $pattern.Instance = if ($weekOfMonth -eq -1) { 5 } else { [Math]::Max(1, [Math]::Min(5, $weekOfMonth)) } }

  $count = [int](Get-Scalar $recurrence.count)
  $untilText = ([string](Get-Scalar $recurrence.until)).Trim()
  if ($count -gt 0) {
    $pattern.Occurrences = $count
  } elseif (-not [string]::IsNullOrWhiteSpace($untilText)) {
    $pattern.NoEndDate = $false
    $pattern.PatternEndDate = (Convert-ToOutlookDate $untilText).Date
  } else {
    $pattern.NoEndDate = $true
  }
  $item.Save()

  if (@($local.excludedDates).Count -gt 0) {
    $pattern = $item.GetRecurrencePattern()
    foreach ($excludedText in @($local.excludedDates)) {
      try {
        $excludedDate = Convert-ToOutlookDate $excludedText
        if ($null -eq $excludedDate) { continue }
        $occurrenceDate = $excludedDate.Date.Add($start.TimeOfDay)
        $pattern.GetOccurrence($occurrenceDate).Delete()
      } catch { $script:errorCount++ }
    }
  }
}

foreach ($local in $localEvents) {
  try {
    $start = Convert-ToOutlookDate $local.startsAt
    if ($null -eq $start) { $errorCount++; continue }
    $end = Convert-ToOutlookDate $local.endsAt
    if ($null -eq $end -or $end -le $start) { $end = $start.AddHours(1) }
    $item = Find-Outlook-Appointment $local $start $end
    $isNew = $false
    if ($null -eq $item) {
      $item = $calendarFolder.Items.Add(1)
      $folderItems.Add($item) | Out-Null
      $isNew = $true
    }

    try { if ([bool]$item.IsRecurring) { $item.ClearRecurrencePattern() } } catch {}
    $title = ([string](Get-Scalar $local.title)).Trim()
    $item.Subject = if ([string]::IsNullOrWhiteSpace($title)) { 'Ohne Titel' } else { $title }
    $item.Start = $start
    $item.End = $end
    $item.Location = [string](Get-Scalar $local.location)
    $item.Body = [string](Get-Scalar $local.description)
    Ensure-Outlook-Category $local.category $local.color
    $item.Categories = [string](Get-Scalar $local.category)
    $item.MeetingStatus = 0
    $item.ReminderSet = $false
    $localId = ([string](Get-Scalar $local.id)).Trim()
    if (-not [string]::IsNullOrWhiteSpace($localId)) {
      $idProperty = $item.UserProperties.Find('DMHLocalEventId')
      if ($null -eq $idProperty) { $idProperty = $item.UserProperties.Add('DMHLocalEventId', 1, $true) }
      $idProperty.Value = $localId
    }
    $item.Save()
    Set-Outlook-Recurrence $item $local $start $end
    $item.Save()
    if ($isNew) { $createdCount++ } else { $updatedCount++ }
  } catch {
    $errorCount++
  }
}

[pscustomobject]@{
  created = $createdCount
  updated = $updatedCount
  errors = $errorCount
  folderPath = [string]$calendarFolder.FolderPath
  storeName = $storeName
} | ConvertTo-Json -Compress
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_script_enumerates_every_calendar_event() {
        assert!(OUTLOOK_CALENDAR_EXPORT_SCRIPT.contains("$payload.events | ForEach-Object"));
        assert!(OUTLOOK_CALENDAR_EXPORT_SCRIPT.contains("DMHLocalEventId"));
        assert!(OUTLOOK_CALENDAR_EXPORT_SCRIPT.contains("GetRecurrencePattern"));
    }

    #[test]
    fn calendar_export_skips_deleted_and_invalid_events() {
        let event = |id: &str, starts_at: &str, deleted_at: Option<&str>| CalendarEvent {
            id: id.to_string(),
            updated_at: String::new(),
            title: id.to_string(),
            starts_at: starts_at.to_string(),
            ends_at: "2026-09-01T11:00:00".to_string(),
            location: String::new(),
            description: String::new(),
            color: "blue".to_string(),
            category: String::new(),
            source: "local".to_string(),
            recurrence: None,
            excluded_dates: Vec::new(),
            deleted_at: deleted_at.map(str::to_string),
            recurrence_master_id: None,
            recurrence_id: None,
        };
        let active = active_events(vec![
            event("active", "2026-09-01T10:00:00", None),
            event("legacy-active", "2026-09-01T10:00:00", Some("")),
            event("deleted", "2026-09-01T10:00:00", Some("2026-08-31")),
            event("invalid", "", None),
        ]);
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].id, "active");
        assert_eq!(active[1].id, "legacy-active");
    }
}
