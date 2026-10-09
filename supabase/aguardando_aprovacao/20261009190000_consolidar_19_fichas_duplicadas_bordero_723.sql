-- NAO APLICAR sem autorizacao expressa da Amanda.
--
-- CONSOLIDACAO das fichas duplicadas VAZIAS que o bordero 723 criou em
-- 08/10/2026 19:18 (importacao_id 817bb231, 2.155 linhas). Mesmo desenho e
-- mesmos portoes da correcao ja aplicada em 09/10/2026 para a primeira aluna,
-- agora para os 14 CPFs restantes.
--
-- SEM DADO PESSOAL NESTE ARQUIVO. O repositorio e PUBLICO e a §7 de
-- docs/seguranca/PREMISSA_SEGURANCA_PROJETO.md manda mascarar CPF e nao
-- registra-lo. Por isso aqui nao ha CPF nem nome: as fichas sao identificadas
-- pelo `id` (uuid interno, que nao identifica pessoa fora do banco) e o
-- conjunto de CPFs e DERIVADO desses ids na propria execucao. O de/para com
-- nome e CPF fica onde deve ficar: nas tabelas `_backup_*` criadas aqui, com
-- RLS deny-all e sem grant.
--
-- CENSO (leitura em producao, 09/10/2026)
-- ---------------------------------------
-- 14 CPFs, 33 fichas. Em TODOS os 14 a assinatura e a mesma: UMA ficha
-- concentra os titulos e a movimentacao, as outras sao cascas vazias --
-- numero de fichas = numero de titulos do aluno, porque o importador criava
-- uma ficha por LINHA do arquivo.
--
--   1 CPF com 5 fichas (4 vazias)      ->  5 titulos
--   2 CPFs com 3 fichas (2 vazias cada) -> 3 titulos cada
--  11 CPFs com 2 fichas (1 vazia cada)  -> 2 titulos cada
--   total: 33 fichas, 19 vazias, 14 que ficam
--
-- Divida dos 14 CPFs: R$ 82.550,86 em 33 titulos, conferida antes e depois
-- pelos portoes deste arquivo. Nenhum centavo se move: os titulos ja estao
-- todos nas 14 fichas que ficam.
--
-- Uma das 14 esta em trabalho (saldo, responsavel, solicitacao financeira
-- aberta e 4 movimentacoes). A ficha que sai dela e vazia como as outras, e
-- nada do que ela tem e tocado -- o portao 2.4 e a conferencia 5 provam.
--
-- As 19 fichas que saem: saldo nulo/0,00, valor_em_aberto 0,00, status
-- CONTATAR, sem caso, acordo, titulo, pagamento, contato, atendimento ou
-- confirmacao. Varredura em TODAS as tabelas BASE de public com coluna
-- aluno_id: zero linhas, exceto elegibilidade_shadow_divergencia (57 linhas =
-- 19 x 3 execucoes, SALDO_ZERO_DEFINITIVO, saldo_diagnostico 0,00).
--
-- O LIMITE DA AMANDA E O PORTAO DESTE ARQUIVO: "nao podemos apagar alunos com
-- divida". O item 2 aborta a transacao inteira se qualquer ficha da lista
-- tiver saldo, valor em aberto ou UMA linha em qualquer tabela viva.
--
-- Aplicar por apply_migration, copiando para supabase/migrations/ com
-- timestamp real no momento da aplicacao (ver docs/RUNBOOK-MIGRATIONS.md).
-- Rollback ao lado, recria as 19 fichas com o MESMO id.

-- As 19 fichas vazias, por id. Comentario nenhum: id nao e dado pessoal, nome
-- e CPF seriam.
create temporary table _vazias_bordero723 (id uuid primary key);
insert into _vazias_bordero723 (id) values
  ('3d0309cf-cf7a-4767-858e-36a2e8a75462'),
  ('d857dbf5-6b19-49c7-8c89-c9e0c956944e'),
  ('65d59d55-d50b-42e2-b78f-3ed6633cce42'),
  ('67ba1317-34c2-47b7-9490-56fd9d3dfc35'),
  ('b9c6d8a8-9a14-4a7f-9fe2-eac43b25f7b3'),
  ('d6d62bf9-c4ea-4801-a7fc-b6676b038641'),
  ('5f68241c-1523-42ef-b999-546492484099'),
  ('5024469f-98e0-4e53-a8c9-3e40a979e88c'),
  ('266d05d4-4a15-493f-aced-26a9b3a15e72'),
  ('cd75953c-025f-4d4d-8b87-f4e9dd6122c7'),
  ('cc2c8f47-b2a6-459d-a2f1-8326d22b3bc8'),
  ('7cdcad35-fe32-4bee-80f8-885925c12c45'),
  ('c190d993-cdf0-4054-8110-126d2b2c358a'),
  ('81d12a75-3e4c-48f3-98ae-984b0db5d2fd'),
  ('84adc675-ce3c-4e59-b27a-ec85d191e66c'),
  ('0b2daeef-5542-4645-a6a5-87de1c2d6321'),
  ('2dbb2ab3-f5bd-45a4-8c32-4331bf69533e'),
  ('1502e88f-760d-43e7-aa90-ea44199b2c40'),
  ('b2c1b4bf-7390-4db2-aa4c-720cee13c4d0');

