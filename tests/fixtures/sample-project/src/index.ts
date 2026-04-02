import { greet, add, createUser, assignRole, startServer } from './utils.js';
import type { Config } from './types.js';

export class App {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  run(): void {
    const user = createUser(1, greet('World'));
    const admin = assignRole(user, 'admin');
    startServer(this.config);
    console.log(admin);
  }
}

export { greet, add, createUser, assignRole };
