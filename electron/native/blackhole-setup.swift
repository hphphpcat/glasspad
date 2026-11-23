// GlassPad macOS 原生系统音频引擎 (ScreenCaptureKit + CoreAudio 双模)
// 1. sck-stream：腾讯会议同款 ScreenCaptureKit 原生系统音频内录（48kHz 双声道 Float32 交错 PCM 从 stdout 实时输出，
//    开启 excludesCurrentProcessAudio 排除自身进程声音，无需切换系统默认输出设备，键盘音量键 100% 正常）。
// 2. setup / restore / set-volume / get-volume：CoreAudio 多输出聚合设备管理与物理扬声器硬件音量控制，
//    并在停止共享（restore）时自动将系统默认输出还原回物理扬声器，销毁临时聚合设备。

import CoreAudio
import AudioToolbox
import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

let AGG_NAME = "GlassPad 系统音"
let AGG_UID = "com.glasspad.aggregate.sysaudio"

let kAggNameKey = "name" as String
let kAggUIDKey = "uid" as String
let kAggSubDeviceListKey = "subdevices" as String
let kAggMasterSubDeviceKey = "master" as String
let kAggStackedKey = "stacked" as String
let kSubDeviceUIDKey = "uid" as String
let kSubDeviceDriftKey = "drift" as String

func readString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector,
                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(objectID, &addr, 0, nil, &size, &value)
    guard status == noErr else { return nil }
    return value?.takeUnretainedValue() as String?
}

func allAudioDevices() -> [AudioDeviceID] {
    let sysObject = AudioObjectID(kAudioObjectSystemObject)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(sysObject, &addr, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }
    var devices = [AudioDeviceID](repeating: 0, count: count)
    let status = devices.withUnsafeMutableBufferPointer { buf in
        AudioObjectGetPropertyData(sysObject, &addr, 0, nil, &size, buf.baseAddress!)
    }
    guard status == noErr else { return [] }
    return devices
}

func defaultOutputDevice() -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
    return status == noErr ? deviceID : nil
}

func defaultInputDevice() -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
    return status == noErr ? deviceID : nil
}

func hasOutputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr && size > 0
}

func hasInputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr && size > 0
}

func isVirtualAudioDevice(_ d: AudioDeviceID) -> Bool {
    let name = readString(d, kAudioObjectPropertyName) ?? ""
    let uid = readString(d, kAudioDevicePropertyDeviceUID) ?? ""
    return name.localizedCaseInsensitiveContains("Virtual")
        || name.localizedCaseInsensitiveContains("Aggregate")
        || name.localizedCaseInsensitiveContains("BlackHole")
        || name.localizedCaseInsensitiveContains("ZoomAudio")
        || name.localizedCaseInsensitiveContains("Oray")
        || name.localizedCaseInsensitiveContains("ToDesk")
        || name == AGG_NAME
        || uid == AGG_UID
        || uid.localizedCaseInsensitiveContains("aggregate")
        || uid.localizedCaseInsensitiveContains("BlackHole")
        || uid.localizedCaseInsensitiveContains("MULTIPLE")
}

func findPhysicalSpeaker() -> AudioDeviceID? {
    let devices = allAudioDevices()
    if let def = defaultOutputDevice(), hasOutputStreams(def), !isVirtualAudioDevice(def) {
        return def
    }
    if let builtin = devices.first(where: { readString($0, kAudioDevicePropertyDeviceUID) == "BuiltInSpeakerDevice" }) {
        return builtin
    }
    if let named = devices.first(where: { d in
        guard hasOutputStreams(d), !isVirtualAudioDevice(d) else { return false }
        let name = readString(d, kAudioObjectPropertyName) ?? ""
        return name.contains("扬声器") || name.localizedCaseInsensitiveContains("Speaker") || name.localizedCaseInsensitiveContains("Headphone")
    }) {
        return named
    }
    return devices.first(where: { hasOutputStreams($0) && !isVirtualAudioDevice($0) })
}

