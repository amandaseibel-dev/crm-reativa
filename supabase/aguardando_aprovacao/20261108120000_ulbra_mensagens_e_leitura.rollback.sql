-- =============================================================================
-- REVERSA da proposta 20261108120000 — NÃO EXECUTADA.
--
-- Desfaz o que a proposta cria, e só isso. Não encosta em `ulbra_vinculos`,
-- em `alunos` nem em qualquer objeto anterior.
--
-- CUIDADO, e isto é o ponto importante desta reversa: derrubar
-- `ulbra_leitura_usuario` APAGA o marcador de leitura de todo mundo. Ninguém
-- perde dado da ULBRA com isso (o cache de mensagens é reconstruível pela
-- sincronização, e o texto nunca esteve aqui), mas todos voltam a ver como
-- "não lido" o que já tinham lido. É perda de conforto, não de informação —
-- ainda assim, avisar antes de rodar.
-- =============================================================================

begin;

drop policy if exists ulbra_msg_select on public.ulbra_mensagens_recebidas;

drop policy if exists ulbra_leitura_select on public.ulbra_leitura_usuario;
drop policy if exists ulbra_leitura_insert on public.ulbra_leitura_usuario;
drop policy if exists ulbra_leitura_update on public.ulbra_leitura_usuario;

drop index if exists public.ulbra_msg_recebida_em_idx;
drop index if exists public.ulbra_msg_aluno_idx;

drop table if exists public.ulbra_mensagens_recebidas;
drop table if exists public.ulbra_leitura_usuario;

-- Prova de que a reversa fez o que diz.
do $$
declare n int;
begin
  select count(*) into n from pg_tables
   where schemaname = 'public'
     and tablename in ('ulbra_mensagens_recebidas', 'ulbra_leitura_usuario');
  if n <> 0 then raise exception 'reversa incompleta: % tabela(s) de pé', n; end if;
end $$;

commit;
