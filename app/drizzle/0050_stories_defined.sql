-- Stories have no workflow status of their own: an open story is stored as
-- defined and the API derives what it shows from its children (task-model.ts's
-- storyRollup). decomposed was only ever a story's label; task-model.ts's
-- STATUS_ALIASES still accepts it on the way in, as defined.
UPDATE "tasks" SET "status" = 'defined' WHERE "status" = 'decomposed';
