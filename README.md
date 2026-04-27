# Safety Skill Track - Iteration 13

Safety Skill Track is a skills assessment SaaS with a React/Vite frontend and an Express/Prisma backend.

## Stack

- Frontend: React 18, Vite 5, TypeScript, Tailwind CSS
- Backend: Node.js 20, Express, TypeScript, Prisma, JWT
- Database: Supabase Postgres
- File storage: Supabase Storage for branding assets
- Hosting target: Vercel frontend + Vercel serverless API

## Project structure

```text
frontend/  React SPA
backend/   Express API + Prisma schema and seed
```

## Local development

Install and run each app separately.

```bash
# backend
cd backend
npm install
npx prisma migrate deploy
npm run seed
npm run dev

# frontend
cd frontend
npm install
npm run dev
```

Frontend env:

```bash
VITE_API_BASE_URL=http://localhost:4000
```

Backend env:

```bash
DATABASE_URL=postgresql://...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
FRONTEND_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=branding-assets
```

## Seed account

- Username: `superadmin`
- Email: `admin@trainingsaas.com`
- Password: `SuperAdmin2024!`

## Deployment

1. Create a Supabase project.
2. Copy the Supabase Postgres connection string into `backend` as `DATABASE_URL`.
3. Create a public Supabase Storage bucket for branding assets, or set `SUPABASE_STORAGE_BUCKET` to your bucket name.
4. Deploy `backend/` to Vercel as its own project.
5. Set backend Vercel env vars, then run `npx prisma migrate deploy` and `npm run seed`.
6. Deploy `frontend/` to Vercel and set `VITE_API_BASE_URL` to the backend Vercel URL.

## Notes

- The frontend now prefixes `/api` and `/uploads` requests with `VITE_API_BASE_URL` in production.
- Branding uploads use Supabase Storage when Supabase credentials are configured.
- Docker files remain in the repo for legacy local workflows, but the primary cloud target is Supabase plus Vercel.