-- Os 14 CPFs, DERIVADOS dos ids acima. Nunca escritos neste arquivo.
create temporary table _cpfs_bordero723 (cpf_limpo text primary key);
insert into _cpfs_bordero723 (cpf_limpo)
select distinct regexp_replace(coalesce(a.cpf,''),'\D','','g')
  from public.alunos a
  join _vazias_bordero723 v on v.id = a.id
 where coalesce(btrim(a.cpf),'') <> '';

-- 1. BACKUP antes de qualquer escrita. E aqui, e so aqui, que nome e CPF
--    ficam -- em tabela com RLS deny-all e sem grant a anon/authenticated.
create table if not exists public._backup_alunos_dup_bordero723_20261009 as
select a.*, now() as copiado_em
  from public.alunos a
 where regexp_replace(coalesce(a.cpf,''),'\D','','g')
       in (select cpf_limpo from _cpfs_bordero723);

alter table public._backup_alunos_dup_bordero723_20261009 enable row level security;
alter table public._backup_alunos_dup_bordero723_20261009 force row level security;
revoke all on public._backup_alunos_dup_bordero723_20261009 from anon, authenticated;

create table if not exists public._backup_shadow_dup_bordero723_20261009 as
select e.*, now() as copiado_em
  from public.elegibilidade_shadow_divergencia e
 where e.aluno_id::text in (select id::text from _vazias_bordero723);

alter table public._backup_shadow_dup_bordero723_20261009 enable row level security;
alter table public._backup_shadow_dup_bordero723_20261009 force row level security;
revoke all on public._backup_shadow_dup_bordero723_20261009 from anon, authenticated;

-- 2. PORTAO.
do $$
declare
  v_vazias text[];
  r record;
  v int;
  v_valor numeric;
begin
  select array_agg(id::text) into v_vazias from _vazias_bordero723;

  if cardinality(v_vazias) <> 19 then
    raise exception 'ABORTADO: a lista tem % ids, nao 19.', cardinality(v_vazias);
  end if;

  select count(*) into v from _cpfs_bordero723;
  if v <> 14 then
    raise exception 'ABORTADO: os 19 ids derivam % CPFs, nao 14. Refaca o censo.', v;
  end if;

  select count(*) into v from public._backup_alunos_dup_bordero723_20261009;
  if v <> 33 then
    raise exception 'ABORTADO: esperava 33 fichas no backup, encontrei %. Refaca o censo.', v;
  end if;

  select count(*) into v from public._backup_shadow_dup_bordero723_20261009;
  if v <> 57 then
    raise exception 'ABORTADO: esperava 57 linhas shadow no backup, encontrei %.', v;
  end if;

  -- 2.1 as 19 existem e todas tem CPF
  select count(*) into v
    from public.alunos a
    join _vazias_bordero723 vz on vz.id = a.id
   where coalesce(btrim(a.cpf),'') <> '';
  if v <> 19 then
    raise exception 'ABORTADO: % das 19 fichas existem com CPF (esperado 19).', v;
  end if;

  -- 2.2 NENHUMA DIVIDA nas 19 que saem
  select coalesce(sum(coalesce(saldo_total,0) + coalesce(saldo_vencido,0)
                      + coalesce(valor_em_aberto,0)),0) into v_valor
    from public.alunos where id::text = any (v_vazias);
  if v_valor <> 0 then
    raise exception 'ABORTADO: as fichas a apagar somam % em valores. NAO se apaga aluno com divida.', v_valor;
  end if;

  -- 2.3 cada CPF tem de ficar com EXATAMENTE uma ficha depois
  for r in
    select regexp_replace(coalesce(a.cpf,''),'\D','','g') cpf_limpo,
           count(*) filter (where not (a.id::text = any (v_vazias))) sobram
      from public.alunos a
     where regexp_replace(coalesce(a.cpf,''),'\D','','g')
           in (select cpf_limpo from _cpfs_bordero723)
     group by 1
  loop
    if r.sobram <> 1 then
      -- a mensagem nao imprime o CPF: diz quantas fichas, e o operador acha
      -- o caso pelo backup. Erro de banco vira log, e log nao recebe CPF.
      raise exception 'ABORTADO: um dos CPFs ficaria com % fichas (esperado 1).', r.sobram;
    end if;
  end loop;

  -- 2.4 varredura: ZERO linhas em qualquer tabela viva de public com aluno_id
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
                   r.table_name, r.column_name) into v using v_vazias;
    if v > 0 then
      raise exception 'ABORTADO: %.% tem % linha(s) das fichas a apagar. Mescle em vez de apagar.',
        r.table_name, r.column_name, v;
    end if;
  end loop;

  -- 2.5 cinto e suspensorio nas quatro tabelas financeiras
  select count(*) into v from public.casos where aluno_id::text = any (v_vazias);
  if v > 0 then raise exception 'ABORTADO: % caso(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.pagamentos where aluno_id::text = any (v_vazias);
  if v > 0 then raise exception 'ABORTADO: % pagamento(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.acordos where aluno_id::text = any (v_vazias);
  if v > 0 then raise exception 'ABORTADO: % acordo(s) nas fichas a apagar.', v; end if;
  select count(*) into v from public.acordos_titulos where aluno_id::text = any (v_vazias);
  if v > 0 then raise exception 'ABORTADO: % titulo(s) nas fichas a apagar.', v; end if;

  -- 2.6 o total devido dos 14 CPFs antes de escrever, para conferir depois
  select coalesce(sum(valor_original),0) into v_valor
    from public.acordos_titulos t
   where regexp_replace(coalesce(t.cpf,''),'\D','','g')
         in (select cpf_limpo from _cpfs_bordero723);
  if v_valor is distinct from 82550.86 then
    raise exception 'ABORTADO: titulos dos 14 CPFs somam % (esperado 82550.86). Refaca o censo.', v_valor;
  end if;
