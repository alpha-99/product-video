import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
  buildThumbnailArgs,
  extractThumbnail,
  readJpegSize,
  resolveFfmpeg,
  resolveSeekSecond,
} from "../src/lib/thumbnail";

let TEST_ROOT: string;

before(async () => {
  TEST_ROOT = await mkdtemp(path.join(os.tmpdir(), "pv-thumb-test-"));
});

after(async () => {
  if (TEST_ROOT) await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("缩略图截帧参数（方案 7.2）", () => {
  it("截帧时间点取时长 20%，且不超过末尾，避免序幕/片尾", () => {
    assert.equal(resolveSeekSecond(15), 3);
    assert.equal(resolveSeekSecond(20), 4);
    assert.equal(resolveSeekSecond(0.3), 0.06);
    assert.equal(resolveSeekSecond(-1), 0);
  });

  it("截帧参数固定且可复现：单帧、等比缩放、JPEG、覆盖写入", () => {
    const args = buildThumbnailArgs({
      videoPath: "/data/a.mp4",
      outputPath: "/data/b.jpg",
      seekSecond: 3,
    });
    assert.deepEqual(args, [
      "-y", "-ss", "3.00", "-i", "/data/a.mp4",
      "-frames:v", "1", "-vf", `scale=${THUMBNAIL_WIDTH}:-2`,
      "-q:v", String(THUMBNAIL_QUALITY), "-update", "1", "/data/b.jpg",
    ]);
  });

  it("拒绝非法宽度、时间与质量", () => {
    const base = { videoPath: "a", outputPath: "b", seekSecond: 1 };
    assert.throws(() => buildThumbnailArgs({ ...base, width: 0 }), /非法缩略图宽度/);
    assert.throws(() => buildThumbnailArgs({ ...base, width: 10.5 }), /非法缩略图宽度/);
    assert.throws(() => buildThumbnailArgs({ ...base, seekSecond: -1 }), /非法截帧时间/);
    assert.throws(() => buildThumbnailArgs({ ...base, quality: 1 }), /非法 JPEG 质量/);
    assert.throws(() => buildThumbnailArgs({ ...base, quality: 32 }), /非法 JPEG 质量/);
  });
});

describe("FFmpeg 解析与 JPEG 尺寸读取", () => {
  it("默认解析到 Remotion 内置 FFmpeg，FFMPEG_PATH 可覆盖", () => {
    const original = process.env.FFMPEG_PATH;
    try {
      delete process.env.FFMPEG_PATH;
      const resolved = resolveFfmpeg();
      assert.match(resolved.binary, /ffmpeg(\.exe)?$/i);

      process.env.FFMPEG_PATH = "/custom/ffmpeg";
      assert.equal(resolveFfmpeg().binary, "/custom/ffmpeg");
    } finally {
      if (original === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = original;
    }
  });

  it("从最小合法 JPEG 结构与非法输入读取尺寸", () => {
    // SOF0 + 1x1 像素的最小 JPEG 头（仅用于解析宽高，不需要完整图像数据）。
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x02, // height = 2
      0x00, 0x03, // width = 3
      0x00, 0xff, 0xd9,
    ]);
    assert.deepEqual(readJpegSize(jpeg), { width: 3, height: 2 });
    assert.equal(readJpegSize(Buffer.from("not a jpeg")), null);
  });
});

describe("真机截帧（Remotion 内置 FFmpeg）", () => {
  it("从真实 MP4 截帧生成合法 JPEG，尺寸等比缩放", { timeout: 120_000 }, async () => {
    const sampleVideo = "C:/Users/Administrator/AppData/Local/Temp/pv-launch.mp4";
    const output = path.join(TEST_ROOT, "thumb.jpg");

    try {
      await readFile(sampleVideo);
    } catch {
      // 样本视频不存在时跳过，本测试依赖前一阶段出片验证的样本。
      return;
    }

    const result = await extractThumbnail({
      videoPath: sampleVideo,
      outputPath: output,
      durationSec: 15,
    });

    assert.equal(result.outputPath, output);
    assert.ok(result.bytes > 1000, `缩略图过小: ${result.bytes}`);
    assert.equal(result.width, THUMBNAIL_WIDTH);
    assert.equal(result.height, Math.round((THUMBNAIL_WIDTH * 16) / 9 / 2) * 2); // 9:16 → 640

    const bytes = await readFile(output);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.deepEqual(readJpegSize(bytes), { width: result.width, height: result.height });
  });

  it("视频不存在时抛出异常，供调用方降级", async () => {
    await assert.rejects(
      extractThumbnail({
        videoPath: path.join(TEST_ROOT, "missing.mp4"),
        outputPath: path.join(TEST_ROOT, "never.jpg"),
        durationSec: 15,
      }),
      /No such file|没有那个文件|Invalid data|Error/i
    );
  });
});
