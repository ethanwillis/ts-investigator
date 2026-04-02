import type { User, Role, Config } from './types.js';
export declare function greet(name: string): string;
export declare function add(a: number, b: number): number;
export declare function isAdult(age: number, strict: boolean): boolean;
export declare function createUser(id: number, name: string, email?: string): User;
export declare function assignRole(user: User, role: Role): User & {
    role: Role;
};
export declare function startServer(config: Config): void;
export declare function formatList(separator: string, ...items: string[]): string;
export declare const double: (n: number) => number;
export declare const asyncGreet: (name: string) => Promise<string>;
//# sourceMappingURL=utils.d.ts.map