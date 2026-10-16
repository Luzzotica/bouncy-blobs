//! iOS with `--features storekit`: compile the StoreKit 2 bridge
//! (`ios/StoreKitBridge/StoreKitBridge.swift`) into a static library and
//! link it, with the Swift runtime search paths. Nothing happens otherwise.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("apple-ios") || std::env::var_os("CARGO_FEATURE_STOREKIT").is_none() {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift = manifest.join("../../ios/StoreKitBridge/StoreKitBridge.swift");
    println!("cargo:rerun-if-changed={}", swift.display());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let sim = target.ends_with("-sim") || target.starts_with("x86_64");
    let sdk = if sim { "iphonesimulator" } else { "iphoneos" };
    let xcrun = |args: &[&str]| -> String {
        let o = Command::new("xcrun").args(args).output().expect("xcrun");
        assert!(o.status.success(), "xcrun {args:?} failed");
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    };
    let sdk_path = xcrun(&["--sdk", sdk, "--show-sdk-path"]);
    let arch = if target.starts_with("x86_64") { "x86_64" } else { "arm64" };
    // StoreKit 2 and Swift concurrency need iOS 15.
    let swift_target = format!("{arch}-apple-ios15.0{}", if sim { "-simulator" } else { "" });
    let lib = out.join("libbbstorekit.a");
    let status = Command::new("xcrun")
        .args(["--sdk", sdk, "swiftc", "-emit-library", "-static", "-parse-as-library", "-swift-version", "5", "-O"])
        .args(["-module-name", "BBStoreKit", "-target", &swift_target, "-sdk", &sdk_path])
        .arg(&swift)
        .arg("-o")
        .arg(&lib)
        .status()
        .expect("swiftc");
    assert!(status.success(), "swiftc failed on {}", swift.display());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=bbstorekit");
    // The Swift runtime: the OS copy (SDK .tbd stubs) plus the toolchain's
    // static compatibility shims, which the object autolinks.
    println!("cargo:rustc-link-search=native={sdk_path}/usr/lib/swift");
    let swiftc = PathBuf::from(xcrun(&["--sdk", sdk, "--find", "swiftc"]));
    if let Some(toolchain) = swiftc.parent().and_then(|p| p.parent()) {
        println!("cargo:rustc-link-search=native={}", toolchain.join("lib/swift").join(sdk).display());
    }
    println!("cargo:rustc-link-lib=framework=StoreKit");
}
