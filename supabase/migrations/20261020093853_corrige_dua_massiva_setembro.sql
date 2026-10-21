-- CORRECAO PONTUAL: 11 alunos com `data_ultimo_acionamento` atras da propria
-- acao massiva ja registrada.
--
-- O QUE ACONTECEU (medido, nao inferido). Entre 20/09 e 02/10 o gatilho
-- `fn_atualizar_ultimo_acionamento` IGNORAVA os dois tipos massivos: a
-- migration 20260920125611 fez isso de proposito ("acao massiva confirmada e
-- ATIVIDADE, mas nao e contato operacional"). Em 03/10, a 20261003083400
-- devolveu o campo e deixou de fora so a recalculadora. Quem foi acionado por
-- massiva DENTRO dessa janela e nunca mais foi acionado por nada ficou com o
-- campo parado no contato anterior -- a movimentacao existe, o campo e que nao
-- acompanhou.
--
-- SAO 11 ALUNOS, de 17.230 registrados em lote (0,06%). Em TODOS os 11 a
-- movimentacao de acionamento mais nova e a propria massiva, de lote
-- CONFIRMADO: o valor gravado aqui sai do registro que ja existe, nao de
-- inferencia. Conferido aluno por aluno em 20/10/2026.
--
-- O QUE ESTA CORRECAO NAO FAZ:
--   * nao cria movimentacao, acionamento nem retorno;
--   * nao toca `status_acionamento`, `status_jornada`, `status_atual`,
--     `data_retorno`, `retorno_origem`, responsavel, fidelizacao ou acordo;
--   * nao reabre caso, nao mexe em elegibilidade.
-- Isso NAO e promessa: `alunos` tem 18 gatilhos, e um UPDATE que toca SO
-- `data_ultimo_acionamento` dispara apenas tres --
-- `trg_acionamento_nao_volta_para_nulo` (so age quando o valor NOVO e nulo; o
-- nosso nunca e), `trg_aluno_estado_anterior` (trilha) e
-- `trg_sync_acionamento_alunos_para_casos` (espelha em casos, so para frente).
-- Retorno, tabulacao, financeiro e responsavel tem gatilho com `UPDATE OF` em
-- OUTRAS colunas, que este UPDATE nao alcanca. A pos-condicao abaixo confere
-- isso linha a linha e aborta se algo mais tiver mudado.
--
-- RASTREABILIDADE. `trg_aluno_estado_anterior` NAO registra nada aqui: ele sai
-- cedo quando `app_email()` e vazio, e apply_migration roda sem JWT -- foi por
-- isso que os 74 residuos de 02/10 nao deixaram linha em
-- `alunos_estado_anterior`. Entao a trilha e explicita, no padrao do backup de
-- 05/10: duas tabelas com o valor ANTES, por id exato, que o rollback le.
-- Sem PITR, backup + reversao por id e o unico rollback possivel.
--
-- IDEMPOTENTE: o alvo e "quem tem acionamento registrado MAIS NOVO que o
-- campo". Na segunda passada ninguem se qualifica e a funcao devolve 0.

-- ------------------------------------------------------- trilha (valor ANTES)
create table if not exists public._backup_dua_massiva_setembro_20261020 (
  aluno_id                      uuid primary key,
  dua_antes                     timestamptz,
  dua_depois                    timestamptz not null,
  status_acionamento_antes      text,
  data_retorno_antes            date,
  retorno_origem_antes          text,
  responsavel_atual_email_antes text,
  status_jornada_antes          text,
  status_atual_antes            text,
  movimentacao_id               bigint,
  lote_id                       uuid,
  aplicado_em                   timestamptz not null default now()
);

create table if not exists public._backup_dua_massiva_setembro_20261020_casos (
  caso_id      uuid primary key,
  aluno_id     uuid not null,
  dua_antes    date,
  aplicado_em  timestamptz not null default now()
);

-- Tabela nova herda arwdDxtm do schema public, TRUNCATE incluso (ver
-- 20260930232237). Backup de auditoria nao se expoe a ninguem logado.
revoke all on table public._backup_dua_massiva_setembro_20261020 from public, anon, authenticated;
revoke all on table public._backup_dua_massiva_setembro_20261020_casos from public, anon, authenticated;

comment on table public._backup_dua_massiva_setembro_20261020 is
  'Valor ANTES de data_ultimo_acionamento dos alunos corrigidos em 20/10/2026 '
  '(janela 20/09-02/10 em que o gatilho ignorava acao massiva). Fonte do '
  'rollback 20261020094500. Nao expor.';

-- ------------------------------------------------------------- a correcao
create or replace function public._corrige_dua_massiva_setembro(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_corrigidos int := 0;
  v_casos      int := 0;
  v_desviados  int := 0;
begin
  -- Alvo: dos ids pedidos, SO quem tem movimentacao de acionamento mais nova
  -- que o proprio campo. Quem ja esta em dia nao entra -- e o que torna a
  -- funcao idempotente e segura de repetir.
  --
  -- O desempate por `id` escolhe QUAL movimentacao fica na trilha quando duas
  -- tem o mesmo instante; nao muda o VALOR gravado, que e o instante em si.
  -- `drop if exists` antes do create: a funcao pode ser chamada duas vezes na
  -- MESMA transacao (e o que o teste de idempotencia faz).
  drop table if exists _alvo_dua;
  create temp table _alvo_dua on commit drop as
  select a.id                        as aluno_id,
         a.data_ultimo_acionamento   as dua_antes,
         m.registrado_em             as dua_depois,
         m.id                        as movimentacao_id,
         m.lote_id,
         a.status_acionamento, a.data_retorno, a.retorno_origem,
         a.responsavel_atual_email, a.status_jornada, a.status_atual
    from public.alunos a
    join lateral (
      select x.id, x.registrado_em, x.lote_id
        from public.aluno_movimentacoes x
       where x.aluno_id = a.id::text
         and public.eh_tipo_acionamento(x.tipo)
       order by x.registrado_em desc, x.id desc
       limit 1) m on true
   where a.id = any(p_ids)
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < m.registrado_em);

  -- trilha ANTES de escrever (o gatilho de casos dispara junto com o UPDATE)
  insert into public._backup_dua_massiva_setembro_20261020
    (aluno_id, dua_antes, dua_depois, status_acionamento_antes, data_retorno_antes,
     retorno_origem_antes, responsavel_atual_email_antes, status_jornada_antes,
     status_atual_antes, movimentacao_id, lote_id)
  select aluno_id, dua_antes, dua_depois, status_acionamento, data_retorno,
         retorno_origem, responsavel_atual_email, status_jornada,
         status_atual, movimentacao_id, lote_id
    from _alvo_dua
  on conflict (aluno_id) do nothing;

  insert into public._backup_dua_massiva_setembro_20261020_casos (caso_id, aluno_id, dua_antes)
  select c.id, c.aluno_id, c.data_ultimo_acionamento
    from public.casos c
   where c.aluno_id in (select aluno_id from _alvo_dua)
  on conflict (caso_id) do nothing;

  -- UPDATE de UMA coluna so. Qualquer coluna a mais aqui acorda gatilho de
  -- retorno, tabulacao ou responsavel -- ver o cabecalho.
  update public.alunos a
     set data_ultimo_acionamento = t.dua_depois
    from _alvo_dua t
   where a.id = t.aluno_id;
  get diagnostics v_corrigidos = row_count;

  -- O caso acompanha o aluno, so para frente. Em producao o gatilho
  -- trg_sync_acionamento_alunos_para_casos ja fez isso no UPDATE acima; este
  -- comando entao nao acha linha. Fica explicito para a correcao nao depender
  -- de gatilho e para o teste poder provar o espelho.
  update public.casos c
     set data_ultimo_acionamento = (t.dua_depois at time zone 'America/Sao_Paulo')::date
    from _alvo_dua t
   where c.aluno_id = t.aluno_id
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < (t.dua_depois at time zone 'America/Sao_Paulo')::date);
  get diagnostics v_casos = row_count;

  -- POS-CONDICAO: nos alunos tocados, NADA alem do acionamento pode ter mudado.
  select count(*) into v_desviados
    from public.alunos a
    join _alvo_dua t on t.aluno_id = a.id
   where a.status_acionamento      is distinct from t.status_acionamento
      or a.data_retorno            is distinct from t.data_retorno
      or a.retorno_origem          is distinct from t.retorno_origem
      or a.responsavel_atual_email is distinct from t.responsavel_atual_email
      or a.status_jornada          is distinct from t.status_jornada
      or a.status_atual            is distinct from t.status_atual;

  if v_desviados > 0 then
    raise exception 'ABORTADO: % aluno(s) tiveram campo alem do acionamento alterado.', v_desviados
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'pedidos',    coalesce(array_length(p_ids, 1), 0),
    'corrigidos', v_corrigidos,
    'casos',      v_casos,
    'ja_em_dia',  coalesce(array_length(p_ids, 1), 0) - v_corrigidos);
