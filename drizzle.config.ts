import type { Config } from 'drizzle-kit'

export default {
  schema: './src/main/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/cc-use.db',
  },
} satisfies Config
