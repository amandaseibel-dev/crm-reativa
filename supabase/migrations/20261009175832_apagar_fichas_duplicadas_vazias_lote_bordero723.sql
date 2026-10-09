-- REPARO DE DADOS -- cadastros duplicados de UMA aluna, do lote do bordero 723.
-- Pedido e decisao da Amanda em 09/10/2026: "se tiver cadastro duplicado
-- podemos sim apagar" / "nao podemos apagar alunos com divida".
--
-- APLICADA EM PRODUCAO em 09/10/2026, versao 20261009175832.
--
-- SEM DADO PESSOAL NESTE ARQUIVO. O repositorio e PUBLICO e a §7 de
-- docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md manda mascarar CPF e nao
-- registra-lo. As fichas aparecem pelo `id` (uuid interno, que nao identifica
-- pessoa fora do banco) e o CPF e DERIVADO desses ids na propria execucao.
-- A versao executada em 09/10 trazia o CPF literal no filtro; os statements
-- exatos daquela execucao estao em
-- `supabase_migrations.schema_migrations.statements` (banco privado), e o
-- de/para com nome e CPF esta nas tabelas `_backup_*` criadas aqui, com RLS
-- deny-all e sem grant. A logica, os portoes e o efeito sao os mesmos.
--
-- A REGRA QUE ESTA MIGRATION RESPEITA. docs/PADRAO_CADASTRO.md regra 5/6 e o
-- cabecalho de 20260827250000_mesclar_aluno_duplicado.sql proibem apagar ficha
-- COM CONTEUDO -- foi o que gerou os 761 casos sem aluno de 27/08. Aqui a
-- exclusao e autorizada e so alcanca ficha COMPROVADAMENTE VAZIA: saldo zero,
-- sem divida, sem caso, sem acordo, sem titulo, sem pagamento, sem contato,
-- sem atendimento, sem confirmacao. O portao do item 2 aborta a migration
-- inteira se qualquer uma delas tiver uma unica linha em qualquer tabela viva.
--
-- CENSO (leitura em producao, 09/10/2026). Seis fichas para o mesmo CPF, TODAS
-- criadas no mesmo lote de importacao em 08/10/2026 19:18:51
-- (importacao_id 817bb231):
--
--   FICA  c4c8781e  saldo_total 10.445,07 | COBRANCA_VENCIDA | com responsavel
--                   6 acordos_titulos em aberto (venc. 01..06/2026, soma
--                   10.445,07 -- confere com o saldo)
--                   5 aluno_movimentacoes (acao massiva + atendimento)
--                   1 solicitacoes_financeiro ABERTA -- NAO e tocada
--   SAI   d170ac1e  22ba5dd1  bf707bb4  78c350d1  468768c2
--                   saldo_total nulo, valor_em_aberto 0,00, status CONTATAR.
--                   Varredura em TODAS as tabelas BASE de public com coluna
--                   aluno_id: zero linhas, exceto
--                   elegibilidade_shadow_divergencia (15 linhas, auditoria
--                   shadow, SALDO_ZERO_DEFINITIVO, saldo_diagnostico 0,00).
--
-- NENHUM caso existe para esta aluna em nenhuma das 6 fichas -- nao se mexe em
-- casos, status de caso nem responsavel.
--
-- A exclusao fica registrada em audit_log pelo gatilho trg_audit_del.
-- Rollback recria as 5 fichas com o MESMO id.
--
-- ESCOPO: so este CPF. Nenhum outro aluno e tocado.
--
-- Aplicada por apply_migration (envolve tudo numa transacao unica: qualquer
-- portao que levante excecao desfaz a migration inteira).

-- As 5 fichas vazias, e a que fica, por id.
create temporary table _fichas_lote723 (id uuid primary key, papel text not null);
insert into _fichas_lote723 (id, papel) values
  ('c4c8781e-ee5b-453e-bd7f-07ba07594414', 'FICA'),
  ('d170ac1e-a077-407b-9bf0-34c33a1e283a', 'SAI'),
  ('22ba5dd1-c999-4a8b-b9cb-efd440bf5fa8', 'SAI'),
  ('bf707bb4-6201-4966-80c5-b49dcf23b12a', 'SAI'),
  ('78c350d1-6e1c-4964-b4d2-19db3fc8959b', 'SAI'),
  ('468768c2-25a9-4aec-be28-c34494ed9b6d', 'SAI');