func findPhysicalMic() -> AudioDeviceID? {
    let devices = allAudioDevices()
    if let builtin = devices.first(where: { readString($0, kAudioDevicePropertyDeviceUID) == "BuiltInMicrophoneDevice" }) {
        return builtin
    }
    return devices.first(where: { hasInputStreams($0) && !isVirtualAudioDevice($0) })
}

func findAllPhysicalOutputDevices() -> [AudioDeviceID] {
    return allAudioDevices().filter { hasOutputStreams($0) && !isVirtualAudioDevice($0) }
}

func createAggregateDevice(subDevices: [[String: Any]], masterUID: String) -> AudioDeviceID? {
    let desc: [String: Any] = [
        kAggNameKey: AGG_NAME,
        kAggUIDKey: AGG_UID,
        kAggSubDeviceListKey: subDevices,
        kAggMasterSubDeviceKey: masterUID,
        kAggStackedKey: 1,
    ]
    var deviceID = AudioDeviceID(0)
    let status = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &deviceID)
    return status == noErr ? deviceID : nil
}

func setDefaultOutputDevice(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var newID = deviceID
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
        UInt32(MemoryLayout<AudioDeviceID>.size), &newID)
    return status == noErr
}

func setDefaultInputDevice(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var newID = deviceID
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
        UInt32(MemoryLayout<AudioDeviceID>.size), &newID)
    return status == noErr
}

// 确保系统默认输入设备是物理麦克风（防止系统或其他软件把 BlackHole 或聚合设备当成默认麦克风，导致扬声器声音被作为 Input 再输入一遍）
func ensureDefaultInputIsPhysicalMic() {
    if let curIn = defaultInputDevice(), isVirtualAudioDevice(curIn) {
        if let mic = findPhysicalMic() {
            _ = setDefaultInputDevice(mic)
        }
    }
}

func outputChannelCount(_ deviceID: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    var buf = [UInt8](repeating: 0, count: Int(size))
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &buf) == noErr else { return 0 }
    return buf.withUnsafeBytes { raw -> Int in
        let list = raw.load(as: AudioBufferList.self)
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: raw.baseAddress!.assumingMemoryBound(to: AudioBufferList.self)))
        var total = 0
        for i in 0..<Int(list.mNumberBuffers) {
            total += Int(abl[i].mNumberChannels)
        }
        return total
    }
}

func setDeviceVolumeScalar(_ dev: AudioDeviceID, _ percent: Float) -> Bool {
    let scalar = max(0, min(1, percent / 100))
    let shouldMute: UInt32 = percent <= 0.5 ? 1 : 0
    let chans = outputChannelCount(dev)
    var anyOK = false

    for ch in 0...max(1, chans) {
        var muteAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: UInt32(ch))
        if AudioObjectHasProperty(dev, &muteAddr) {
            var m = shouldMute
            _ = AudioObjectSetPropertyData(dev, &muteAddr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &m)
        }
    }

    for ch in 0...max(2, chans) {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: UInt32(ch))
        if AudioObjectHasProperty(dev, &addr) {
            var value: Float32 = scalar
            if AudioObjectSetPropertyData(dev, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &value) == noErr {
                anyOK = true
            }
        }
    }
    return anyOK
}

func setSpeakerVolume(_ percent: Float) -> [String: Any] {
    ensureDefaultInputIsPhysicalMic()
    let targets = findAllPhysicalOutputDevices()
    guard !targets.isEmpty else {
        return ["ok": false, "error": "未找到扬声器设备"]
    }
    var anyOK = false
    for dev in targets {
        if setDeviceVolumeScalar(dev, percent) {
            anyOK = true
        }
    }
    for d in allAudioDevices() where (readString(d, kAudioObjectPropertyName) ?? "").localizedCaseInsensitiveContains("BlackHole") {
        _ = setDeviceVolumeScalar(d, 100)
    }
    return anyOK ? ["ok": true, "volume": Int(percent)] : ["ok": false, "error": "设置扬声器音量失败"]
}

