export interface User {
  id: number;
  name: string;
  email?: string;
}

export type Role = 'admin' | 'user' | 'guest';

export interface Config {
  host: string;
  port: number;
  debug?: boolean;
}

export type Status = 'active' | 'inactive' | 'pending';

export type UserId = number;
