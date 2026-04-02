import type { User, Role, Config } from './types.js';

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function isAdult(age: number, strict: boolean): boolean {
  return strict ? age >= 18 : age > 16;
}

export function createUser(id: number, name: string, email?: string): User {
  return { id, name, ...(email !== undefined ? { email } : {}) };
}

export function assignRole(user: User, role: Role): User & { role: Role } {
  return { ...user, role };
}

export function startServer(config: Config): void {
  // noop
}

export function formatList(separator: string, ...items: string[]): string {
  return items.join(separator);
}

export const double = (n: number): number => n * 2;

export const asyncGreet = async (name: string): Promise<string> => {
  return `Hello, ${name}!`;
};
