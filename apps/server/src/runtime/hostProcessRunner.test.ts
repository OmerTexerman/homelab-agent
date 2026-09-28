import { describe, expect, it } from "@effect/vitest";

import { isWindowsCommandNotFoundSync, runProcess } from "./hostProcessRunner.ts";

describe("runProcess (promise API)", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
        maxBufferBytes: 128,
      }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });
});

describe("isWindowsCommandNotFoundSync", () => {
  it("matches localized cmd.exe command-not-found text", () => {
    // eslint-disable-next-line t3code/no-global-process-runtime -- fork legacy host-platform read; migrate to HostProcessPlatform in a follow-up
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      expect(
        isWindowsCommandNotFoundSync(
          1,
          "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
        ),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
