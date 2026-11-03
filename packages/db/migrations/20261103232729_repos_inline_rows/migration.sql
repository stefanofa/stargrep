-- A repos row with a halfvec(1024) is about 2.5 KB. At the default 2 KB target, Postgres moves the
-- vector or the tsvector to TOAST, and every search then makes one TOAST lookup per starred repo.
ALTER TABLE "repos" SET (toast_tuple_target = 8160);
