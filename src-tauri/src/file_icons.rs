use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

const ICON_SIZE: i32 = 32;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileIcon {
    width: u32,
    height: u32,
    rgba_base64: String,
}

fn extension_key(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn explorer_icon(extension: &str) -> Result<SystemFileIcon, String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::{null_mut, write_bytes};
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL};

    let representative_name = if extension.is_empty() {
        "dmh-file".to_string()
    } else {
        format!("dmh-file{extension}")
    };
    let wide_name = representative_name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut shell_info = SHFILEINFOW::default();
    let shell_result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_name.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shell_info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if shell_result == 0 || shell_info.hIcon.0.is_null() {
        return Err(format!(
            "Windows konnte kein Explorer-Symbol für {extension} liefern."
        ));
    }

    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.0.is_null() {
        unsafe {
            DestroyIcon(shell_info.hIcon).ok();
        }
        return Err(
            "Windows konnte keine Zeichenfläche für das Dateisymbol erstellen.".to_string(),
        );
    }

    let mut bitmap_info = BITMAPINFO::default();
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: ICON_SIZE,
        biHeight: -ICON_SIZE,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: (ICON_SIZE * ICON_SIZE * 4) as u32,
        ..Default::default()
    };
    let mut pixels: *mut c_void = null_mut();
    let bitmap = match unsafe {
        CreateDIBSection(
            Some(hdc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut pixels,
            None,
            0,
        )
    } {
        Ok(bitmap) => bitmap,
        Err(error) => {
            unsafe {
                let _ = DeleteDC(hdc);
                DestroyIcon(shell_info.hIcon).ok();
            }
            return Err(error.to_string());
        }
    };
    let old_bitmap = unsafe { SelectObject(hdc, HGDIOBJ(bitmap.0)) };
    let byte_count = (ICON_SIZE * ICON_SIZE * 4) as usize;
    unsafe {
        write_bytes(pixels.cast::<u8>(), 0, byte_count);
    }
    let draw_result = unsafe {
        DrawIconEx(
            hdc,
            0,
            0,
            shell_info.hIcon,
            ICON_SIZE,
            ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        )
    };

    let mut rgba = Vec::with_capacity(byte_count);
    if draw_result.is_ok() {
        let bgra = unsafe { std::slice::from_raw_parts(pixels.cast::<u8>(), byte_count) };
        for pixel in bgra.chunks_exact(4) {
            let alpha = pixel[3] as u32;
            let unpremultiply = |channel: u8| {
                if alpha == 0 {
                    0
                } else {
                    ((channel as u32 * 255 + alpha / 2) / alpha).min(255) as u8
                }
            };
            rgba.extend_from_slice(&[
                unpremultiply(pixel[2]),
                unpremultiply(pixel[1]),
                unpremultiply(pixel[0]),
                pixel[3],
            ]);
        }
    }
    unsafe {
        SelectObject(hdc, old_bitmap);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(hdc);
        DestroyIcon(shell_info.hIcon).ok();
    }
    draw_result.map_err(|error| error.to_string())?;

    Ok(SystemFileIcon {
        width: ICON_SIZE as u32,
        height: ICON_SIZE as u32,
        rgba_base64: BASE64_STANDARD.encode(rgba),
    })
}

#[cfg(not(target_os = "windows"))]
fn explorer_icon(_extension: &str) -> Result<SystemFileIcon, String> {
    Err("Systemsymbole sind auf dieser Plattform noch nicht verfügbar.".to_string())
}

#[tauri::command]
pub fn get_document_file_icons(
    file_names: Vec<String>,
) -> Result<HashMap<String, SystemFileIcon>, String> {
    let extensions = file_names
        .iter()
        .map(|name| extension_key(name))
        .collect::<HashSet<_>>();
    let mut icons = HashMap::new();
    for extension in extensions {
        if let Ok(icon) = explorer_icon(&extension) {
            icons.insert(extension, icon);
        }
    }
    Ok(icons)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_file_extensions_for_the_icon_cache() {
        assert_eq!(extension_key("Bericht.DOCX"), ".docx");
        assert_eq!(extension_key("Archiv.tar.gz"), ".gz");
        assert_eq!(extension_key("README"), "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_visible_icons_from_the_windows_shell() {
        for extension in [".docx", ".xlsx", ".txt"] {
            let icon = explorer_icon(extension).expect("Explorer icon");
            let rgba = BASE64_STANDARD
                .decode(&icon.rgba_base64)
                .expect("RGBA payload");
            assert_eq!(rgba.len(), (icon.width * icon.height * 4) as usize);
            assert!(rgba.chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
    }
}