-- O CPF, DERIVADO dos ids acima. Nunca escrito neste arquivo.
create temporary table _cpf_lote723 (cpf_limpo text primary key);
insert into _cpf_lote723 (cpf_limpo)
select distinct regexp_replace(coalesce(a.cpf,''),'\D','','g')
  from public.alunos a join _fichas_lote723 f on f.id = a.id
 where coalesce(btrim(a.cpf),'') <> '';

-- 1. BACKUP antes de qualquer escrita.
create table if not exists public._backup_alunos_dup_thamis_20261009 as
select a.*, now() as copiado_em
  from public.alunos a
 where regexp_replace(coalesce(a.cpf,''),'\D','','g')
       in (select cpf_limpo from _cpf_lote723);

alter table public._backup_alunos_dup_thamis_20261009 enable row level security;
alter table public._backup_alunos_dup_thamis_20261009 force row level security;
revoke all on public._backup_alunos_dup_thamis_20261009 from anon, authenticated;

create table if not exists public._backup_shadow_dup_thamis_20261009 as
select e.*, now() as copiado_em
  from public.elegibilidade_shadow_divergencia e
 where e.aluno_id::text in ('d170ac1e-a077-407b-9bf0-34c33a1e283a',
                            '22ba5dd1-c999-4a8b-b9cb-efd440bf5fa8',
                            'bf707bb4-6201-4966-80c5-b49dcf23b12a',
                            '78c350d1-6e1c-4964-b4d2-19db3fc8959b',
                            '468768c2-25a9-4aec-be28-c34494ed9b6d');

alter table public._backup_shadow_dup_thamis_20261009 enable row level security;
alter table public._backup_shadow_dup_thamis_20261009 force row level security;
revoke all on public._backup_shadow_dup_thamis_20261009 from anon, authenticated;

-- 2. PORTAO. Nada e apagado se qualquer premissa do censo nao se confirmar.
do $$
declare
  v_ids text[];
  v_manter uuid := 'c4c8781e-ee5b-453e-bd7f-07ba07594414';
  r record;
  v int;
  v_saldo numeric;
  v_valor numeric;
begin
  select array_agg(id::text) into v_ids from _fichas_lote723 where papel = 'SAI';
  if cardinality(v_ids) <> 5 then
    raise exception 'ABORTADO: a lista tem % ids para sair, nao 5.', cardinality(v_ids);
  end if;

  -- 2.1 backup completo das 6 fichas
  select count(*) into v from public._backup_alunos_dup_thamis_20261009;
  if v <> 6 then
    raise exception 'ABORTADO: esperava 6 fichas no backup, encontrei %. Refaca o censo.', v;
  end if;

  select count(*) into v from public._backup_shadow_dup_thamis_20261009;
  if v <> 15 then
    raise exception 'ABORTADO: esperava 15 linhas shadow no backup, encontrei %.', v;
  end if;

  -- 2.2 as 5 fichas existem, tem o MESMO CPF da que fica e nao sao ela
  select count(*) into v
    from public.alunos
   where id::text = any (v_ids)
     and regexp_replace(coalesce(cpf,''),'\D','','g')
         in (select cpf_limpo from _cpf_lote723);
  if v <> 5 then
    raise exception 'ABORTADO: % das 5 fichas conferem id+CPF (esperado 5).', v;
  end if;
  if v_manter::text = any (v_ids) then
    raise exception 'ABORTADO: a ficha que fica esta na lista de exclusao.';
  end if;

  -- 2.3 NENHUMA DIVIDA nas 5 que saem
  select coalesce(sum(coalesce(saldo_total,0) + coalesce(saldo_vencido,0)
                      + coalesce(valor_em_aberto,0)),0) into v_valor
    from public.alunos where id::text = any (v_ids);
  if v_valor <> 0 then
    raise exception 'ABORTADO: as fichas a apagar somam % em valores. NAO se apaga aluno com divida.', v_valor;
  end if;

  -- 2.4 a ficha que fica continua com a divida inteira
  select saldo_total into v_saldo from public.alunos where id = v_manter;
  if v_saldo is distinct from 10445.07 then
    raise exception 'ABORTADO: saldo da ficha que fica e % (esperado 10445.07).', v_saldo;
  end if;
  select coalesce(sum(valor_original),0) into v_valor
    from public.acordos_titulos where aluno_id::text = v_manter::text;
  if v_valor is distinct from 10445.07 then
    raise exception 'ABORTADO: titulos da ficha que fica somam % (esperado 10445.07).', v_valor;
  end if;

  -- 2.5 varredura: ZERO linhas em qualquer tabela viva de public com aluno_id
  --     (a shadow de auditoria e a unica excecao, ja copiada no backup)
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name = 'aluno_id'
       and c.table_name <> 'alunos'
       and c.table_name <> 'elegibilidade_shadow_divergencia'
       and c.table_name not like '\_%'
       and c.table_name not like '%backup%'
       and c.table_name not like '%bkp%'
  loop
    execute format('select count(*) from public.%I where %I::text = any ($1)',
                   r.table_name, r.column_name) into v using v_ids;
    if v > 0 then
      raise exception 'ABORTADO: %.% tem % linha(s) das fichas a apagar. Mescle em vez de apagar.',
        r.table_name, r.column_name, v;
    end if;
  end loop;

  -- 2.6 nenhuma linha presa por chave estrangeira (cinto e suspensorio)
  select count(*) into v from public.casos where aluno_id::text = any (v_ids);
  if v > 0 then raise exception 'ABORTADO: % caso(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.pagamentos where aluno_id::text = any (v_ids);
  if v > 0 then raise exception 'ABORTADO: % pagamento(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.acordos where aluno_id::text = any (v_ids);
  if v > 0 then raise exception 'ABORTADO: % acordo(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.acordos_titulos where aluno_id::text = any (v_ids);
  if v > 0 then raise exception 'ABORTADO: % titulo(s) nas fichas a apagar.', v; end if;
