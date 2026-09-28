-- =============================================================================
-- PREVENTIVO — a REMESSA vira a unidade de trabalho
-- =============================================================================
--
-- MUDANÇA DE CONCEITO, pedida pela gestão em 28/09/2026: cada ação preventiva
-- começa com uma remessa NOVA, importada na hora. A remessa anterior nunca é
-- reaproveitada como carteira ativa. São até 3 ações por mês, e a atualização
-- com o Prime é manual, quando a gestão pedir.
--
-- O que já existia continua servindo: `prev_lote` É a remessa, e
-- `prev_titulo_lote` já registra qual remessa trouxe qual título. Faltavam
-- duas coisas, e é só isso que esta migration acrescenta:
--
--   1. O VALOR DO TÍTULO **NAQUELA** REMESSA. `prev_titulo.saldo_informado` é
--      o valor da PRIMEIRA entrada e nunca é reescrito — de propósito. Mas o
--      saldo do mesmo título muda de uma remessa para a outra (encargos), e o
--      resultado da ação tem de usar o valor da remessa em que o aluno FOI
--      ACIONADO. Sem isso, "valor regularizado" usaria um número de outro mês.
--
--   2. A AÇÃO PRECISA SABER DE QUAL REMESSA SAIU. `prev_acao` só apontava para
--      a carteira. Sem a remessa, não dá para comparar o que foi acionado com
--      o que voltou no relatório seguinte.
--
-- COMPARAÇÃO ENTRE REMESSAS, e o cuidado que ela exige. Um título que estava
-- na remessa anterior e não aparece na seguinte é classificado como
-- `REGULARIZADO_ENTRE_REMESSAS` — **nunca** como pagamento confirmado. A
-- definição, escrita na tela e aqui, é literal: *título que estava na remessa
-- anterior e deixou de aparecer no relatório de inadimplência seguinte*. Ele
-- pode ter sido pago, cancelado, renegociado, bolsado ou simplesmente não ter
-- entrado no recorte do relatório. A fonte não distingue, e nós não fingimos
-- que distingue.
--
-- A chave da comparação é a já validada em 28/09/2026:
-- matrícula + `Dt Vcto` + `Vcto Origem` (a `chave_arquivo` do título).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ESTRUTURA
-- -----------------------------------------------------------------------------
alter table public.prev_titulo_lote
  add column if not exists saldo_na_remessa      numeric(14,2),
  add column if not exists saldo_atualizado_na_remessa numeric(14,2),
  add column if not exists vencimento_na_remessa date;

comment on column public.prev_titulo_lote.saldo_na_remessa is
  'Saldo em aberto do título conforme O ARQUIVO DESTA remessa. É este o número que o resultado da ação usa — o valor da remessa em que o aluno foi acionado, não o da primeira vez que ele entrou na carteira.';

alter table public.prev_acao
  add column if not exists lote_id uuid references public.prev_lote(id) on delete set null;

comment on column public.prev_acao.lote_id is
  'A REMESSA de onde o público saiu. Toda ação nasce de uma remessa; sem isso não há como comparar o que foi acionado com o que voltou no relatório seguinte.';

create index if not exists prev_acao_lote_idx on public.prev_acao (lote_id);

