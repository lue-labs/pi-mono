use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo::rerun-if-changed=src/native-addon.c");

    let output = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set")).join("native-addon.o");
    let status = Command::new("clang")
        .args(["-c", "-fPIC", "src/native-addon.c", "-o"])
        .arg(&output)
        .status()
        .expect("clang is available for the macOS addon experiment");
    assert!(status.success(), "native addon shim compilation failed");

    let archive = output.with_file_name("librusty_core_recast_napi.a");
    let status = Command::new("ar")
        .args(["crs"])
        .arg(&archive)
        .arg(&output)
        .status()
        .expect("ar is available for the macOS addon experiment");
    assert!(status.success(), "native addon shim archive failed");

    println!(
        "cargo::rustc-link-search=native={}",
        archive.parent().expect("archive parent").display()
    );
    println!("cargo::rustc-link-lib=static=rusty_core_recast_napi");
    println!("cargo::rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    println!("cargo::rustc-cdylib-link-arg=-Wl,-exported_symbol,_napi_register_module_v1");
}
