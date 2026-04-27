"""
Drop all objects in the public schema before a fresh Prisma db push.
Handles tables, views, enum types, and sequences with proper ordering.
"""
import pg8000, ssl, os
from urllib.parse import urlparse, unquote

url = os.environ["DATABASE_URL"]
u = urlparse(url)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

conn = pg8000.connect(
    host=u.hostname,
    port=u.port or 5432,
    database=u.path.lstrip("/").split("?")[0],
    user=unquote(u.username),
    password=unquote(u.password),
    ssl_context=ctx,
)
conn.autocommit = True
cur = conn.cursor()

# 1. Drop all views
cur.execute("SELECT table_name FROM information_schema.views WHERE table_schema='public'")
for (v,) in cur.fetchall():
    cur.execute('DROP VIEW IF EXISTS public."%s" CASCADE' % v)
    print("Dropped view:", v)

# 2. Drop all tables
cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'")
for (t,) in cur.fetchall():
    cur.execute('DROP TABLE IF EXISTS public."%s" CASCADE' % t)
    print("Dropped table:", t)

# 3. Drop all enum types
cur.execute("""
    SELECT typname FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
""")
for (tp,) in cur.fetchall():
    cur.execute('DROP TYPE IF EXISTS public."%s" CASCADE' % tp)
    print("Dropped type:", tp)

# 4. Drop all sequences
cur.execute("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")
for (s,) in cur.fetchall():
    cur.execute('DROP SEQUENCE IF EXISTS public."%s" CASCADE' % s)
    print("Dropped sequence:", s)

conn.close()
print("Public schema cleaned successfully.")
