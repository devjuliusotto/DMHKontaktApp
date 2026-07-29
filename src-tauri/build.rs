fn main() {
    println!("cargo:rerun-if-env-changed=M365_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=M365_TENANT_ID");
    tauri_build::build()
}
