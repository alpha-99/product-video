/**
 * 客户端共享缓存（阶段八补充）：保证菜单切换能复用数据、不会串账号。
 * 纯函数测试，不需要 React / DOM 环境。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cacheSize,
  clearCache,
  readCacheEntry,
  writeCache,
} from "../src/lib/client/cache";

describe("客户端共享缓存", () => {
  it("写入后可按键读取，不同键互不干扰", () => {
    clearCache();
    writeCache("templates", [{ id: "t1" }]);
    writeCache("products", [{ id: "p1" }]);

    assert.deepEqual(readCacheEntry<{ id: string }[]>("templates")?.data, [{ id: "t1" }]);
    assert.deepEqual(readCacheEntry<{ id: string }[]>("products")?.data, [{ id: "p1" }]);
    assert.equal(readCacheEntry("missing"), null);
    assert.equal(cacheSize(), 2);
  });

  it("覆盖写会刷新时间戳", () => {
    clearCache();
    writeCache("videos", []);
    const first = readCacheEntry("videos")!.at;
    writeCache("videos", [{ id: "v1" }]);
    const second = readCacheEntry("videos")!;
    assert.deepEqual(second.data, [{ id: "v1" }]);
    assert.ok(second.at >= first);
  });

  it("超过 staleMs 的条目读取时被清除", () => {
    clearCache();
    writeCache("me", { quotaLeft: 3 });
    assert.equal(readCacheEntry("me", -1), null);
    assert.equal(cacheSize(), 0);
  });

  it("clearCache 清空全部条目（退出登录时调用）", () => {
    writeCache("a", 1);
    writeCache("b", 2);
    clearCache();
    assert.equal(cacheSize(), 0);
    assert.equal(readCacheEntry("a"), null);
  });
});