-- -----------------------------------------------------------------------------
-- 2. IMPORTAÇÃO: gravar o valor DAQUELA remessa
-- -----------------------------------------------------------------------------
-- Mesma função da migration 20260928143843, com uma única diferença: o insert
-- em `prev_titulo_lote` passa a carregar saldo e vencimento da remessa.
create or replace function public.preventivo_lote_processar(
  p_carteira_id uuid,
  p_linhas jsonb,
  p_aplicar boolean,
  p_lote_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_carteira  public.prev_carteira%rowtype;
  v_hoje      date := public.preventivo_hoje();
  v_limite    int  := public.preventivo_limite_dias();
  v_resumo    jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select * into v_carteira from public.prev_carteira where id = p_carteira_id;
  if not found then
    raise exception 'Carteira não encontrada.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'Envie as linhas do arquivo como lista.' using errcode = '22023';
  end if;

  create temp table _prev_in on commit drop as
  select
    (ord)::int                                         as linha,
    nullif(trim(l->>'matricula'), '')                  as matricula,
    nullif(trim(l->>'documento'), '')                  as documento,
    nullif(trim(l->>'unidade'), '')                    as unidade,
    nullif(trim(l->>'contrato'), '')                   as contrato,
    nullif(trim(l->>'aluno_nome'), '')                 as aluno_nome,
    nullif(regexp_replace(coalesce(l->>'cpf',''), '\D', '', 'g'), '') as cpf,
    nullif(trim(l->>'competencia'), '')                as competencia,
    case when (l->>'vencimento') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'vencimento')::date end as vencimento,
    case when (l->>'vencimento_origem') ~ '^\d{4}-\d{2}-\d{2}$' then (l->>'vencimento_origem')::date end as vencimento_origem,
    case when (l->>'valor') ~ '^-?\d+(\.\d+)?$' then (l->>'valor')::numeric end            as valor,
    case when (l->>'saldo') ~ '^-?\d+(\.\d+)?$' then (l->>'saldo')::numeric end            as saldo,
    case when (l->>'saldo_atualizado') ~ '^-?\d+(\.\d+)?$' then (l->>'saldo_atualizado')::numeric end as saldo_atualizado,
    nullif(trim(l->>'situacao'), '')                   as situacao,
    public.preventivo_celulares(l->>'celular')         as celulares,
    public.preventivo_emails(l->>'email')              as emails,
    l                                                  as bruto
  from jsonb_array_elements(p_linhas) with ordinality as e(l, ord);

  alter table _prev_in add column celular_aluno text;
  alter table _prev_in add column email_aluno text;
  update _prev_in set
    celular_aluno = case when array_length(celulares, 1) = 1 then celulares[1] end,
    email_aluno   = case when array_length(emails, 1) = 1 then emails[1] end;

  alter table _prev_in add column chave text;
  update _prev_in set chave = coalesce(
    documento,
    coalesce(vencimento::text, '?') || '|' || coalesce(vencimento_origem::text, ''));

  alter table _prev_in add column motivo text;
  update _prev_in set motivo =
    case
      when matricula  is null then 'SEM_MATRICULA'
      when aluno_nome is null then 'SEM_NOME'
      when vencimento is null then 'VENCIMENTO_INVALIDO'
      when coalesce(valor, saldo) is null or coalesce(valor, saldo) <= 0 then 'VALOR_INVALIDO'
      when vencimento < v_carteira.venc_de or vencimento > v_carteira.venc_ate then 'FORA_DO_PERIODO'
    end;

  update _prev_in a set motivo = 'DUPLICADA_NO_ARQUIVO'
  where a.motivo is null
    and exists (select 1 from _prev_in b
                where b.motivo is null and b.matricula = a.matricula
                  and b.chave = a.chave and b.linha < a.linha);

  update _prev_in a set motivo = 'DOCUMENTO_EM_OUTRA_MATRICULA'
  where a.motivo is null and a.documento is not null
    and exists (select 1 from public.prev_titulo t
                where t.carteira_id = p_carteira_id and t.documento = a.documento
                  and t.matricula_prime <> a.matricula);

  if p_aplicar then
    if p_lote_id is null then
      raise exception 'Confirmação de importação exige o lote.' using errcode = '22023';
    end if;

    insert into public.prev_lote_recusa (lote_id, linha, motivo, dados)
    select p_lote_id, linha, motivo, bruto from _prev_in where motivo is not null;

    with gravados as (
      insert into public.prev_titulo as t (
        carteira_id, matricula_prime, documento, vencimento, vencimento_origem,
        chave_arquivo, unidade, contrato, aluno_nome, cpf, competencia,
        valor_original, saldo_informado, saldo_informado_atualizado, situacao_origem,
        celular_aluno, email_aluno, celulares_no_arquivo, emails_no_arquivo,
        lote_origem_id, lote_ultimo_id, status)
      select
        p_carteira_id, i.matricula, i.documento, i.vencimento, i.vencimento_origem,
        i.chave, i.unidade, i.contrato, i.aluno_nome, i.cpf, i.competencia,
        coalesce(i.valor, i.saldo), coalesce(i.saldo, i.valor), i.saldo_atualizado, i.situacao,
        i.celular_aluno, i.email_aluno,
        coalesce(array_length(i.celulares, 1), 0), coalesce(array_length(i.emails, 1), 0),
        p_lote_id, p_lote_id,
        case when (v_hoje - i.vencimento) > v_limite then 'FORA_DA_JANELA' else 'ATIVO' end
      from _prev_in i where i.motivo is null
      on conflict (carteira_id, matricula_prime, chave_arquivo) do update set
        aluno_nome     = excluded.aluno_nome,
        cpf            = coalesce(excluded.cpf, t.cpf),
        documento      = coalesce(excluded.documento, t.documento),
        unidade        = coalesce(excluded.unidade, t.unidade),
        contrato       = coalesce(excluded.contrato, t.contrato),
        competencia    = coalesce(excluded.competencia, t.competencia),
        vencimento     = excluded.vencimento,
        vencimento_origem = coalesce(excluded.vencimento_origem, t.vencimento_origem),
        valor_original = excluded.valor_original,
        saldo_informado_atualizado = coalesce(excluded.saldo_informado_atualizado, t.saldo_informado_atualizado),
        situacao_origem= coalesce(excluded.situacao_origem, t.situacao_origem),
        celular_aluno  = coalesce(excluded.celular_aluno, t.celular_aluno),
        email_aluno    = coalesce(excluded.email_aluno, t.email_aluno),
        celulares_no_arquivo = greatest(excluded.celulares_no_arquivo, t.celulares_no_arquivo),
        emails_no_arquivo    = greatest(excluded.emails_no_arquivo, t.emails_no_arquivo),
        lote_ultimo_id = excluded.lote_ultimo_id,
        atualizado_em  = now()
      returning t.id, t.matricula_prime, t.chave_arquivo, (xmax = 0) as nasceu
    )
    -- O VALOR DAQUELA REMESSA. É a única diferença em relação à versão de
    -- 20260928143843: sem isto, o resultado da ação usaria o saldo da primeira
    -- entrada do título na carteira, que é de outro mês.
    insert into public.prev_titulo_lote (
      titulo_id, lote_id, primeira_vez, saldo_na_remessa,
      saldo_atualizado_na_remessa, vencimento_na_remessa)
    select g.id, p_lote_id, g.nasceu,
           coalesce(i.saldo, i.valor), i.saldo_atualizado, i.vencimento
      from gravados g
      join _prev_in i
        on i.motivo is null and i.matricula = g.matricula_prime and i.chave = g.chave_arquivo
    on conflict (titulo_id, lote_id) do update set
      saldo_na_remessa            = excluded.saldo_na_remessa,
      saldo_atualizado_na_remessa = excluded.saldo_atualizado_na_remessa,
      vencimento_na_remessa       = excluded.vencimento_na_remessa;
  end if;

  select jsonb_build_object(
    'linhas_lidas',        (select count(*) from _prev_in),
    'linhas_aceitas',      (select count(*) from _prev_in where motivo is null),
    'linhas_recusadas',    (select count(*) from _prev_in where motivo is not null),
    'alunos',              (select count(distinct matricula) from _prev_in where motivo is null),
    'titulos',             (select count(*) from _prev_in where motivo is null),
    'valor_total',         (select coalesce(sum(coalesce(saldo, valor)), 0) from _prev_in where motivo is null),
    'novos',               (select count(*) from _prev_in i where i.motivo is null
                              and not exists (select 1 from public.prev_titulo t
                                              where t.carteira_id = p_carteira_id
                                                and t.matricula_prime = i.matricula
                                                and t.chave_arquivo = i.chave)),
    'atualizados',         (select count(*) from _prev_in i where i.motivo is null
                              and exists (select 1 from public.prev_titulo t
                                          where t.carteira_id = p_carteira_id
                                            and t.matricula_prime = i.matricula
                                            and t.chave_arquivo = i.chave)),
    'sem_identificador_de_titulo', (select count(*) from _prev_in where motivo is null and documento is null),
    'mesmo_vencimento_no_arquivo', (select count(*) from _prev_in a where a.motivo is null
                                      and exists (select 1 from _prev_in b where b.motivo is null
                                                  and b.matricula = a.matricula and b.vencimento = a.vencimento
                                                  and b.chave <> a.chave)),
    'fora_da_janela',      (select count(*) from _prev_in where motivo is null and (v_hoje - vencimento) > v_limite),
    'com_whatsapp',        (select count(*) from _prev_in where motivo is null and celular_aluno is not null),
    'com_email',           (select count(*) from _prev_in where motivo is null and email_aluno is not null),
    'para_revisao',        (select count(*) from _prev_in where motivo is null
                              and (coalesce(array_length(celulares,1),0) <> 1
                                or coalesce(array_length(emails,1),0) <> 1)),
    'sem_celular_valido',  (select count(*) from _prev_in where motivo is null and coalesce(array_length(celulares,1),0) = 0),
    'celular_ambiguo',     (select count(*) from _prev_in where motivo is null and coalesce(array_length(celulares,1),0) > 1),
    'sem_email_valido',    (select count(*) from _prev_in where motivo is null and coalesce(array_length(emails,1),0) = 0),
    'email_multiplo',      (select count(*) from _prev_in where motivo is null and coalesce(array_length(emails,1),0) > 1),
    'celular_compartilhado', (select count(*) from _prev_in a where a.motivo is null and a.celular_aluno is not null
                                and exists (select 1 from _prev_in b where b.motivo is null
                                            and b.celular_aluno = a.celular_aluno and b.matricula <> a.matricula)),
    'recusas_por_motivo',  (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                              from (select motivo, count(*) n from _prev_in where motivo is not null group by 1) r),
    'exemplos_recusa',     (select coalesce(jsonb_agg(jsonb_build_object('linha', linha, 'motivo', motivo)), '[]'::jsonb)
                              from (select linha, motivo from _prev_in where motivo is not null order by linha limit 20) x)
  ) into v_resumo;

  return v_resumo;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. A REMESSA: resumo e histórico
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_remessa_resumo(p_lote_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', l.id, 'carteira_id', l.carteira_id, 'nome', l.nome,
    'arquivo', l.arquivo_nome,
    'importada_em', l.criado_em,
    'importada_por', l.criado_por,
    'alunos',  (select count(distinct t.matricula_prime) from public.prev_titulo_lote tl
                  join public.prev_titulo t on t.id = tl.titulo_id where tl.lote_id = l.id),
    'titulos', (select count(*) from public.prev_titulo_lote tl where tl.lote_id = l.id),
    'valor',   (select coalesce(sum(tl.saldo_na_remessa), 0) from public.prev_titulo_lote tl where tl.lote_id = l.id),
    'whatsapp_disponivel', (select count(*) from public.prev_titulo_lote tl
                              join public.prev_titulo t on t.id = tl.titulo_id
                             where tl.lote_id = l.id and t.celular_aluno is not null),
    'email_disponivel',    (select count(*) from public.prev_titulo_lote tl
                              join public.prev_titulo t on t.id = tl.titulo_id
                             where tl.lote_id = l.id and t.email_aluno is not null),
    -- "para revisão" é contato que a linha do arquivo não resolveu sozinha:
    -- nenhum contato válido, ou mais de um diferente (e aí não se escolhe).
    'para_revisao', (select count(*) from public.prev_titulo_lote tl
                       join public.prev_titulo t on t.id = tl.titulo_id
                      where tl.lote_id = l.id
                        and (t.celulares_no_arquivo <> 1 or t.emails_no_arquivo <> 1)),
    'recusas', (select count(*) from public.prev_lote_recusa r where r.lote_id = l.id),
    'recusas_por_motivo', (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                             from (select motivo, count(*) n from public.prev_lote_recusa
                                    where lote_id = l.id group by 1) x),
    'resumo_da_importacao', l.resumo,
    'acoes', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', a.id, 'nome', a.nome, 'canal', a.canal, 'estado', a.estado,
                 'criada_em', a.criada_em) order by a.criada_em), '[]'::jsonb)
                from public.prev_acao a where a.lote_id = l.id)
  ) into v from public.prev_lote l where l.id = p_lote_id;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. COMPARAÇÃO ENTRE REMESSAS
