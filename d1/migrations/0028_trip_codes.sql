-- Kos trip codes (docs/trips.md §21): each trip's own 10-character code, for its email address
-- (you+<code>@gmail.com): lowercase letters and digits without look-alikes (no 0, 1, i, l or o).
-- New trips get theirs from the Worker; the trips already here get one now. Additive only.
ALTER TABLE trips ADD COLUMN code TEXT;
UPDATE trips SET code =
  substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) ||
  substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) ||
  substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) ||
  substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) ||
  substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', abs(random()) % 31 + 1, 1)
WHERE code IS NULL;
CREATE UNIQUE INDEX idx_trips_code ON trips (code);
