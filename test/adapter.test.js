import ServerAdapter from "../index.js";
import { admin, firestore } from "./setup.js";
import { GeoPoint } from "firebase-admin/firestore"; // ← 追加

describe("ServerAdapter", () => {
  let adapter;

  beforeAll(() => {
    adapter = new ServerAdapter(firestore);
  });

  describe("インスタンス化", () => {
    test("ServerAdapter がインスタンス化できる", () => {
      expect(adapter).toBeInstanceOf(ServerAdapter);
    });

    test('type が "SERVER" を返す', () => {
      expect(adapter.type).toBe("SERVER");
    });
  });

  describe("firestore", () => {
    test("firestore インスタンスが取得できる", () => {
      expect(adapter.firestore).toBeDefined();
      expect(typeof adapter.firestore).toBe("object");
    });

    test("firestore が admin.firestore() と同じインスタンス", () => {
      expect(adapter.firestore).toBe(firestore);
    });
  });

  describe("functions", () => {
    test("functions は null を返す（引数なしの場合）", () => {
      expect(adapter.functions).toBeNull();
    });

    test("functions を渡した場合は設定される", () => {
      const mockFunctions = { test: "functions" };
      const adapterWithFunctions = new ServerAdapter(firestore, mockFunctions);
      expect(adapterWithFunctions.functions).toBe(mockFunctions);
    });
  });

  describe("GeoPoint", () => {
    test("GeoPoint クラスが取得できる", () => {
      expect(adapter.GeoPoint).toBeDefined();
      expect(typeof adapter.GeoPoint).toBe("function");
    });

    test("GeoPoint が firebase-admin/firestore の GeoPoint と同じ", () => {
      // ← 修正: admin.firestore.GeoPoint ではなく GeoPoint をインポートして比較
      expect(adapter.GeoPoint).toBe(GeoPoint);
    });

    test("GeoPoint インスタンスを生成できる", () => {
      const point = new adapter.GeoPoint(35.6812, 139.7671);
      expect(point._latitude).toBe(35.6812);
      expect(point._longitude).toBe(139.7671);
    });
  });

  describe("logger", () => {
    test("logger が定義されている", () => {
      expect(adapter.logger).toBeDefined();
    });
  });
});
