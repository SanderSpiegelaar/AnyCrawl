import { describe, it, expect } from "@jest/globals";
import { encodeCursor, decodeCursor, InvalidCursorError } from "../utils/cursor.js";

describe("cursor codec", () => {
    describe("encode/decode round-trip", () => {
        it("round-trips a numeric sort value (epoch millis)", () => {
            const cursor = { v: 1_752_285_600_000, id: "11111111-1111-1111-1111-111111111111" };
            expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
        });

        it("round-trips a string projection value", () => {
            const cursor = { v: "iPhone 15 Pro", id: "abc-123" };
            expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
        });

        it("round-trips a boolean projection value", () => {
            const cursor = { v: true, id: "def-456" };
            expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
        });

        it("round-trips a null sort value", () => {
            const cursor = { v: null, id: "ghi-789" };
            expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
        });

        it("produces a URL-safe token (base64url, no +/=)", () => {
            const token = encodeCursor({ v: 1234567890, id: "aaaa-bbbb-cccc-dddd-eeee" });
            expect(token).not.toMatch(/[+/=]/);
        });
    });

    describe("malformed input", () => {
        it("throws on an empty token", () => {
            expect(() => decodeCursor("")).toThrow(InvalidCursorError);
        });

        it("throws when the decoded payload is not JSON", () => {
            const token = Buffer.from("not-json-at-all", "utf8").toString("base64url");
            expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
        });

        it("throws when the payload is not a 2-tuple array", () => {
            const token = Buffer.from(JSON.stringify({ v: 1, id: "x" }), "utf8").toString("base64url");
            expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
        });

        it("throws when the tuple has the wrong arity", () => {
            const token = Buffer.from(JSON.stringify([1]), "utf8").toString("base64url");
            expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
        });

        it("throws when the id is not a non-empty string", () => {
            const token = Buffer.from(JSON.stringify([1, 42]), "utf8").toString("base64url");
            expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
        });

        it("throws when the sort value is an unsupported type", () => {
            const token = Buffer.from(JSON.stringify([{ nested: true }, "id"]), "utf8").toString("base64url");
            expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
        });
    });
});
