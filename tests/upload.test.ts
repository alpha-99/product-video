import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
  ALLOWED_IMAGE_TYPES,
  extensionFromFilename,
  isOwnedUploadPath,
  sniffImageMime,
  UploadValidationError,
  validateImageUpload,
} from "../src/lib/upload";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const TEST_ROOT = path.join(os.tmpdir(), `pv-upload-test-${Date.now()}`);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from("VP8 ", "ascii"),
]);

let storage: typeof import("../src/lib/storage");
let uploadRoute: typeof import("../src/app/api/uploads/products/route");

before(async () => {
  process.env.STORAGE_ROOT = TEST_ROOT;
  // storage / route 在模块加载时读取 STORAGE_ROOT，必须先设置环境再导入。
  storage = await import("../src/lib/storage");
  uploadRoute = await import("../src/app/api/uploads/products/route");
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("上传校验（方案 9.3）", () => {
  it("PNG/JPEG/WebP 三类文件头能被正确识别", () => {
    assert.equal(sniffImageMime(PNG), "image/png");
    assert.equal(sniffImageMime(JPEG), "image/jpeg");
    assert.equal(sniffImageMime(WEBP), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("<html></html>")), undefined);
  });

  it("扩展名白名单：大小写归一，路径与非法后缀被拒绝", () => {
    assert.equal(extensionFromFilename("../../Photo.PNG"), "png");
    assert.equal(extensionFromFilename("C:\\tmp\\a.jpeg"), "jpeg");
    assert.equal(extensionFromFilename("a.svg"), undefined);
    assert.equal(extensionFromFilename("a.exe"), undefined);
    assert.equal(extensionFromFilename("no-extension"), undefined);
  });

  it("合法上传返回 UUID 新文件名，不含原文件名与路径片段", () => {
    const result = validateImageUpload({
      bytes: PNG,
      mimeType: "image/png; charset=binary",
      filename: "../../secret-品牌.png",
    });
    assert.equal(result.extension, "png");
    assert.equal(result.mimeType, ALLOWED_IMAGE_TYPES.png);
    assert.match(result.storedName, /^[0-9a-f-]{36}\.png$/i);
    assert.doesNotMatch(result.storedName, /secret|品牌|\.\./);
  });

  it("空文件、超 10MB、扩展名/MIME/文件头不一致均被拒绝", () => {
    assert.throws(
      () => validateImageUpload({ bytes: Buffer.alloc(0), mimeType: "image/png", filename: "a.png" }),
      UploadValidationError
    );
    assert.throws(
      () =>
        validateImageUpload({
          bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
          mimeType: "image/png",
          filename: "a.png",
        }),
      /不能超过 10MB/
    );
    assert.throws(
      () => validateImageUpload({ bytes: PNG, mimeType: "image/jpeg", filename: "a.png" }),
      /扩展名不一致/
    );
    assert.throws(
      () => validateImageUpload({ bytes: JPEG, mimeType: "image/png", filename: "a.png" }),
      /内容.*不一致/
    );
    assert.throws(
      () => validateImageUpload({ bytes: PNG, mimeType: "image/png", filename: "a.gif" }),
      /仅支持/
    );
  });

  it("读取路径必须属于当前用户", () => {
    const own = storage.uploadRelativePath(USER_ID, "draft", "a.png");
    assert.equal(isOwnedUploadPath(own, USER_ID), true);
    assert.equal(isOwnedUploadPath(own, "00000000-0000-4000-8000-000000000099"), false);
    assert.equal(isOwnedUploadPath("uploads/" + USER_ID + "/../other/a.png", USER_ID), false);
  });
});

describe("FileStorage 抽象（方案 9.2）", () => {
  it("save/read/exists/delete/getSignedPath 全链路", async () => {
    assert.equal(storage.DATA_ROOT, TEST_ROOT);
    const local = new storage.LocalFileStorage();
    const relative = storage.uploadRelativePath(USER_ID, "draft", "storage.png");
    assert.equal(await local.exists(relative), false);
    assert.equal(await local.save(PNG, relative), relative);
    assert.equal(await local.exists(relative), true);
    assert.deepEqual(await local.read(relative), PNG);
    assert.equal(local.getSignedPath(relative), relative);
    await local.delete(relative);
    assert.equal(await local.exists(relative), false);
  });

  it("所有路径由服务端构造，拒绝绝对路径与 .. 穿越", async () => {
    const local = new storage.LocalFileStorage();
    assert.throws(() => local.getSignedPath("/etc/passwd"), /非法相对路径/);
    assert.throws(() => local.getSignedPath("uploads/../secret"), /非法相对路径/);
    assert.throws(() => storage.uploadRelativePath(USER_ID, "../escape", "a.png"), /非法路径片段/);
    assert.throws(() => storage.videoRelativePath(USER_ID, "a/b"), /非法路径片段/);
    assert.equal(
      storage.videoRelativePath(USER_ID, "job-1"),
      `videos/${USER_ID}/job-1.mp4`
    );
    assert.equal(
      storage.thumbnailRelativePath(USER_ID, "job-1"),
      `thumbnails/${USER_ID}/job-1.jpg`
    );
    assert.equal(storage.renderRelativeDir("job-1"), "renders/job-1");
  });
});

describe("上传 API 冒烟（鉴权 + 校验 + 落盘）", () => {
  const auth = { "x-dev-user-id": USER_ID };
  const url = "http://localhost/api/uploads/products";

  function postFile(bytes: Buffer, type: string, name: string, headers: Record<string, string> = auth) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
    return new NextRequest(url, { method: "POST", headers, body: form });
  }

  it("未鉴权 401；合法上传 201 且落盘到 uploads/{userId}/draft", async () => {
    assert.equal((await uploadRoute.POST(postFile(PNG, "image/png", "a.png", {}))).status, 401);

    const res = await uploadRoute.POST(postFile(PNG, "image/png", "../../brand.png"));
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: { path: string; mimeType: string; size: number } };
    assert.match(body.data.path, new RegExp(`^uploads/${USER_ID}/draft/[0-9a-f-]{36}\\.png$`));
    assert.equal(body.data.mimeType, "image/png");
    assert.equal(body.data.size, PNG.length);
    assert.doesNotMatch(body.data.path, /brand|\.\./);
    assert.equal(await storage.fileStorage.exists(body.data.path), true);
  });

  it("伪造文件头 400 并返回 fields.file；缺少 file 字段 400", async () => {
    const fake = await uploadRoute.POST(postFile(Buffer.from("<script>"), "image/png", "a.png"));
    assert.equal(fake.status, 400);
    const fakeBody = (await fake.json()) as { error: { fields?: Record<string, string> } };
    assert.ok(fakeBody.error.fields?.file);

    const empty = new NextRequest(url, { method: "POST", headers: auth, body: new FormData() });
    assert.equal((await uploadRoute.POST(empty)).status, 400);
  });

  it("鉴权读取：本人 200 + nosniff，跨用户 404，无鉴权 401", async () => {
    const created = await uploadRoute.POST(postFile(PNG, "image/png", "view.png"));
    const { data } = (await created.json()) as { data: { path: string } };
    const readUrl = `${url}?path=${encodeURIComponent(data.path)}`;

    const own = await uploadRoute.GET(new NextRequest(readUrl, { headers: auth }));
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "image/png");
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG);

    const other = await uploadRoute.GET(
      new NextRequest(readUrl, { headers: { "x-dev-user-id": "00000000-0000-4000-8000-000000000099" } })
    );
    assert.equal(other.status, 404);
    assert.equal(
      (await uploadRoute.GET(new NextRequest(readUrl))).status,
      401
    );
  });
});