func getSpeakerVolume() -> [String: Any] {
    guard let spk = findPhysicalSpeaker() else {
        return ["ok": false, "error": "未找到扬声器设备"]
    }
    var muteAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)
    var muted: UInt32 = 0
    var mSize = UInt32(MemoryLayout<UInt32>.size)
    if AudioObjectHasProperty(spk, &muteAddr),
       AudioObjectGetPropertyData(spk, &muteAddr, 0, nil, &mSize, &muted) == noErr,
       muted != 0 {
        return ["ok": true, "volume": 0]
    }
    for el: UInt32 in [0, 1, 2] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: el)
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        if AudioObjectHasProperty(spk, &addr),
           AudioObjectGetPropertyData(spk, &addr, 0, nil, &size, &value) == noErr {
            return ["ok": true, "volume": Int(round(value * 100))]
        }
    }
    return ["ok": false, "error": "读取扬声器音量失败"]
}

// 还原系统默认输出到物理扬声器并销毁「GlassPad 系统音」聚合设备（恢复系统原生键盘音量加减键控制）
func runRestore() -> [String: Any] {
    ensureDefaultInputIsPhysicalMic()
    var restoredName = ""
    if let spk = findPhysicalSpeaker() {
        _ = setDefaultOutputDevice(spk)
        restoredName = readString(spk, kAudioObjectPropertyName) ?? "BuiltInSpeakerDevice"
    }
    for d in allAudioDevices() where readString(d, kAudioObjectPropertyName) == AGG_NAME {
        AudioHardwareDestroyAggregateDevice(d)
    }
    let vol = (getSpeakerVolume()["volume"] as? Int) ?? 35
    return ["ok": true, "restoredOutput": restoredName, "volume": vol]
}

func runSetup() -> [String: Any] {
    ensureDefaultInputIsPhysicalMic()
    guard let blackhole = allAudioDevices().first(where: {
        (readString($0, kAudioObjectPropertyName) ?? "").localizedCaseInsensitiveContains("BlackHole")
    }) else {
        return ["ok": false, "error": "未检测到 BlackHole，请先安装"]
    }
    guard let blackholeUID = readString(blackhole, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "无法读取 BlackHole 设备 UID"]
    }

    guard let spk = findPhysicalSpeaker(), spk != blackhole,
          let spkUID = readString(spk, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "未找到可用的扬声器输出设备"]
    }

    if let old = allAudioDevices().first(where: { readString($0, kAudioObjectPropertyName) == AGG_NAME }) {
        AudioHardwareDestroyAggregateDevice(old)
        Thread.sleep(forTimeInterval: 0.4)
    }

    let subDevices: [[String: Any]] = [
        [kSubDeviceUIDKey: spkUID, kSubDeviceDriftKey: 0],
        [kSubDeviceUIDKey: blackholeUID, kSubDeviceDriftKey: 1],
    ]

    guard let aggID = createAggregateDevice(subDevices: subDevices, masterUID: spkUID) else {
        return ["ok": false, "error": "创建多输出设备失败"]
    }
    let setOK = setDefaultOutputDevice(aggID)
    ensureDefaultInputIsPhysicalMic()
    if let cur = getSpeakerVolume()["volume"] as? Int, cur > 45 || cur == 0 {
        _ = setSpeakerVolume(35)
    } else {
        _ = setDeviceVolumeScalar(blackhole, 100)
    }
    let finalVol = (getSpeakerVolume()["volume"] as? Int) ?? 35
    return ["ok": true, "outputDevice": AGG_NAME, "created": true, "defaultSet": setOK, "volume": finalVol]
}

