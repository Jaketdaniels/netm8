# Shell Commands Reference

## Development
```bash
npm run dev                    # Vite dev server (frontend HMR)
npm run dev:worker             # Wrangler dev (full stack with local D1/KV/R2)
npm run build                  # Production build
npm run test                   # Run all tests
npm run test:watch             # Tests in watch mode
```

## Code Quality
```bash
npm run lint                   # Biome check (lint + format + imports)
npm run lint:fix               # Biome check with auto-fix
npm run format                 # Biome format only
npm run typecheck              # TypeScript check
```

## Cloudflare Resources
```bash
wrangler d1 migrations create netm8-db <migration-name>   # New migration
wrangler d1 migrations apply netm8-db --local              # Apply locally
wrangler d1 migrations apply netm8-db --remote             # Apply to prod
wrangler d1 execute netm8-db --local --command "SQL"       # Run SQL locally
wrangler types                                              # Regenerate types
```

## Deploy
```bash
npm run deploy:staging         # Build + deploy to staging
npm run deploy:production      # Build + deploy to production
wrangler tail --env production # Live logs
```

## Database (Drizzle)
```bash
npx drizzle-kit generate      # Generate migration from schema changes
npx drizzle-kit push           # Push schema directly (dev only)
```
