-- Rollback.
--
-- A coluna `parcela` NAO volta para integer: existem valores fracionarios
-- gravados (9,9) e o cast de volta falharia -- ou, pior, truncaria dado real.
-- Se for mesmo necessario reverter, decidir antes o que fazer com esses
-- titulos, na mao.

drop index if exists ix_prime_titulo_carrier;
alter table public.prime_titulo_semestre drop column if exists carrier_id;
