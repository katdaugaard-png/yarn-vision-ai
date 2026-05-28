
-- 1) Public storage bucket for cached recolored images
INSERT INTO storage.buckets (id, name, public)
VALUES ('recolored', 'recolored', true)
ON CONFLICT (id) DO NOTHING;

-- Anyone can read cached images (they're shown in the shop)
CREATE POLICY "Recolored images are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'recolored');

-- Only the server (service role) writes — no public insert/update/delete policies needed.

-- 2) Request log for rate limiting and daily budget cap
CREATE TABLE public.recolor_requests (
  id BIGSERIAL PRIMARY KEY,
  ip TEXT NOT NULL,
  kit_id TEXT NOT NULL,
  color_id TEXT NOT NULL,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recolor_requests_ip_time
  ON public.recolor_requests (ip, created_at DESC);

CREATE INDEX idx_recolor_requests_time
  ON public.recolor_requests (created_at DESC);

-- Server-only. No anon/authenticated grants.
GRANT ALL ON public.recolor_requests TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.recolor_requests_id_seq TO service_role;

ALTER TABLE public.recolor_requests ENABLE ROW LEVEL SECURITY;
-- No policies = no access except service_role (which bypasses RLS).
