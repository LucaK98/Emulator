/*
 * The platform layer melonDS expects from its frontend.
 *
 * A browser has no files, no threads worth using here, no local network and no
 * camera, so most of this is deliberately inert. What matters is that the parts
 * the core actually depends on behave correctly:
 *
 *   * timing, which the core reads for its own scheduling;
 *   * mutexes and semaphores, which exist because melonDS's threaded software
 *     renderer expects them — this build never enables it, so trivial
 *     single-threaded implementations are correct rather than merely
 *     convenient;
 *   * save writes, which are ignored here because the wrapper reads the
 *     cartridge's save memory directly when it wants to persist it.
 *
 * File access returns nothing. With melonDS's built-in free BIOS and generated
 * firmware, no external file is ever needed.
 */

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <string>

#include "Platform.h"

namespace melonDS::Platform {

/* --- Files -------------------------------------------------------------- */

std::string InstanceFileSuffix() { return ""; }

FileHandle *OpenFile(const std::string &, FileMode) { return nullptr; }
FileHandle *OpenLocalFile(const std::string &, FileMode) { return nullptr; }

std::string GetLocalFilePath(const std::string &filename) { return filename; }

bool FileExists(const std::string &) { return false; }
bool LocalFileExists(const std::string &) { return false; }
bool CheckFileWritable(const std::string &) { return false; }
bool CheckLocalFileWritable(const std::string &) { return false; }

bool CloseFile(FileHandle *) { return true; }
bool IsEndOfFile(FileHandle *) { return true; }
bool FileReadLine(char *, int, FileHandle *) { return false; }
bool FileSeek(FileHandle *, s64, FileSeekOrigin) { return false; }
void FileRewind(FileHandle *) {}
u64 FileRead(void *, u64, u64, FileHandle *) { return 0; }
bool FileFlush(FileHandle *) { return true; }
u64 FileWrite(const void *, u64, u64, FileHandle *) { return 0; }
u64 FileWriteFormatted(FileHandle *, const char *, ...) { return 0; }
u64 FileLength(FileHandle *) { return 0; }

/* --- Logging ------------------------------------------------------------ */

/*
 * Dropped. A commercial cartridge produces a steady stream of notices about
 * unimplemented corners of the hardware; in a worker that only floods the
 * console, and none of it is actionable from here.
 */
void Log(LogLevel, const char *, ...) {}

/* --- Threads ------------------------------------------------------------ */

/*
 * This build is single threaded: melonDS only spawns threads for its optional
 * threaded software renderer, which is not enabled. Creating a thread would be
 * a bug, so it is refused rather than faked.
 */
Thread *Thread_Create(std::function<void()>) { return nullptr; }
void Thread_Free(Thread *) {}
void Thread_Wait(Thread *) {}

/*
 * Mutexes and semaphores are still constructed by code paths that run
 * single threaded. With no concurrency there is nothing to guard, so these are
 * counted stubs: correct here, and cheap.
 */
namespace {
struct StubSemaphore {
    int count = 0;
};
struct StubMutex {
    bool locked = false;
};
} // namespace

Semaphore *Semaphore_Create() { return reinterpret_cast<Semaphore *>(new StubSemaphore()); }
void Semaphore_Free(Semaphore *sema) { delete reinterpret_cast<StubSemaphore *>(sema); }
void Semaphore_Reset(Semaphore *sema) { reinterpret_cast<StubSemaphore *>(sema)->count = 0; }

void Semaphore_Wait(Semaphore *sema)
{
    auto *stub = reinterpret_cast<StubSemaphore *>(sema);
    if (stub->count > 0) stub->count--;
}

bool Semaphore_TryWait(Semaphore *sema, int)
{
    auto *stub = reinterpret_cast<StubSemaphore *>(sema);
    if (stub->count <= 0) return false;
    stub->count--;
    return true;
}

void Semaphore_Post(Semaphore *sema, int count)
{
    reinterpret_cast<StubSemaphore *>(sema)->count += count;
}

Mutex *Mutex_Create() { return reinterpret_cast<Mutex *>(new StubMutex()); }
void Mutex_Free(Mutex *mutex) { delete reinterpret_cast<StubMutex *>(mutex); }
void Mutex_Lock(Mutex *mutex) { reinterpret_cast<StubMutex *>(mutex)->locked = true; }
void Mutex_Unlock(Mutex *mutex) { reinterpret_cast<StubMutex *>(mutex)->locked = false; }

bool Mutex_TryLock(Mutex *mutex)
{
    auto *stub = reinterpret_cast<StubMutex *>(mutex);
    if (stub->locked) return false;
    stub->locked = true;
    return true;
}

/** Nothing else can make progress while we wait, so this must not block. */
void Sleep(u64) {}

/* --- Time --------------------------------------------------------------- */

u64 GetMSCount()
{
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

u64 GetUSCount()
{
    using namespace std::chrono;
    return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

/* --- Persistence -------------------------------------------------------- */

/*
 * Ignored on purpose. The wrapper reads the cartridge's save memory when it
 * decides to persist it, rather than mirroring every write as it happens.
 */
void WriteNDSSave(const u8 *, u32, u32, u32, void *) {}
void WriteGBASave(const u8 *, u32, u32, u32, void *) {}
void WriteFirmware(const Firmware &, u32, u32, void *) {}
void WriteDateTime(int, int, int, int, int, int, void *) {}

/* --- Things a browser does not have ------------------------------------- */

void SignalStop(StopReason, void *) {}

void MP_Begin(void *) {}
void MP_End(void *) {}
int MP_SendPacket(u8 *, int, u64, void *) { return 0; }
int MP_RecvPacket(u8 *, u64 *, void *) { return 0; }
int MP_SendCmd(u8 *, int, u64, void *) { return 0; }
int MP_SendReply(u8 *, int, u64, u16, void *) { return 0; }
int MP_SendAck(u8 *, int, u64, void *) { return 0; }
int MP_RecvHostPacket(u8 *, u64 *, void *) { return 0; }
u16 MP_RecvReplies(u8 *, u64, u16, void *) { return 0; }

int Net_SendPacket(u8 *, int, void *) { return 0; }
int Net_RecvPacket(u8 *, void *) { return 0; }

void Camera_Start(int, void *) {}
void Camera_Stop(int, void *) {}
void Camera_CaptureFrame(int, u32 *, int, int, bool, void *) {}

void Addon_RumbleStart(u32, void *) {}
void Addon_RumbleStop(void *) {}

DynamicLibrary *DynamicLibrary_Load(const char *) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary *) {}
void *DynamicLibrary_LoadFunction(DynamicLibrary *, const char *) { return nullptr; }

} // namespace melonDS::Platform