// ── 腾讯会议同款：ScreenCaptureKit 原生系统音频内录流（48kHz 双声道交错 Float32 PCM）──
class SCKSystemAudioStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        let numFrames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numFrames > 0 else { return }

        var ablSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &ablSize, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil
        )
        guard ablSize > 0 else { return }
        let rawPtr = UnsafeMutableRawPointer.allocate(byteCount: ablSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawPtr.deallocate() }
        let ablPtr = rawPtr.bindMemory(to: AudioBufferList.self, capacity: 1)
        var blockBuf: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: ablPtr, bufferListSize: ablSize,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuf
        )
        guard status == noErr else { return }
        let abl = UnsafeMutableAudioBufferListPointer(ablPtr)

        var interleaved = [Float](repeating: 0, count: numFrames * 2)
        if abl.count >= 2,
           let lPtr = abl[0].mData?.assumingMemoryBound(to: Float.self),
           let rPtr = abl[1].mData?.assumingMemoryBound(to: Float.self) {
            for i in 0..<numFrames {
                interleaved[i * 2] = lPtr[i]
                interleaved[i * 2 + 1] = rPtr[i]
            }
        } else if abl.count == 1, let p = abl[0].mData?.assumingMemoryBound(to: Float.self) {
            let totalFloats = Int(abl[0].mDataByteSize) / MemoryLayout<Float>.size
            if totalFloats == numFrames * 2 {
                for i in 0..<(numFrames * 2) { interleaved[i] = p[i] }
            } else {
                for i in 0..<min(numFrames, totalFloats) {
                    interleaved[i * 2] = p[i]
                    interleaved[i * 2 + 1] = p[i]
                }
            }
        }

        interleaved.withUnsafeBufferPointer { buf in
            if let base = buf.baseAddress {
                let data = Data(bytes: base, count: buf.count * MemoryLayout<Float>.size)
                FileHandle.standardOutput.write(data)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("SCK_ERROR:\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

var globalSCKStream: SCStream?
let sckStreamer = SCKSystemAudioStreamer()

func runSCKAudioStream(excludePID: pid_t?) -> Never {
    // 启动原生 ScreenCaptureKit 内录前，先把系统默认输出还原回物理扬声器（让系统音量键正常可用）
    _ = runRestore()

    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, err in
        guard let content = content, let display = content.displays.first else {
            fputs("SCK_NO_DISPLAY:\(err?.localizedDescription ?? "denied")\n", stderr)
            exit(2)
        }
        var excludedApps: [SCRunningApplication] = []
        if let pid = excludePID, pid > 0 {
            excludedApps = content.applications.filter { $0.processID == pid }
        }
        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true

        do {
            let stream = SCStream(filter: filter, configuration: config, delegate: sckStreamer)
            try stream.addStreamOutput(sckStreamer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "com.glasspad.sck.audio"))
            stream.startCapture { startErr in
                if let startErr = startErr {
                    fputs("SCK_START_ERR:\(startErr.localizedDescription)\n", stderr)
                    exit(3)
                }
                fputs("SCK_READY\n", stderr)
            }
            globalSCKStream = stream
        } catch {
            fputs("SCK_INIT_ERR:\(error.localizedDescription)\n", stderr)
            exit(4)
        }
    }
    RunLoop.main.run()
    exit(0)
}

let args = CommandLine.arguments
func emitResult(_ result: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"error\":\"序列化结果失败\"}")
    }
    exit(0)
}

if args.count > 1 {
    switch args[1] {
    case "sck-stream":
        let pid: pid_t? = args.count > 2 ? Int32(args[2]) : nil
        runSCKAudioStream(excludePID: pid)
    case "setup":
        emitResult(runSetup())
    case "restore":
        emitResult(runRestore())
    case "set-volume":
        let pct = args.count > 2 ? (Float(args[2]) ?? 35) : 35
        emitResult(setSpeakerVolume(pct))
    case "get-volume":
        emitResult(getSpeakerVolume())
    default:
        emitResult(["ok": false, "error": "未知命令"])
    }
}

emitResult(["ok": false, "error": "未知命令"])