-- -----------------------------------------------------------------------------
-- Compara uma remessa com a IMEDIATAMENTE ANTERIOR da mesma carteira, pela
-- `chave_arquivo` (matrícula + Dt Vcto + Vcto Origem).
--
-- REGULARIZADO_ENTRE_REMESSAS NÃO É PAGAMENTO CONFIRMADO. É, literalmente,
-- "estava na remessa anterior e não está nesta". Pode ser pagamento, mas
-- também cancelamento, renegociação, bolsa ou mudança do recorte do relatório.
-- A fonte não distingue.
create or replace function public.preventivo_remessa_comparar(p_lote_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb; v_carteira uuid; v_anterior uuid; v_criado timestamptz;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select carteira_id, criado_em into v_carteira, v_criado
    from public.prev_lote where id = p_lote_id;
  if v_carteira is null then
    raise exception 'Remessa não encontrada.' using errcode = '22023';
  end if;

  select id into v_anterior from public.prev_lote
   where carteira_id = v_carteira and criado_em < v_criado and status = 'CONFIRMADO'
   order by criado_em desc limit 1;

  if v_anterior is null then
    return jsonb_build_object(
      'remessa', p_lote_id, 'remessa_anterior', null,
      'primeira_remessa', true,
      'observacao', 'Primeira remessa da carteira: não há anterior para comparar.');
  end if;

  select jsonb_build_object(
    'remessa', p_lote_id,
    'remessa_anterior', v_anterior,
    'primeira_remessa', false,
    'continua_em_aberto', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from public.prev_titulo_lote ant
       where ant.lote_id = v_anterior
         and exists (select 1 from public.prev_titulo_lote novo
                      where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    -- o nome que a gestão pediu na tela
    'regularizados_entre_remessas', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from public.prev_titulo_lote ant
       where ant.lote_id = v_anterior
         and not exists (select 1 from public.prev_titulo_lote novo
                          where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'novos_na_remessa', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(novo.saldo_na_remessa), 0))
        from public.prev_titulo_lote novo
       where novo.lote_id = p_lote_id
         and not exists (select 1 from public.prev_titulo_lote ant
                          where ant.lote_id = v_anterior and ant.titulo_id = novo.titulo_id)),
    'definicao', 'REGULARIZADO ENTRE REMESSAS = título que estava na remessa anterior e deixou de aparecer no relatório de inadimplência seguinte. NÃO é pagamento confirmado: pode ser pagamento, cancelamento, renegociação, bolsa ou mudança do recorte do relatório. A fonte não distingue.'
  ) into v;
  return v;
