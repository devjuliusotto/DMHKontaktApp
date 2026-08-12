fn main() {
    println!("cargo:rerun-if-env-changed=M365_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=M365_EDV_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=M365_TENANT_ID");
    println!("cargo:rerun-if-env-changed=DMH_PORTAL_PRIVATSCHWESTERN_GROUP_IDS");
    println!("cargo:rerun-if-env-changed=DMH_PORTAL_EDV_GROUP_IDS");
    println!("cargo:rerun-if-env-changed=DMH_PORTAL_KFZ_GROUP_IDS");
    println!("cargo:rerun-if-env-changed=DMH_RELEASE_CHANNEL");
    println!("cargo:rerun-if-env-changed=MIGRATION_CAPTURE_URL");
    tauri_build::build()
}
