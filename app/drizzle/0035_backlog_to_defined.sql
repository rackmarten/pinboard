-- `backlog` was never a real status, but the API accepted any
-- string until now and homelab scripts sent it. It's an alias of `defined`
-- from here on (routes rewrite it on the way in), so move the stored rows.
UPDATE "tasks" SET "status" = 'defined' WHERE "status" = 'backlog';