end;
$$;

create or replace function public.preventivo_remessa_titulos(
  p_lote_id uuid, p_classificacao text default null, p_limite int default 2000)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb; v_carteira uuid; v_anterior uuid; v_criado timestamptz;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select carteira_id, criado_em into v_carteira, v_criado from public.prev_lote where id = p_lote_id;
  select id into v_anterior from public.prev_lote
   where carteira_id = v_carteira and criado_em < v_criado and status = 'CONFIRMADO'
   order by criado_em desc limit 1;

  select coalesce(jsonb_agg(x order by x->>'aluno'), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'titulo_id', t.id, 'aluno', t.aluno_nome, 'matricula', t.matricula_prime,
      'vencimento', coalesce(tl.vencimento_na_remessa, t.vencimento),
      'vencimento_origem', t.vencimento_origem,
      'saldo_na_remessa', tl.saldo_na_remessa,
      'classificacao', c.classificacao
    ) x
    from (
      -- títulos da remessa nova
      select tl.titulo_id, tl.lote_id,
             case when v_anterior is null then 'NOVO_NA_REMESSA'
                  when exists (select 1 from public.prev_titulo_lote a
                                where a.lote_id = v_anterior and a.titulo_id = tl.titulo_id)
                  then 'CONTINUA_EM_ABERTO' else 'NOVO_NA_REMESSA' end as classificacao
        from public.prev_titulo_lote tl where tl.lote_id = p_lote_id
      union all
      -- títulos que estavam na anterior e sumiram
      select a.titulo_id, a.lote_id, 'REGULARIZADO_ENTRE_REMESSAS'
        from public.prev_titulo_lote a
       where v_anterior is not null and a.lote_id = v_anterior
         and not exists (select 1 from public.prev_titulo_lote n
                          where n.lote_id = p_lote_id and n.titulo_id = a.titulo_id)
    ) c
    join public.prev_titulo_lote tl on tl.titulo_id = c.titulo_id and tl.lote_id = c.lote_id
    join public.prev_titulo t on t.id = c.titulo_id
    where p_classificacao is null or c.classificacao = p_classificacao
    limit greatest(1, least(coalesce(p_limite, 2000), 10000))
  ) q;
  return v;
