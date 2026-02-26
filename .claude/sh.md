# Shell Commands Reference

## Development
```bash
npm run dev                    # Vite dev server
npm run dev:worker             # Wrangler dev (local D1/KV/R2)
npm run build                  # Production build
npm run test                   # Run all tests
npm run test:watch             # Tests in watch mode
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
npm run deploy:staging         # Deploy to staging
npm run deploy:production      # Deploy to production
wrangler tail --env production # Live logs
```

## Quality
```bash
npm run lint                   # ESLint
npm run typecheck              # TypeScript check
npm run test                   # All tests
```
