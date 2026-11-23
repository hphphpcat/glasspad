// GlassPad macOS 系统音内录配置 helper
// 用途：一键创建/复用「GlassPad 系统音」多输出设备（扬声器 + BlackHole 2ch），并设为系统默认输出。
// 原理：BlackHole 是环回虚拟声卡，系统音写入其输出后会回环到其输入，Electron 用 getUserMedia 采其输入即为无损系统音。
// 用法：blackhole-setup setup  →  输出 JSON { ok, outputDevice, reused|created, error? }

import CoreAudio
import Foundation

let AGG_NAME = "GlassPad 系统音"
let AGG_UID = "com.glasspad.aggregate.sysaudio"

// Aggregate Device 描述字典的私有 key（CoreAudio 未导出符号，用 CFString 字面量）
let kAggNameKey = "name" as String
let kAggUIDKey = "uid" as String
let kAggSubDeviceListKey = "subdevices" as String
let kAggMasterSubDeviceKey = "master" as String
let kSubDeviceUIDKey = "uid" as String

// 读取某个 AudioObject 的字符串属性（CFString，get rule）
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

// 枚举系统全部音频设备
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

// 当前系统默认输出设备
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

// 设备是否具备输出流（用于挑选扬声器）
func hasOutputStreams(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr && size > 0
}

// 创建 Aggregate Device
func createAggregateDevice(subDeviceUIDs: [String], masterUID: String) -> AudioDeviceID? {
    let subDevices: [[String: Any]] = subDeviceUIDs.map { [kSubDeviceUIDKey: $0] }
    let desc: [String: Any] = [
        kAggNameKey: AGG_NAME,
        kAggUIDKey: AGG_UID,
        kAggSubDeviceListKey: subDevices,
        kAggMasterSubDeviceKey: masterUID,
    ]
    var deviceID = AudioDeviceID(0)
    let status = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &deviceID)
    return status == noErr ? deviceID : nil
}

// 设置系统默认输出设备
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

func runSetup() -> [String: Any] {
    let devices = allAudioDevices()

    // 1. 找 BlackHole（名字含 BlackHole）
    guard let blackhole = devices.first(where: {
        (readString($0, kAudioObjectPropertyName) ?? "").localizedCaseInsensitiveContains("BlackHole")
    }) else {
        return ["ok": false, "error": "未检测到 BlackHole，请先安装"]
    }
    guard let blackholeUID = readString(blackhole, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "无法读取 BlackHole 设备 UID"]
    }

    // 2. 已存在「GlassPad 系统音」则复用并设为默认
    if let existing = devices.first(where: { readString($0, kAudioObjectPropertyName) == AGG_NAME }) {
        let setOK = setDefaultOutputDevice(existing)
        return ["ok": true, "outputDevice": AGG_NAME, "reused": true, "defaultSet": setOK]
    }

    // 3. 挑选扬声器：默认输出（非 BlackHole）优先，否则第一个有输出流且非 BlackHole 的设备
    var speaker: AudioDeviceID?
    if let def = defaultOutputDevice(), def != blackhole {
        speaker = def
    } else {
        speaker = devices.first(where: { $0 != blackhole && hasOutputStreams($0) })
    }
    guard let spk = speaker, let spkUID = readString(spk, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "未找到可用的扬声器输出设备"]
    }

    // 4. 创建 Aggregate（扬声器 + BlackHole），master 用扬声器保证时钟稳定
    var subUIDs = [spkUID]
    if !subUIDs.contains(blackholeUID) { subUIDs.append(blackholeUID) }

    guard let aggID = createAggregateDevice(subDeviceUIDs: subUIDs, masterUID: spkUID) else {
        return ["ok": false, "error": "创建多输出设备失败"]
    }
    let setOK = setDefaultOutputDevice(aggID)
    return ["ok": true, "outputDevice": AGG_NAME, "created": true, "defaultSet": setOK]
}

// 业务结果统一 JSON 输出 + exit 0；仅在进程崩溃时才非 0，便于主进程用 stderr 兜底
let args = CommandLine.arguments
if args.count > 1 && args[1] == "setup" {
    let result = runSetup()
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"error\":\"序列化结果失败\"}")
    }
    exit(0)
}

print("{\"ok\":false,\"error\":\"未知命令\"}")
exit(0)
