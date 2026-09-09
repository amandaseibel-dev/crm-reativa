-- REPARO DE DADOS, aplicado em producao em 09/09/2026. E o que destravou o
-- indice unico de 20260908220000_uma_ficha_aberta_por_aluno.sql.
--
-- Quatro alunos tinham mais de uma ficha aberta ao mesmo tempo, e a mesma
-- divida era contada duas vezes na carteira: R$ 15.202,96.
--
-- A duplicata tem assinatura: ficha SEM caso_codigo, criada em 15/07/2026, num
-- lote, sem tabulacao/observacao/termo. Nos dois casos em que as duas fichas
-- tinham codigo:
--   * Powllana: fica a 11744, que tem operador e status QUITACAO. A 13032 esta
--     SEM operador e veio do sistema_fusao_cpf_sem_zero;
--   * Fabricio: fica a 14143 (decisao da Amanda) -- a mais antiga e em
--     TRATATIVA, que e estado de trabalho ativo.
--
-- NAO se mexe em status: o gatilho casos_set_encerrado_operacional recalcula o
-- encerramento quando qualquer campo de status muda, e desfaria isto. Mexendo
-- so em encerrado_operacional, ele preserva o valor. A divida nao se perde:
-- ela mora no ALUNO, nao no caso.
--
-- Depois: 12.350 casos na fila para 12.350 alunos distintos. Um para um.
create table if not exists public._backup_fichas_duplicadas_20260909 as
select c.*, now() as copiado_em
  from public.casos c
 where left(c.id::text, 8) in
       ('c6d841ba',  -- Adriani Baierle       -> fica 8495
        '720c83a6',  -- Fabricio Carbonel     -> fica 14143
        'd4e32f3e',  -- Fabricio Carbonel     -> fica 14143
        'a1016fa9',  -- Fernando A. Pancotto  -> fica 13420
        '36cf87d1'); -- Powllana R. A. Noia   -> fica 11744

alter table public._backup_fichas_duplicadas_20260909 enable row level security;
alter table public._backup_fichas_duplicadas_20260909 force row level security;

do $$
declare v int;
begin
  select count(*) into v from public._backup_fichas_duplicadas_20260909;
  if v <> 5 then
    raise exception 'ABORTADO: esperava 5 fichas, encontrei %. Refaca a analise.', v;
  end if;
end $$;

update public.casos c
   set encerrado_operacional = true,
       observacao_operacional = trim(both ' | ' from
         coalesce(c.observacao_operacional,'') || ' | ' ||
         'Ficha duplicada encerrada em 09/09/2026: o aluno tem outra ficha aberta e a dívida estava sendo contada duas vezes. Backup em _backup_fichas_duplicadas_20260909.'),
       caso_atualizado_por = 'fusao_ficha_duplicada_20260909',
       caso_atualizado_em = now()
  from public._backup_fichas_duplicadas_20260909 b
 where c.id = b.id;
