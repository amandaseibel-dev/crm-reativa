drop function if exists public.prime_conferencia_rejeitar_lote(uuid[], text);
-- para desfazer decisoes ja gravadas:
-- delete from public.prime_conferencia_decisao where decisao = 'REJEITADO' and decidido_em > '...';
