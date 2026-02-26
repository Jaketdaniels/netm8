# Shell Commands

## Day-to-day
```bash
npm run dev                # Full stack local dev (Wrangler + Vite HMR + D1/KV/R2)
npm run check              # Quality gate: lint + typecheck + test
npm run lint               # Auto-fix lint + format + imports
npm test                   # Run tests
```

## Deploy
```bash
npm run deploy:staging     # Build + migrate + deploy staging
npm run deploy:production  # Build + migrate + deploy production
wrangler tail --env staging # Live logs
```

## Database
```bash
wrangler d1 migrations create netm8-db <name>  # New migration file
wrangler d1 migrations apply netm8-db --local   # Apply locally
wrangler d1 execute netm8-db --local --command "SQL"
npx drizzle-kit generate   # Generate migration from schema.ts changes
```

## Cloudflare
```bash
wrangler types              # Regenerate bindings (also runs in build)
wrangler secret put <NAME>  # Set secret for production
wrangler secret put <NAME> --env staging
```
