use std::path::PathBuf;

fn main() {
    // Point steamworks-sys at the vendored SDK so it can find headers + libs.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sdk = manifest_dir.join("resources").join("steamworks");
    println!("cargo:rustc-env=STEAM_SDK_LOCATION={}", sdk.display());
    println!("cargo:rerun-if-changed=resources/steamworks");

    // On Linux, look for libsteam_api.so next to the binary at runtime.
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");

    // On macOS, look for the dylib in the app bundle's Frameworks dir and adjacent to the binary.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    tauri_build::build();
}
