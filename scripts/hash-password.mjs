// Prints a password hash for the `auth:` section of querydog.yml:
//   npm run hash-password -- 'my password'
import { hashPassword } from '../server/auth.js';

const password = process.argv[2];
if (!password) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}
console.log(hashPassword(password));