end $$;

-- 3. Linhas de auditoria shadow das fichas que saem (ja no backup).
delete from public.elegibilidade_shadow_divergencia e
 where e.aluno_id::text in ('d170ac1e-a077-407b-9bf0-34c33a1e283a',
                            '22ba5dd1-c999-4a8b-b9cb-efd440bf5fa8',
                            'bf707bb4-6201-4966-80c5-b49dcf23b12a',
                            '78c350d1-6e1c-4964-b4d2-19db3fc8959b',
                            '468768c2-25a9-4aec-be28-c34494ed9b6d');

-- 4. EXCLUSAO das 5 fichas duplicadas vazias (audit_log registra via trg_audit_del).
delete from public.alunos a
 using _fichas_lote723 f
 where a.id = f.id
   and f.papel = 'SAI'
   and coalesce(a.saldo_total,0) = 0
   and coalesce(a.saldo_vencido,0) = 0
   and coalesce(a.valor_em_aberto,0) = 0;

-- 5. CONFERENCIA depois de escrever.
do $$
declare
  v_fichas int; v_saldo numeric; v_titulos int; v_valor numeric; v_mov int; v_solic int;
begin
  select count(*) into v_fichas
    from public.alunos
   where regexp_replace(coalesce(cpf,''),'\D','','g')
         in (select cpf_limpo from _cpf_lote723);
  if v_fichas <> 1 then
    raise exception 'ABORTADO: sobraram % fichas para o CPF (esperado 1).', v_fichas;
  end if;

  select saldo_total into v_saldo
    from public.alunos where id = 'c4c8781e-ee5b-453e-bd7f-07ba07594414';
  if v_saldo is distinct from 10445.07 then
    raise exception 'ABORTADO: saldo depois = % (esperado 10445.07, identico ao de antes).', v_saldo;
  end if;

  select count(*), coalesce(sum(valor_original),0) into v_titulos, v_valor
    from public.acordos_titulos where aluno_id::text = 'c4c8781e-ee5b-453e-bd7f-07ba07594414';
  if v_titulos <> 6 or v_valor is distinct from 10445.07 then
    raise exception 'ABORTADO: titulos depois = % / % (esperado 6 e 10445.07).', v_titulos, v_valor;
  end if;

  select count(*) into v_mov from public.aluno_movimentacoes
   where aluno_id::text = 'c4c8781e-ee5b-453e-bd7f-07ba07594414';
  if v_mov <> 5 then
    raise exception 'ABORTADO: historico depois = % movimentacoes (esperado 5).', v_mov;
  end if;

  select count(*) into v_solic from public.solicitacoes_financeiro
   where aluno_id::text = 'c4c8781e-ee5b-453e-bd7f-07ba07594414';
  if v_solic <> 1 then
    raise exception 'ABORTADO: solicitacao financeira depois = % (esperado 1).', v_solic;
  end if;
end $$;

drop table _fichas_lote723;
drop table _cpf_lote723;