end;
$$;

create or replace function public.preventivo_remessas(p_carteira_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(
      public.preventivo_remessa_resumo(l.id)
      || jsonb_build_object('comparacao', public.preventivo_remessa_comparar(l.id))
      order by l.criado_em desc), '[]'::jsonb) into v
    from public.prev_lote l
   where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO';
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. AÇÃO: nasce de uma remessa
-- -----------------------------------------------------------------------------
-- Mesma função da migration 20260928143943, com duas diferenças: recebe a
-- REMESSA e restringe o público aos títulos daquela remessa.
create or replace function public.preventivo_acao_preparar(
  p_carteira_id uuid, p_nome text, p_canal text, p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_acao uuid; v_sinc uuid; v_sinc_em timestamptz; v_hoje date := public.preventivo_hoje();
  v_lote uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal inválido.' using errcode = '22023';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Dê um nome à ação.' using errcode = '22023';
  end if;

  -- A REMESSA. Se a gestão não disser qual, é a última confirmada da carteira
  -- — nunca uma carteira inteira acumulada, que é justamente o que o fluxo
  -- novo não quer.
  v_lote := nullif(p_filtros->>'lote_id', '')::uuid;
  if v_lote is null then
    select id into v_lote from public.prev_lote
     where carteira_id = p_carteira_id and status = 'CONFIRMADO'
     order by criado_em desc limit 1;
  end if;
  if v_lote is null then
    raise exception 'Não há remessa importada nesta carteira. Toda ação nasce de uma remessa.'
      using errcode = '22023';
  end if;

  select id, concluido_em into v_sinc, v_sinc_em from public.prev_sinc
   where status = 'CONCLUIDA' and (carteira_id = p_carteira_id or carteira_id is null)
   order by concluido_em desc limit 1;

  insert into public.prev_acao (carteira_id, lote_id, nome, canal, filtros,
                                sinc_referencia_id, sinc_referencia_em, criada_por)
  values (p_carteira_id, v_lote, trim(p_nome), p_canal,
          coalesce(p_filtros, '{}'::jsonb) || jsonb_build_object('lote_id', v_lote),
          v_sinc, v_sinc_em, lower(coalesce(auth.jwt() ->> 'email', 'sistema')))
  returning id into v_acao;

  insert into public.prev_acao_destinatario (acao_id, titulo_id, matricula, aluno_nome, contato, incluido, motivo)
  select v_acao, t.id, t.matricula_prime, t.aluno_nome,
         case when p_canal = 'WHATSAPP' then t.celular_aluno else t.email_aluno end,
         false, null
    from public.prev_titulo t
    join public.prev_titulo_lote tl on tl.titulo_id = t.id and tl.lote_id = v_lote
   where t.carteira_id = p_carteira_id
     and (p_filtros->>'venc_de' is null  or t.vencimento >= (p_filtros->>'venc_de')::date)
     and (p_filtros->>'venc_ate' is null or t.vencimento <= (p_filtros->>'venc_ate')::date);

  update public.prev_acao_destinatario d
     set motivo = m.motivo, incluido = (m.motivo is null)
    from (
      select d2.id,
        case
          when t.status <> 'ATIVO'                      then 'FORA_DA_JANELA_PREVENTIVA'
          when (v_hoje - t.vencimento) > public.preventivo_limite_dias() then 'FORA_DA_JANELA_PREVENTIVA'
          when t.valor_fonte is not null and t.valor_fonte <= 0 then 'VALOR_NA_FONTE_ZERADO'
          when upper(coalesce(t.situacao_origem, '')) like '%CANCEL%' then 'SITUACAO_CANCELADA_NA_ORIGEM'
          when p_canal = 'WHATSAPP' and t.celulares_no_arquivo > 1 then 'CELULAR_AMBIGUO_NO_ARQUIVO'
          when p_canal = 'WHATSAPP' and t.celular_aluno is null then 'SEM_CELULAR_VALIDO'
          when p_canal = 'EMAIL'    and t.emails_no_arquivo > 1
               and coalesce((p_filtros->>'usar_primeiro_email')::boolean, false) is not true
                                                                then 'EMAIL_MULTIPLO_NO_ARQUIVO'
          when p_canal = 'EMAIL'    and t.email_aluno is null   then 'SEM_EMAIL_VALIDO'
        end as motivo
      from public.prev_acao_destinatario d2
      join public.prev_titulo t on t.id = d2.titulo_id
     where d2.acao_id = v_acao) m
   where d.id = m.id;

  update public.prev_acao_destinatario d
     set incluido = false, motivo = 'CONTATO_COMPARTILHADO_COM_OUTRO_ALUNO'
   where d.acao_id = v_acao and d.incluido and d.contato is not null
     and exists (select 1 from public.prev_acao_destinatario o
                  where o.acao_id = v_acao and o.incluido and o.contato = d.contato
                    and o.matricula <> d.matricula);

  update public.prev_acao_destinatario d
     set incluido = false, motivo = 'OUTRO_TITULO_DO_MESMO_ALUNO_JA_NO_PUBLICO'
    from (select d2.id,
                 row_number() over (partition by d2.matricula
                                    order by t.vencimento, t.chave_arquivo) rn
            from public.prev_acao_destinatario d2
            join public.prev_titulo t on t.id = d2.titulo_id
           where d2.acao_id = v_acao and d2.incluido) r
   where d.id = r.id and r.rn > 1;

  return public.preventivo_acao_resumo(v_acao);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. RESULTADO DA AÇÃO
-- -----------------------------------------------------------------------------
-- O que foi acionado, e o que aconteceu com esses títulos na remessa SEGUINTE.
-- O valor usa `saldo_na_remessa` da remessa em que o aluno FOI ACIONADO — é
-- essa a regra que a gestão pediu.
create or replace function public.preventivo_acao_resultado(p_acao_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v jsonb; v_lote uuid; v_carteira uuid; v_criado timestamptz; v_seguinte uuid;
  v_titulos int; v_regularizados int;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select a.lote_id, a.carteira_id into v_lote, v_carteira
    from public.prev_acao a where a.id = p_acao_id;
  if v_lote is null then
    return jsonb_build_object('acao', p_acao_id, 'sem_remessa', true,
      'observacao', 'Ação sem remessa vinculada: não há o que comparar.');
  end if;

  select criado_em into v_criado from public.prev_lote where id = v_lote;
  select id into v_seguinte from public.prev_lote
   where carteira_id = v_carteira and criado_em > v_criado and status = 'CONFIRMADO'
   order by criado_em limit 1;

  select count(*) into v_titulos
    from public.prev_acao_destinatario d where d.acao_id = p_acao_id and d.incluido;

  select count(*) into v_regularizados
    from public.prev_acao_destinatario d
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select jsonb_build_object(
    'acao', p_acao_id,
    'remessa', v_lote,
    'remessa_seguinte', v_seguinte,
    'alunos_acionados', (select count(distinct d.matricula) from public.prev_acao_destinatario d
                          where d.acao_id = p_acao_id and d.incluido),
    'titulos_acionados', v_titulos,
    'valor_acionado', (select coalesce(sum(tl.saldo_na_remessa), 0)
                         from public.prev_acao_destinatario d
                         join public.prev_titulo_lote tl
                           on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
                        where d.acao_id = p_acao_id and d.incluido),
    'continuam_em_aberto', case when v_seguinte is null then null else v_titulos - v_regularizados end,
    'regularizados_entre_remessas', case when v_seguinte is null then null else v_regularizados end,
    'valor_regularizado', case when v_seguinte is null then null else (
        select coalesce(sum(tl.saldo_na_remessa), 0)
          from public.prev_acao_destinatario d
          join public.prev_titulo_lote tl
            on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
         where d.acao_id = p_acao_id and d.incluido
           and not exists (select 1 from public.prev_titulo_lote n
                            where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id)) end,
    'taxa_regularizacao', case when v_seguinte is null or v_titulos = 0 then null
                               else round((v_regularizados::numeric / v_titulos) * 100, 1) end,
    'aguardando_proxima_remessa', (v_seguinte is null),
    'definicao', 'Regularizado entre remessas = o título acionado não voltou no relatório de inadimplência seguinte. NÃO é pagamento confirmado. O valor usa o saldo do título NA REMESSA em que ele foi acionado.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. PRIVILÉGIOS
-- -----------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'preventivo_remessa_resumo(uuid)',
    'preventivo_remessa_comparar(uuid)',
    'preventivo_remessa_titulos(uuid, text, integer)',
    'preventivo_remessas(uuid)',
    'preventivo_acao_resultado(uuid)',
    'preventivo_acao_preparar(uuid, text, text, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  -- interna: continua só para service_role
  execute 'revoke all on function public.preventivo_lote_processar(uuid, jsonb, boolean, uuid) from public';
  execute 'grant execute on function public.preventivo_lote_processar(uuid, jsonb, boolean, uuid) to service_role';
end
$$;
