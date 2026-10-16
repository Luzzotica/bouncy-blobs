// StoreKit 2 bridge for Bouncy Blobs (iOS). Called from Rust:
// crates/bb-game/src/store.rs declares these C functions; crates/bb-mobile's
// build.rs compiles this file into a static library when bb-mobile is built
// with `--features storekit`.
//
// The rule (partii GUIDE §4): a purchase is finished only after partii has
// accepted its receipt. Rust polls events from here, sends the transaction
// id with `acct.submit_receipt("appstore", {"transaction": id})`, and calls
// `bb_sk_finish(id)` on Ok. An unfinished transaction is delivered again
// through `Transaction.updates` on the next launch.
//
// Needs iOS 15 (StoreKit 2 + Swift concurrency); see docs/MobileRelease.md.

import Foundation
import StoreKit

@available(iOS 15.0, *)
private final class Bridge: @unchecked Sendable {
    static let shared = Bridge()

    private let lock = NSLock()
    private var events: [String] = []
    private var unfinished: [UInt64: Transaction] = [:]
    private var updates: Task<Void, Never>?
    /// The product's localized price ("$4.99"), once the App Store said.
    private var price: String?
    var productID = ""

    func push(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let text = String(data: data, encoding: .utf8) else { return }
        lock.lock(); events.append(text); lock.unlock()
    }

    func pop(into buf: UnsafeMutablePointer<UInt8>, cap: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard let first = events.first else { return 0 }
        let bytes = Array(first.utf8)
        if bytes.count > cap { return -bytes.count }
        bytes.withUnsafeBufferPointer { buf.update(from: $0.baseAddress!, count: bytes.count) }
        events.removeFirst()
        return bytes.count
    }

    func setPrice(_ p: Product) {
        lock.lock(); price = p.displayPrice; lock.unlock()
    }

    /// The price as UTF-8 in `buf`: its length, 0 when unknown, or minus the
    /// size needed when `cap` is too small.
    func copyPrice(into buf: UnsafeMutablePointer<UInt8>, cap: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard let p = price, !p.isEmpty else { return 0 }
        let bytes = Array(p.utf8)
        if bytes.count > cap { return -bytes.count }
        bytes.withUnsafeBufferPointer { buf.update(from: $0.baseAddress!, count: bytes.count) }
        return bytes.count
    }

    func keep(_ t: Transaction) {
        lock.lock(); unfinished[t.id] = t; lock.unlock()
    }

    /// A verified transaction for our product: keep it until partii says Ok.
    func deliver(_ result: VerificationResult<Transaction>) {
        guard case .verified(let t) = result, t.productID == productID else { return }
        if t.revocationDate != nil { return }
        keep(t)
        push(["kind": "purchased", "transaction": String(t.id)])
    }

    func start() {
        guard updates == nil else { return }
        // Ask to Buy approvals, purchases on other devices, and anything
        // left unfinished by an earlier launch.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates { self?.deliver(result) }
        }
        Task.detached { [weak self] in
            for await result in Transaction.unfinished { self?.deliver(result) }
        }
        // The localized price for the buy button (no price, no problem:
        // the button just says "Get the Full Game").
        Task.detached { [weak self] in
            guard let self else { return }
            if let product = try? await Product.products(for: [self.productID]).first {
                self.setPrice(product)
            }
        }
    }

    func purchase() {
        Task.detached { [weak self] in
            guard let self else { return }
            do {
                guard let product = try await Product.products(for: [self.productID]).first else {
                    self.push(["kind": "failed", "message": "The full game isn't in the App Store yet."])
                    return
                }
                self.setPrice(product)
                switch try await product.purchase() {
                case .success(let result): self.deliver(result)
                case .userCancelled: self.push(["kind": "cancelled"])
                case .pending: self.push(["kind": "pending"])
                @unknown default: self.push(["kind": "cancelled"])
                }
            } catch {
                self.push(["kind": "failed", "message": "The purchase didn't go through. Try again in a bit."])
            }
        }
    }

    func restore() {
        Task.detached { [weak self] in
            guard let self else { return }
            // Restore Purchases: sync with the App Store (may ask to sign
            // in), then report every current entitlement for our product.
            try? await AppStore.sync()
            var ids: [String] = []
            for await result in Transaction.currentEntitlements {
                if case .verified(let t) = result, t.productID == self.productID, t.revocationDate == nil {
                    self.keep(t)
                    ids.append(String(t.id))
                }
            }
            self.push(["kind": "restored", "transactions": ids])
        }
    }

    func finish(_ id: UInt64) {
        lock.lock(); let t = unfinished.removeValue(forKey: id); lock.unlock()
        guard let t else { return }
        Task.detached { await t.finish() }
    }
}

@_cdecl("bb_sk_start")
public func bb_sk_start(_ product: UnsafePointer<CChar>) {
    guard #available(iOS 15.0, *) else { return }
    Bridge.shared.productID = String(cString: product)
    Bridge.shared.start()
}

@_cdecl("bb_sk_purchase")
public func bb_sk_purchase() -> Bool {
    guard #available(iOS 15.0, *) else { return false }
    Bridge.shared.purchase()
    return true
}

@_cdecl("bb_sk_restore")
public func bb_sk_restore() -> Bool {
    guard #available(iOS 15.0, *) else { return false }
    Bridge.shared.restore()
    return true
}

@_cdecl("bb_sk_finish")
public func bb_sk_finish(_ transaction: UnsafePointer<CChar>) {
    guard #available(iOS 15.0, *), let id = UInt64(String(cString: transaction)) else { return }
    Bridge.shared.finish(id)
}

/// The full game's localized price ("$4.99") in `buf`: its length, 0 while
/// unknown, or minus the size needed when `cap` is too small.
@_cdecl("bb_sk_price")
public func bb_sk_price(_ buf: UnsafeMutablePointer<UInt8>, _ cap: Int) -> Int {
    guard #available(iOS 15.0, *) else { return 0 }
    return Bridge.shared.copyPrice(into: buf, cap: cap)
}

/// Next event as JSON in `buf`: its length, 0 for none, or minus the size
/// needed when `cap` is too small.
@_cdecl("bb_sk_poll")
public func bb_sk_poll(_ buf: UnsafeMutablePointer<UInt8>, _ cap: Int) -> Int {
    guard #available(iOS 15.0, *) else { return 0 }
    return Bridge.shared.pop(into: buf, cap: cap)
}