end $$;

-- 3. Linhas de auditoria shadow das fichas que saem (ja no backup).
delete from public.elegibilidade_shadow_divergencia e
 where e.aluno_id::text in (select id::text from _vazias_bordero723);

-- 4. EXCLUSAO das 19 fichas vazias (audit_log registra via trg_audit_del).
--    O `and` final e redundante com o portao 2.2 de proposito: se esta
--    instrucao for copiada para outro lugar sem o portao, ela continua
--    recusando ficha com valor.
delete from public.alunos a
 using _vazias_bordero723 vz
 where a.id = vz.id
   and coalesce(a.saldo_total,0) = 0
   and coalesce(a.saldo_vencido,0) = 0
   and coalesce(a.valor_em_aberto,0) = 0;

-- 5. CONFERENCIA depois de escrever.
do $$
declare
  r record;
  v int;
  v_valor numeric;
begin
  for r in
    select count(*) n
      from public.alunos a
     where regexp_replace(coalesce(a.cpf,''),'\D','','g')
           in (select cpf_limpo from _cpfs_bordero723)
     group by regexp_replace(coalesce(a.cpf,''),'\D','','g')
  loop
    if r.n <> 1 then
      raise exception 'ABORTADO: um dos CPFs ficou com % fichas (esperado 1).', r.n;
    end if;
  end loop;

  select count(*) into v
    from public.alunos a
   where regexp_replace(coalesce(a.cpf,''),'\D','','g')
         in (select cpf_limpo from _cpfs_bordero723);
  if v <> 14 then
    raise exception 'ABORTADO: sobraram % fichas para os 14 CPFs (esperado 14).', v;
  end if;

  -- a divida nao se move: mesmo total de antes, nenhum titulo orfao
  select coalesce(sum(valor_original),0) into v_valor
    from public.acordos_titulos t
   where regexp_replace(coalesce(t.cpf,''),'\D','','g')
         in (select cpf_limpo from _cpfs_bordero723);
  if v_valor is distinct from 82550.86 then
    raise exception 'ABORTADO: titulos somam % depois (esperado 82550.86).', v_valor;
  end if;

  select count(*) into v
    from public.acordos_titulos t
   where regexp_replace(coalesce(t.cpf,''),'\D','','g')
         in (select cpf_limpo from _cpfs_bordero723)
     and not exists (select 1 from public.alunos a where a.id::text = t.aluno_id::text);
  if v > 0 then
    raise exception 'ABORTADO: % titulo(s) ficaram orfaos.', v;
  end if;

  -- o que estava em trabalho continua em trabalho: nenhuma solicitacao
  -- financeira destes 14 CPFs se perdeu (1 aberta antes, 1 depois)
  select count(*) into v
    from public.solicitacoes_financeiro s
    join public.alunos a on a.id::text = s.aluno_id::text
   where regexp_replace(coalesce(a.cpf,''),'\D','','g')
         in (select cpf_limpo from _cpfs_bordero723);
  if v <> 1 then
    raise exception 'ABORTADO: solicitacoes financeiras dos 14 CPFs = % (esperado 1).', v;
  end if;
end $$;

drop table _vazias_bordero723;
drop table _cpfs_bordero723;
