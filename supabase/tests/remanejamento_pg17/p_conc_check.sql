-- CONCORRENCIA, veredito: um so vence no mesmo caso; capacidade nunca passa do teto.
\i lib.sql
do $$
declare ra jsonb; rb jsonb; c uuid; dono text; ocup int; mov int;
begin
  select resultado into ra from public.cg_teste_res where sessao = 'a';
  select resultado into rb from public.cg_teste_res where sessao = 'b';
  select caso into c from public.cg_teste_ids where nome = 'MESMO';
  perform pg_temp.afirma(((ra->>'alunos_movidos')::int + (rb->>'alunos_movidos')::int) = 1,
    'mesmo caso: exatamente UMA execucao move ('||coalesce(ra::text,'-')||' | '||coalesce(rb::text,'-')||')');
  dono := pg_temp.dono(c);
  perform pg_temp.afirma(dono = 'cobranca05@aelbra.com.br', 'caso com um dono so (Luana): '||dono);
  perform pg_temp.afirma(pg_temp.marca(c) = pg_temp.hoje() + 10, 'caso vencedor com 10 dias');
  select resultado into ra from public.cg_teste_res where sessao = 'cap_e';
  select resultado into rb from public.cg_teste_res where sessao = 'cap_f';
  mov := coalesce((ra->>'casos_movidos')::int,0) + coalesce((rb->>'casos_movidos')::int,0);
  perform pg_temp.afirma(mov <= 2, 'capacidade: duas previas juntas nao passam do teto (moveram '||mov||')');
  select count(*) into ocup from public.casos where operador_email = 'cobranca06@aelbra.com.br' and not encerrado_operacional;
  perform pg_temp.afirma(ocup <= 2, 'capacidade: Mauricio nao ficou acima do teto (ocupacao '||ocup||')');
end $$;
select 'CONCORRENCIA OK' as resultado;