end;
$function$;

revoke all on function public._corrige_dua_massiva_setembro(uuid[]) from public, anon, authenticated;

comment on function public._corrige_dua_massiva_setembro(uuid[]) is
  'Correcao pontual e idempotente: leva data_ultimo_acionamento ate a '
  'movimentacao de acionamento mais nova do aluno, quando o campo ficou para '
  'tras (janela 20/09-02/10 de 2026). Guarda o valor anterior em '
  '_backup_dua_massiva_setembro_20261020 e aborta se qualquer outro campo mudar.';

-- --------------------------------------------- execucao nos 11, por id exato
do $$
declare
  v_ids uuid[] := array[
    '2031900f-d2d2-4949-9119-e6b0a09e66f3',  -- 21/09, dua nulo
    'a18c692d-93ec-4ff0-8682-3d45c37c35e0',  -- 21/09, dua 10/07
    'a3af145f-4299-4dbe-b8a9-5e9310435f59',  -- 24/09, dua 02/09
    '4daaee3b-95d3-4b06-82da-95533aa18197',  -- 29/09, dua 08/09
    'd8396c91-d607-45a5-b1e2-e7cf1fa547c3',  -- 29/09, dua 02/09
    '2086ed38-ee25-45a7-8532-5d890578a14a',  -- 30/09, dua 11/09
    '8857ab6e-6260-4972-ae6c-63fc0a140184',  -- 30/09, dua 28/08
    'd9309ece-83e5-4fff-9f14-7ff3fb5a8775',  -- 30/09, dua 11/09
    'ddaf4efd-8f0a-457c-b1a6-17d0ba98cfe5',  -- 30/09, dua 17/09
    'f7eaf437-4ccd-4105-af07-299f95c1b5f8',  -- 30/09, dua 10/09
    'fae7f7ff-2937-4764-a168-3f8fb85f3d5c'   -- 30/09, dua 11/09
  ]::uuid[];
  v_res jsonb;
begin
  v_res := public._corrige_dua_massiva_setembro(v_ids);
  raise notice 'correcao dua massiva setembro: %', v_res;

  -- Teto explicito: esta migration nao pode tocar mais do que os 11 pedidos.
  if (v_res->>'corrigidos')::int > 11 then
    raise exception 'ABORTADO: corrigiu % alunos, acima do teto de 11.', v_res->>'corrigidos'
      using errcode = '55000';
  end if;
end $$;
