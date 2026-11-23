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
let kAggStackedKey = "stacked" as String
let kSubDeviceUIDKey = "uid" as String
let kSubDeviceDriftKey = "drift" as String

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

// 挑选物理扬声器（关键：必须在销毁旧聚合设备之前调用，且明确排除 BlackHole / 聚合设备 / 虚拟设备，
// 否则默认输出可能指向被销毁的旧聚合设备，导致把「聚合设备自己」当扬声器塞进去，扬声器被丢出链路、学生听不到声音）
func findPhysicalSpeaker() -> AudioDeviceID? {
    let devices = allAudioDevices()
    // 1. Mac 内置扬声器的标准 UID，最可靠
    if let builtin = devices.first(where: { readString($0, kAudioDevicePropertyDeviceUID) == "BuiltInSpeakerDevice" }) {
        return builtin
    }
    // 2. 名字含「扬声器 / Speaker」，且排除虚拟设备、聚合设备、BlackHole 本身
    return devices.first(where: { d in
        guard hasOutputStreams(d) else { return false }
        let name = readString(d, kAudioObjectPropertyName) ?? ""
        let uid = readString(d, kAudioDevicePropertyDeviceUID) ?? ""
        let isVirtual = name.localizedCaseInsensitiveContains("Virtual")
            || name.localizedCaseInsensitiveContains("Aggregate")
            || name.localizedCaseInsensitiveContains("BlackHole")
            || name == AGG_NAME
            || uid == AGG_UID
            || uid.localizedCaseInsensitiveContains("aggregate")
            || uid.localizedCaseInsensitiveContains("BlackHole")
        let looksSpeaker = name.contains("扬声器") || name.localizedCaseInsensitiveContains("Speaker")
        return looksSpeaker && !isVirtual
    })
}

// 创建 Aggregate Device（镜像模式：所有子设备喂相同数据，扬声器 + BlackHole 同时出声）
func createAggregateDevice(subDevices: [[String: Any]], masterUID: String) -> AudioDeviceID? {
    let desc: [String: Any] = [
        kAggNameKey: AGG_NAME,
        kAggUIDKey: AGG_UID,
        kAggSubDeviceListKey: subDevices,
        kAggMasterSubDeviceKey: masterUID,
        // stacked = 1：多输出设备的实际镜像模式（参考系统 ToDesk 多输出设备 composition）
        kAggStackedKey: 1,
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
    // 1. 找 BlackHole（名字含 BlackHole）
    guard let blackhole = allAudioDevices().first(where: {
        (readString($0, kAudioObjectPropertyName) ?? "").localizedCaseInsensitiveContains("BlackHole")
    }) else {
        return ["ok": false, "error": "未检测到 BlackHole，请先安装"]
    }
    guard let blackholeUID = readString(blackhole, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "无法读取 BlackHole 设备 UID"]
    }

    // 2. 先确定物理扬声器（必须在销毁旧聚合设备之前，避免默认输出指向旧聚合设备导致套娃）
    guard let spk = findPhysicalSpeaker(), spk != blackhole,
          let spkUID = readString(spk, kAudioDevicePropertyDeviceUID) else {
        return ["ok": false, "error": "未找到可用的扬声器输出设备"]
    }

    // 3. 若已存在旧的「GlassPad 系统音」（可能是早期非镜像版本或套娃版本），先销毁
    if let old = allAudioDevices().first(where: { readString($0, kAudioObjectPropertyName) == AGG_NAME }) {
        AudioHardwareDestroyAggregateDevice(old)
        // 销毁是异步的，稍等系统清理，避免创建同名/同 UID 设备冲突
        Thread.sleep(forTimeInterval: 0.5)
    }

    // 4. 创建 Aggregate（扬声器 + BlackHole，镜像模式）。
    //    官方要求：内置扬声器必须排第一位、作为时钟源（master）；BlackHole 作为非时钟源设备
    //    必须开启 Drift Correction（drift=1）跟随扬声器的硬件时钟，否则收不到镜像数据
    let subDevices: [[String: Any]] = [
        [kSubDeviceUIDKey: spkUID, kSubDeviceDriftKey: 0],       // 扬声器：时钟源，不开启 drift
        [kSubDeviceUIDKey: blackholeUID, kSubDeviceDriftKey: 1], // BlackHole：跟随时钟源，开启 drift correction
    ]

    guard let aggID = createAggregateDevice(subDevices: subDevices, masterUID: spkUID) else {
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
