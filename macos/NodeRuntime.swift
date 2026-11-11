import Foundation
import Darwin

enum NodeRuntime {
    static let requirement = "Node.js 22.x (at least 22.22.3), 24.x or 26.x"
    static let downloadURL = URL(string: "https://nodejs.org/en/download/archive/v22.23.3")!
    #if arch(arm64)
    static let architecture = "arm64"
    #else
    static let architecture = "x64"
    #endif

    struct Selection: Codable {
        let path: String
        let version: String
        let arch: String
    }
    enum Failure: Error { case unavailable }

    static func supports(version: String, arch: String) -> Bool {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              let major = Int(parts[0]), let minor = Int(parts[1]), let patch = Int(parts[2]) else { return false }
        let supported = (major == 22 && (minor > 22 || (minor == 22 && patch >= 3))) || major == 24 || major == 26
        return supported && arch == architecture
    }

    static func candidates(home: String = NSHomeDirectory()) -> [String] {
        var paths = ["/opt/homebrew/opt/node@22/bin/node", "/usr/local/opt/node@22/bin/node",
                     "/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node",
                     "/opt/homebrew/opt/node@26/bin/node", "/usr/local/opt/node@26/bin/node",
                     "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        let managers = [(".nvm/versions/node", "bin/node"),
                        (".local/share/fnm/node-versions", "installation/bin/node"),
                        (".volta/tools/image/node", "bin/node"),
                        (".local/share/mise/installs/node", "bin/node"),
                        (".asdf/installs/nodejs", "bin/node")]
        for (folder, suffix) in managers {
            let root = URL(fileURLWithPath: home).appendingPathComponent(folder)
            let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
            let versions = names.filter { supports(version: $0.hasPrefix("v") ? String($0.dropFirst()) : $0, arch: architecture) }
                .sorted { $0.localizedStandardCompare($1) == .orderedDescending }.prefix(8)
            paths += versions.map { root.appendingPathComponent($0).appendingPathComponent(suffix).path }
        }
        return paths
    }

    static func environment(home: String = NSHomeDirectory(), temporary: String = NSTemporaryDirectory()) -> [String: String] {
        // In particular, do not inherit NODE_OPTIONS/NODE_PATH or shell startup scripts.
        ["PATH":"/usr/bin:/bin:/usr/sbin:/sbin", "HOME":home, "TMPDIR":temporary, "LANG":"en_US.UTF-8"]
    }

    private final class Output {
        let lock = NSLock()
        let ended = DispatchSemaphore(value: 0)
        var data = Data()
        var overflow = false
        func append(_ chunk: Data) {
            lock.lock(); defer { lock.unlock() }
            if data.count + chunk.count > 16384 { overflow = true }
            else { data.append(chunk) }
        }
    }

    static func probe(_ path: String, timeout: TimeInterval = 2) -> Selection? {
        guard path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: path) else { return nil }
        let process = Process(), pipe = Pipe(), output = Output()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--input-type=commonjs", "-e", "const c=require('node:crypto');process.stdout.write(JSON.stringify({protocol:1,version:process.versions.node,arch:process.arch,ready:typeof fetch==='function'&&typeof WebSocket==='function'&&typeof AbortSignal.timeout==='function'&&typeof c.verify==='function'&&typeof c.createPublicKey==='function'}))"]
        process.environment = environment()
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; output.ended.signal() }
            else { output.append(chunk) }
        }
        defer {
            pipe.fileHandleForReading.readabilityHandler = nil
            try? pipe.fileHandleForReading.close()
            try? pipe.fileHandleForWriting.close()
        }
        do { try process.run() } catch { return nil }
        pipe.fileHandleForWriting.closeFile()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if process.isRunning {
            process.terminate()
            let grace = Date().addingTimeInterval(0.2)
            while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            return nil
        }
        process.waitUntilExit()
        guard output.ended.wait(timeout: .now() + 0.5) == .success, process.terminationStatus == 0 else { return nil }
        output.lock.lock(); defer { output.lock.unlock() }
        guard !output.overflow,
              let value = try? JSONSerialization.jsonObject(with: output.data) as? [String: Any],
              value["protocol"] as? Int == 1, value["ready"] as? Bool == true,
              let version = value["version"] as? String, let arch = value["arch"] as? String,
              supports(version: version, arch: arch) else { return nil }
        return Selection(path: path, version: version, arch: arch)
    }

    static func resolve(candidates paths: [String]? = nil, timeout: TimeInterval = 8) throws -> Selection {
        var seen = Set<String>()
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        for path in paths ?? candidates() {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining <= 0 { break }
            let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            guard path.hasPrefix("/"), seen.insert(canonical).inserted else { continue }
            if let selected = probe(canonical, timeout: min(2, remaining)) { return selected }
        }
        throw Failure.unavailable
    }

    static var instructions: String {
        "Install \(requirement) for \(architecture), then try again. A supported macOS installer is available at \(downloadURL.absoluteString). Other Node.js major versions are not supported by this preview."
    }
}
