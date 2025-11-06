"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newTokenUser = newTokenUser;
function newTokenUser() {
    return (globalThis.crypto ?? require("crypto")).randomUUID();
}
