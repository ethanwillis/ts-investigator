"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncGreet = exports.double = void 0;
exports.greet = greet;
exports.add = add;
exports.isAdult = isAdult;
exports.createUser = createUser;
exports.assignRole = assignRole;
exports.startServer = startServer;
exports.formatList = formatList;
function greet(name) {
    return `Hello, ${name}!`;
}
function add(a, b) {
    return a + b;
}
function isAdult(age, strict) {
    return strict ? age >= 18 : age > 16;
}
function createUser(id, name, email) {
    return { id, name, ...(email !== undefined ? { email } : {}) };
}
function assignRole(user, role) {
    return { ...user, role };
}
function startServer(config) {
    // noop
}
function formatList(separator, ...items) {
    return items.join(separator);
}
const double = (n) => n * 2;
exports.double = double;
const asyncGreet = async (name) => {
    return `Hello, ${name}!`;
};
exports.asyncGreet = asyncGreet;
//# sourceMappingURL=utils.js.map