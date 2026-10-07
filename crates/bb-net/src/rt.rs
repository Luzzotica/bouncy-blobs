//! The tiny async runtime surface bb-net needs, per platform.
//!
//! Native: one lazily-built multi-thread tokio runtime (2 workers) owned by
//! bb-net, so nothing ever runs on Bevy's main thread. Web: the browser event
//! loop via `spawn_local`.

use std::future::Future;

/// `Send` on native (tokio moves tasks between workers); nothing on wasm,
/// where browser handles are `!Send` and everything is single-threaded.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}
#[cfg(target_arch = "wasm32")]
impl<T> MaybeSend for T {}

#[cfg(not(target_arch = "wasm32"))]
pub fn runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("bb-net")
            .enable_all()
            .build()
            .expect("bb-net: failed to start the tokio runtime")
    })
}

pub fn spawn(f: impl Future<Output = ()> + MaybeSend + 'static) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        runtime().spawn(f);
    }
    #[cfg(target_arch = "wasm32")]
    {
        wasm_bindgen_futures::spawn_local(f);
    }
}

pub async fn sleep_ms(ms: u32) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
    }
    #[cfg(target_arch = "wasm32")]
    {
        let p = js_sys::Promise::new(&mut |resolve, _| {
            if let Some(w) = web_sys::window() {
                let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms as i32);
            }
        });
        let _ = wasm_bindgen_futures::JsFuture::from(p).await;
    }
}

/// Wall-clock milliseconds since the Unix epoch (for the phone dedupe and
/// token expiry; never used for simulation).
pub fn now_ms() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
}

/// Random 64 bits without a rand dependency: std's per-process hasher keys
/// mixed with the clock. Only used for ids, never for security.
pub fn random_u64() -> u64 {
    #[allow(unused_imports)]
    use std::hash::{BuildHasher, Hasher};
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(now_ms().to_bits());
        h.finish()
    }
    #[cfg(target_arch = "wasm32")]
    {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        h.write_u64(now_ms().to_bits());
        h.write_u64((js_sys::Math::random() * 4294967296.0) as u64);
        h.write_u64((js_sys::Math::random() * 4294967296.0) as u64);
        h.finish()
    }
}

/// A v4-shaped UUID for the Lobbii `device_id`.
pub fn uuid_v4() -> String {
    let a = random_u64();
    let b = random_u64() ^ a.rotate_left(17);
    let a = (a & !0xF000) | 0x4000;
    let b = (b & !(0xC << 60)) | (0x8 << 60);
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16,
        (b >> 48) as u16,
        b & 0xFFFF_FFFF_FFFF
    )
}
