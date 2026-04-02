"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assignRole = exports.createUser = exports.add = exports.greet = exports.App = void 0;
const utils_js_1 = require("./utils.js");
Object.defineProperty(exports, "greet", { enumerable: true, get: function () { return utils_js_1.greet; } });
Object.defineProperty(exports, "add", { enumerable: true, get: function () { return utils_js_1.add; } });
Object.defineProperty(exports, "createUser", { enumerable: true, get: function () { return utils_js_1.createUser; } });
Object.defineProperty(exports, "assignRole", { enumerable: true, get: function () { return utils_js_1.assignRole; } });
class App {
    config;
    constructor(config) {
        this.config = config;
    }
    run() {
        const user = (0, utils_js_1.createUser)(1, (0, utils_js_1.greet)('World'));
        const admin = (0, utils_js_1.assignRole)(user, 'admin');
        (0, utils_js_1.startServer)(this.config);
        console.log(admin);
    }
}
exports.App = App;
//# sourceMappingURL=index.js.map