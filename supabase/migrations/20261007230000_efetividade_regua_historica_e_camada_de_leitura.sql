-- EFETIVIDADE -- dois ajustes finais, nenhuma arquitetura reaberta.
--
-- ===========================================================================
-- AJUSTE 1: A REGUA DO SALDO EM ABERTO DE 2024/2025
-- ===========================================================================
-- MEDIDO em producao em 07/10/2026 (somente leitura): a composicao academica
-- publicada na versao anterior deste PR fechava, ao centavo, com o balde
-- "em aberto" das SEIS LINHAS -- R$ 4.995.079,31 em 2024. Mas o saldo que a
-- gestao chama de oficial e outro: o de `carteira_saldo_historico_por_ano()`,
-- medido no mesmo instante em R$ 3.674.539,61 / 1.975 alunos / 6.366
-- mensalidades. Sao R$ 1,32 mi de diferenca -- nao e deriva, e regua diferente.
--
-- POR QUE AS DUAS EXISTEM, E POR QUE NAO SE TENTA IGUALA-LAS. As seis linhas
-- medem "saldo sem acordo ativo" sobre a carteira que entrou, de proposito sem
-- filtro de portador: conversao e historia, e acordo quebrado devolve o titulo.
-- A regua historica mede a exposicao de HOJE e exclui o que nao e mais
-- cobravel por nos: portador diferente de 195, titulo liquidado na Prime mais
-- de 30 dias apos o vencimento, CPF no portador 166 sem acordo ativo,
-- confirmacao de pagamento pendente, caso cancelado ou juridico, e aluno cujos
-- pagamentos desde 01/07/2026 cobrem todo o aberto dele. Sao duas perguntas
-- diferentes, as duas validadas. A tela passa a dizer qual e qual:
--   Universo recebido      -> regua das seis linhas (o que entrou em cobranca)
--   Saldo em aberto atual  -> regua historica oficial (exposicao de hoje)
--   Composicao academica   -> decomposicao do SALDO EM ABERTO ATUAL
--
-- O universo abaixo e COPIADO VERBATIM de
-- `carteira_saldo_historico_recalcular()` -- as CTEs `pag_titulo`, `m166`,
-- `acordo_ativo`, `conf`, `caso_fora`, `pago_julho`, `t`, `cand` e `aberto`,
-- sem uma virgula de diferenca nas clausulas. Conferido em 07/10/2026: esta
-- replicacao devolve 1.975 / 6.366 / R$ 3.674.539,61 em 2024 e 2.880 / 10.467 /
-- R$ 6.212.645,40 em 2025 -- identicos, ao centavo, ao bloco `aberto` daquela
-- funcao. As seis linhas NAO foram tocadas.
--
-- AS TRES CONTAGENS SAO AS DAQUELA FUNCAO, nao as nossas:
--   alunos  = count(distinct cpf)   -- CPF, nao aluno_id
--   titulos = count(*)              -- linha, nao titulo distinto
--   valor   = sum(saldo)            -- saldo, nao valor_original
-- Trocar qualquer uma faria o total divergir do oficial.
--
-- POR QUE O STATUS E DERIVADO POR CPF. A regua conta alunos por CPF, mas a
-- situacao academica mora em `alunos`, por aluno_id. Se um CPF aparecesse com
-- dois aluno_id de situacoes diferentes, ele contaria em duas linhas e a soma
-- passaria do total. MEDIDO em 07/10/2026 no universo aberto de 2024+2025:
-- ZERO CPFs com mais de uma situacao. Ainda assim o status e resolvido por CPF
-- (`min()` como desempate deterministico), para que a invariante seja garantida
-- por CONSTRUCAO e nao por sorte do dado -- e `conferencia` mede as tres a cada
-- chamada.
--
-- ===========================================================================
-- AJUSTE 2: CAMADA RAPIDA DE LEITURA
-- ===========================================================================
-- MEDIDO em producao em 07/10/2026, como `authenticated`, cujo
-- `statement_timeout` e 8s (conferido em `pg_roles`):
--   carteira_safra_situacoes('2026','1') ... 34.589 ms -> ESTOURA o teto. A
--     interrupcao acontece DENTRO de `carteira_2026_1_classificar`, que custou
--     20.888 ms sozinha num Function Scan. Ou seja: o cartao das seis linhas de
--     2026/1 JA FALHA em producao hoje, antes deste PR.
--   carteira_safra_situacoes('2024') .... 1.152 ms quente, mas ESTOUROU na
--     passada fria. Derrama ~15 MB em disco num HashAggregate sobre 400.693
--     linhas de `prime_titulo_semestre`.
--   composicao 2026/1 .................. 21.312 ms, dos quais 20.888 ms sao o
--     classificador. O join novo a `alunos` e index scan: ~0,4 s no total.
--
-- O GARGALO E PRE-EXISTENTE e nao foi introduzido por este PR. Conforme a
-- regra, `carteira_2026_1_classificar()` NAO foi reescrita nem otimizada por
-- tentativa e erro: ela segue intacta e segue sendo a FONTE DA VERDADE.
--
-- O DESENHO E O QUE ESTE CRM JA USA para agregado caro -- o mesmo de
-- `carteira_saldo_historico_snapshot` (job horario, ~25 s) e de
-- `carteira_academico_perfil_snapshot`: tabela de fotografia, rotina que
-- reconstroi FORA da requisicao, tela que le.
--   * a fonte viva continua sendo a origem da verdade; o snapshot so a copia;
--   * nenhuma regra financeira muda -- o recalculo chama as MESMAS funcoes;
--   * `gerado_em` e guardado e a tela mostra;
--   * o front so le resultado pronto (`*_ler`), nunca a funcao pesada;
--   * "Atualizar dados" refaz a LEITURA do snapshot disponivel; nao dispara
--     reconstrucao pesada sincrona;
--   * sem polling e sem realtime: a rotina horaria reconstroi, a tela refaz a
--     leitura nos pontos definidos.
--
-- NAO TOCADO: `carteira_2026_1_classificar`, `carteira_safra_situacoes`,
-- `carteira_saldo_historico_*`, `carteira_academico_perfil_*`, o fluxo
-- `EM_CONFIRMACAO`, as RPCs da Conferencia Prime, `carteira_2026_2_*` e as
-- acoes da Fila Unica.
--
-- Reversivel: supabase/rollbacks/20261007230000_*.rollback.sql

-- ===========================================================================
-- 1. A COMPOSICAO PASSA A USAR A REGUA HISTORICA EM 2024/2025
-- ===========================================================================
create or replace function public.carteira_em_aberto_por_status_academico(
  p_ano      text,
  p_semestre text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_out jsonb;
  v_ano text := nullif(btrim(coalesce(p_ano, '')), '');
  v_sem text := nullif(btrim(coalesce(p_semestre, '')), '');
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_ano is null then
    raise exception 'Informe o ano.' using errcode = '22023';
  end if;

  if v_ano = '2026' and v_sem = '2' then
    raise exception '2026/2 nao tem fonte academica equivalente; status academico nao se aplica a esta safra.'
      using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------ 2026/1
  -- Inalterado: em 2026/1 o universo oficial do aberto JA e inadimplencia +
  -- em validacao, pela regra da safra, e a composicao ja fechava 0,00 em valor,
  -- 0 em titulos e 0 em alunos (medido em producao em 07/10/2026).
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    abertos as (
      select c.aluno_id, c.titulo_id, (c.inadimplencia + c.em_validacao) as valor
        from c
       where c.inadimplencia + c.em_validacao > 0
    ),
    porstatus as (
      select coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)') as status,
             a.aluno_id, a.titulo_id, a.valor
        from abertos a
        left join public.alunos al on al.id = a.aluno_id
    ),
    linhas as (
      select status,
             count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from porstatus group by status
    ),
    tot as (
      select count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from abertos
    ),
    fonte as (
      select max(al.academico_atualizado_em) as atualizado_em
        from (select distinct aluno_id from abertos) u
        join public.alunos al on al.id = u.aluno_id
    )
    select jsonb_build_object(
      'recorte',  '2026/1',
      'natureza', 'CARTEIRA_CONSOLIDADA',
      'fonte',    'carteira_2026_1_classificar() ao vivo',
      'universo_em_aberto', 'inadimplencia + em_validacao',
      'regua', 'classificacao da safra 2026/1',
      'gerado_em', now(),
      'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                          'valor', coalesce(valor, 0)) from tot),
      'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                    'status', status, 'alunos', alunos,
                    'titulos', titulos, 'valor', valor)
                    order by valor desc, status), '[]'::jsonb) from linhas),
      'conferencia', (select jsonb_build_object(
                    'total_valor',      coalesce(t.valor, 0),
                    'soma_das_linhas',  coalesce((select round(sum(valor), 2) from linhas), 0),
                    'diferenca',        round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2),
                    'fecha',            round(coalesce(t.valor, 0)
                                              - coalesce((select sum(valor) from linhas), 0), 2) = 0,
                    'titulos_total',    t.titulos,
                    'titulos_soma',     coalesce((select sum(titulos) from linhas), 0),
                    'alunos_total',     t.alunos,
                    'alunos_soma',      coalesce((select sum(alunos) from linhas), 0))
                    from tot t),
      'fonte_academica', (select jsonb_build_object(
                    'importacao_atualizada_em', atualizado_em) from fonte)
    ) into v_out;
    return v_out;
  end if;

  -- --------------------------------------------------------------- 2024/2025
  if v_ano not in ('2024', '2025') then
    raise exception 'Safra sem regua definida: %. Use 2024, 2025 ou 2026/1.', v_ano
      using errcode = '22023';
  end if;

  -- REGUA HISTORICA OFICIAL -- copia verbatim de carteira_saldo_historico_recalcular().
  with pag_titulo as materialized (
    select distinct titulo_numero b from public.pagamentos where coalesce(titulo_numero,'') <> ''
  ),
  m166 as materialized (
    select distinct lpad(regexp_replace(cpf, '\D', '', 'g'), 11, '0') cpf
      from public.prime_portador_membro where portador = 166
  ),
  acordo_ativo as materialized (
    select distinct aluno_id from public.acordos where status = 'ATIVO' and aluno_id is not null
  ),
  conf as materialized (
    select distinct aluno_id from public.solicitacoes_confirmacao_pagamento
     where status = 'AGUARDANDO_CONFIRMACAO'
  ),
  caso_fora as materialized (
    select distinct aluno_id from public.casos
     where public.normalizar_status_acionamento(coalesce(status_atual, status_acionamento, status_jornada))
           = any(array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'])
  ),
  pago_julho as materialized (
    select aluno_id, sum(valor_pago) pago from public.pagamentos
     where data_pagamento >= date '2026-07-01' and aluno_id is not null group by 1
  ),
  t as materialized (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(nullif(t.cpf,''), al.cpf, ''), '\D', '', 'g'), 11, '0') cpf,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           t.situacao, t.status, t.vencimento, t.origem_liquidacao, t.acordo_id,
           ts.semestre, left(ts.semestre, 4) ano,
           case when ex.boleto is null then ts.carrier_id
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.portador
                else ts.carrier_id end portador,
           case when ex.boleto is null then ts.liquidado_em
                when ts.boleto is null or ex.coletado_em >= ts.coletado_em then ex.liquidado_em
                else ts.liquidado_em end liq,
           (t.acordo_id is not null
            or exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id)) negociado,
           exists (select 1 from public.parcelas p where p.boleto = t.documento) eh_boleto_de_parcela,
           (pg.b is not null) tem_pagamento_no_titulo
      from public.acordos_titulos t
      left join public.alunos al on al.id = t.aluno_id
      left join lateral (select s.semestre, s.carrier_id, s.liquidado_em, s.coletado_em, s.boleto
                           from public.prime_titulo_semestre s where s.boleto = t.documento limit 1) ts on true
      left join lateral (select e.portador, e.liquidado_em, e.coletado_em, e.boleto
                           from public.prime_extrato e where e.boleto = t.documento limit 1) ex on true
      left join pag_titulo pg on pg.b = t.documento
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
  ),
  cand as materialized (
    select *, sum(saldo) over (partition by aluno_id) devido_total
      from t
     where upper(coalesce(situacao,'')) = 'ABERTO'
       and lower(coalesce(status,'')) = 'em_aberto'
       and not negociado
       and acordo_id is null
       and not eh_boleto_de_parcela
       and not tem_pagamento_no_titulo
       and origem_liquidacao is null
       and saldo > 0
       and portador = 195
       and not coalesce(liq > vencimento + 30, false)
       and (semestre in ('2024/1','2024/2','2025/1','2025/2') or semestre is null)
  ),
  aberto as materialized (
    select c.*
      from cand c
      left join m166 m on m.cpf = c.cpf
      left join acordo_ativo aa on aa.aluno_id = c.aluno_id
      left join conf cf on cf.aluno_id = c.aluno_id::text
      left join caso_fora cx on cx.aluno_id = c.aluno_id
      left join pago_julho pj on pj.aluno_id = c.aluno_id
     where not ((m.cpf is not null and aa.aluno_id is null)
                or cf.aluno_id is not null
                or cx.aluno_id is not null
                or coalesce(pj.pago, 0) >= c.devido_total)
  ),
  -- Recorte do ano pedido. `ano is not null` e da funcao oficial: titulo sem
  -- serie da Prime nao entra em ano nenhum (ele vive no bloco `sem_semestre`).
  ano_pedido as (
    select * from aberto where ano = v_ano and ano is not null
  ),
  -- UM status por CPF, deterministico. Ver o cabecalho: medido ZERO CPF com
  -- mais de uma situacao, e ainda assim resolvido por CPF para a invariante ser
  -- por construcao.
  cpf_status as (
    select a.cpf,
           min(coalesce(nullif(btrim(al.situacao_academica), ''), '(sem situação importada)')) as status
      from ano_pedido a
      left join public.alunos al on al.id = a.aluno_id
     group by a.cpf
  ),
  linhas as (
    select s.status,
           count(distinct a.cpf)  as alunos,
           count(*)               as titulos,
           round(sum(a.saldo), 2) as valor
      from ano_pedido a
      join cpf_status s on s.cpf = a.cpf
     group by s.status
  ),
  tot as (
    select count(distinct cpf)  as alunos,
           count(*)             as titulos,
           round(sum(saldo), 2) as valor
      from ano_pedido
  ),
  fonte as (
    select max(al.academico_atualizado_em) as atualizado_em
      from (select distinct aluno_id from ano_pedido) u
      join public.alunos al on al.id = u.aluno_id
  )
  select jsonb_build_object(
    'recorte',  v_ano,
    'natureza', 'COBERTURA_HISTORICA',
    'fonte',    'mesma regua de carteira_saldo_historico_por_ano().aberto, ao vivo',
    'universo_em_aberto', 'saldo em aberto atual (regua historica oficial)',
    'regua', 'carteira_saldo_historico_por_ano().aberto',
    'gerado_em', now(),
    'total', (select jsonb_build_object('alunos', alunos, 'titulos', titulos,
                                        'valor', coalesce(valor, 0)) from tot),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                  'status', status, 'alunos', alunos,
                  'titulos', titulos, 'valor', valor)
                  order by valor desc, status), '[]'::jsonb) from linhas),
    'conferencia', (select jsonb_build_object(
                  'total_valor',     coalesce(t.valor, 0),
                  'soma_das_linhas', coalesce((select round(sum(valor), 2) from linhas), 0),
                  'diferenca',       round(coalesce(t.valor, 0)
                                           - coalesce((select sum(valor) from linhas), 0), 2),
                  'fecha',           round(coalesce(t.valor, 0)
                                           - coalesce((select sum(valor) from linhas), 0), 2) = 0
                                     and t.titulos = coalesce((select sum(titulos) from linhas), 0)
                                     and t.alunos  = coalesce((select sum(alunos) from linhas), 0),
                  'titulos_total',   t.titulos,
                  'titulos_soma',    coalesce((select sum(titulos) from linhas), 0),
                  'alunos_total',    t.alunos,
                  'alunos_soma',     coalesce((select sum(alunos) from linhas), 0))
                  from tot t),
    'fonte_academica', (select jsonb_build_object(
                  'importacao_atualizada_em', atualizado_em) from fonte)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.carteira_em_aberto_por_status_academico(text, text) is
  'Decomposicao do SALDO EM ABERTO ATUAL por situacao academica real. Em 2024/2025 o '
  'universo e a regua historica oficial -- copia verbatim das CTEs de '
  'carteira_saldo_historico_recalcular(), com alunos por count(distinct cpf), titulos '
  'por count(*) e valor por sum(saldo) -- e NAO o balde em_aberto das seis linhas, que '
  'e regua mais ampla (R$ 4,99 mi contra R$ 3,67 mi em 2024, medido em 07/10/2026). Em '
  '2026/1 segue sendo inadimplencia + em_validacao. Fecha em valor, titulos E alunos '
  'por construcao, e `conferencia` mede as tres a cada chamada. SO LEITURA.';

revoke all on function public.carteira_em_aberto_por_status_academico(text, text) from public, anon;
grant execute on function public.carteira_em_aberto_por_status_academico(text, text) to authenticated, service_role;


-- ===========================================================================
-- 2. A CAMADA DE LEITURA -- as tabelas de fotografia
-- ===========================================================================
create table if not exists public.carteira_efetividade_snapshot (
  bloco      text        not null,   -- 'seis_linhas' | 'composicao_academica' | 'pendencias_por_motivo'
  recorte    text        not null,   -- '2024' | '2025' | '2026/1'
  payload    jsonb       not null,
  gerado_em  timestamptz not null default now(),
  duracao_ms integer,
  primary key (bloco, recorte)
);

comment on table public.carteira_efetividade_snapshot is
  'Fotografia dos blocos agregados da Efetividade. A tela le daqui; quem reconstroi e '
  'carteira_efetividade_recalcular(). A fonte viva segue sendo a origem da verdade.';

create table if not exists public.carteira_pendencias_item_snapshot (
  recorte           text        not null,
  motivo            text        not null,
  titulo_id         uuid        not null,
  aluno_id          uuid,
  aluno_nome        text,
  cpf               text,
  documento         text,
  vencimento        date,
  safra             text,
  valor             numeric,
  motivo_rotulo     text,
  situacao_titulo   text,
  evidencia         text,
  responsavel_email text,
  desde             timestamptz,
  acao              text,
  gerado_em         timestamptz not null default now(),
  primary key (recorte, motivo, titulo_id)
);

comment on table public.carteira_pendencias_item_snapshot is
  'Fotografia do registro individual de cada pendencia, para a Fila Unica paginar sem '
  'tocar a consulta pesada. Nenhuma decisao mora aqui: a resolucao e sempre pelas RPCs '
  'proprias de cada fluxo.';

-- Indice da paginacao da fila: (recorte, motivo) + ordem estavel por valor.
create index if not exists carteira_pendencias_item_snapshot_fila
  on public.carteira_pendencias_item_snapshot (recorte, motivo, valor desc, documento);

-- Tabela nova herda privilegios amplos do schema public -- inclusive TRUNCATE
-- para authenticated, e RLS nao cobre TRUNCATE. Fecha explicitamente: a leitura
-- da tela passa pelas funcoes SECURITY DEFINER, nunca pela tabela.
alter table public.carteira_efetividade_snapshot enable row level security;
revoke all on table public.carteira_efetividade_snapshot from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_efetividade_snapshot to service_role;

alter table public.carteira_pendencias_item_snapshot enable row level security;
revoke all on table public.carteira_pendencias_item_snapshot from public, anon, authenticated;
grant select, insert, update, delete on table public.carteira_pendencias_item_snapshot to service_role;


-- ===========================================================================
-- 3. A RECONSTRUCAO -- pesada, FORA da requisicao normal
-- ===========================================================================
-- Chama as MESMAS funcoes vivas e guarda o resultado. Nenhuma conta nova,
-- nenhuma regra financeira alterada.
--
-- GUARDA: fotografia boa nao e substituida por calculo quebrado. Grava so se a
-- conferencia da propria funcao fechar e o total for maior que zero -- e o
-- mesmo espirito do "snapshot velho so e substituido por um novo COMPLETO" de
-- `carteira_saldo_historico_recalcular`.
--
-- POR QUE NAO HA DUPLA LEITURA DE EQUIVALENCIA, como em
-- `carteira_academico_perfil_recalcular`: lá a segunda chamada custa
-- milissegundos; aqui 2026/1 custa ~21 s e dobrar isso seria 42 s de trabalho
-- por recorte. A garantia equivalente vem de dentro: cada funcao devolve
-- `conferencia`, medida na MESMA passada que produziu os numeros, e e ela que
-- este recalculo exige. Fotografia que nao fecha nao entra.
create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  r         record;
  v_t0      timestamptz;
  v_payload jsonb;
  v_ms      integer;
  v_feitos  jsonb := '[]'::jsonb;
  v_itens   integer;
  v_tecnico boolean := (current_setting('request.jwt.claims', true) is null)
                        or coalesce(auth.role(),'') = 'service_role';
begin
  -- Escrita: so a rotina (service_role / sem JWT) ou a gestao.
  if not v_tecnico and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  for r in
    select * from (values ('2024','2024',null::text),
                          ('2025','2025',null::text),
                          ('2026/1','2026','1')) v(recorte, ano, semestre)
     where p_recorte is null or v.recorte = p_recorte
  loop
    -- ---------------------------------------------------- bloco seis_linhas
    v_t0 := clock_timestamp();
    v_payload := public.carteira_safra_situacoes(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'situacoes'->'entrou'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('seis_linhas', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','seis_linhas','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- -------------------------------------------- bloco composicao_academica
    v_t0 := clock_timestamp();
    v_payload := public.carteira_em_aberto_por_status_academico(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false)
       and coalesce((v_payload->'total'->>'valor')::numeric, 0) > 0 then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('composicao_academica', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','composicao_academica','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- ------------------------------------------ bloco pendencias_por_motivo
    v_t0 := clock_timestamp();
    v_payload := public.carteira_pendencias_por_motivo(r.ano, r.semestre);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    -- Pendencia zero e resultado legitimo (safra sem pendencia nenhuma), entao
    -- aqui a guarda e so a conferencia -- exigir total > 0 esconderia o caso
    -- bom em que nao ha mais nada pendente.
    if coalesce((v_payload->'conferencia'->>'fecha')::boolean, false) then
      insert into public.carteira_efetividade_snapshot (bloco, recorte, payload, gerado_em, duracao_ms)
      values ('pendencias_por_motivo', r.recorte, v_payload, now(), v_ms)
      on conflict (bloco, recorte) do update
        set payload = excluded.payload, gerado_em = excluded.gerado_em,
            duracao_ms = excluded.duracao_ms;
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,'ms',v_ms);
    else
      v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_por_motivo','recorte',r.recorte,
                                                 'ms',v_ms,'descartado','conferencia nao fechou');
    end if;

    -- ------------------------------------------------- o registro individual
    -- Troca atomica por recorte: apaga e repovoa na MESMA transacao, para a
    -- fila nunca ler meia fotografia.
    v_t0 := clock_timestamp();
    delete from public.carteira_pendencias_item_snapshot s where s.recorte = r.recorte;
    insert into public.carteira_pendencias_item_snapshot
      (recorte, motivo, titulo_id, aluno_id, aluno_nome, cpf, documento, vencimento, safra,
       valor, motivo_rotulo, situacao_titulo, evidencia, responsavel_email, desde, acao, gerado_em)
    select r.recorte, i.motivo, i.titulo_id, i.aluno_id, i.aluno_nome, i.cpf, i.documento,
           i.vencimento, i.safra, i.valor, i.motivo_rotulo, i.situacao_titulo, i.evidencia,
           i.responsavel_email, i.desde, i.acao, now()
      from (select m->>'chave' as chave
              from jsonb_array_elements(
                     coalesce(public.carteira_pendencias_por_motivo(r.ano, r.semestre)->'motivos',
                              '[]'::jsonb)) m) mm
      cross join lateral public.carteira_pendencias_itens(mm.chave, r.ano, r.semestre, 500, 0) i;
    v_itens := (select count(*) from public.carteira_pendencias_item_snapshot s where s.recorte = r.recorte);
    v_ms := round(extract(epoch from (clock_timestamp() - v_t0)) * 1000);
    v_feitos := v_feitos || jsonb_build_object('bloco','pendencias_itens','recorte',r.recorte,
                                               'linhas',v_itens,'ms',v_ms);
  end loop;

  return jsonb_build_object('gerado_em', now(), 'blocos', v_feitos);
end;
$function$;

comment on function public.carteira_efetividade_recalcular(text) is
  'Reconstroi a camada de leitura da Efetividade chamando as MESMAS funcoes vivas. '
  'Pesada de proposito (2026/1 custa ~21 s, acima do teto de 8s do papel authenticated) '
  'e por isso roda FORA da requisicao da tela: rotina horaria ou gestao. Fotografia que '
  'nao fecha a conferencia e descartada, nunca grava sobre uma boa.';

revoke all on function public.carteira_efetividade_recalcular(text) from public, anon;
grant execute on function public.carteira_efetividade_recalcular(text) to authenticated, service_role;


-- ===========================================================================
-- 4. A LEITURA -- o que o front chama, e so isso
-- ===========================================================================
create or replace function public.carteira_efetividade_ler(
  p_bloco    text,
  p_ano      text,
  p_semestre text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_out     jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if coalesce(p_bloco,'') not in ('seis_linhas','composicao_academica','pendencias_por_motivo') then
    raise exception 'Bloco desconhecido: %.', p_bloco using errcode = '22023';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  select s.payload
         || jsonb_build_object('snapshot', jsonb_build_object(
              'gerado_em', s.gerado_em, 'duracao_ms', s.duracao_ms, 'bloco', s.bloco))
    into v_out
    from public.carteira_efetividade_snapshot s
   where s.bloco = p_bloco and s.recorte = v_recorte;

  -- Sem fotografia a tela precisa DIZER isso, nunca cair em bloco vazio -- que
  -- e indistinguivel de "nao ha dado".
  return coalesce(v_out, jsonb_build_object('sem_snapshot', true,
                                            'bloco', p_bloco, 'recorte', v_recorte));
end;
$function$;

comment on function public.carteira_efetividade_ler(text, text, text) is
  'Leitura rapida de um bloco da Efetividade. E a UNICA porta que o front usa para os '
  'tres blocos agregados -- ele nunca chama a funcao pesada. Devolve o payload da '
  'fotografia mais `snapshot.gerado_em`, ou {sem_snapshot:true}.';

revoke all on function public.carteira_efetividade_ler(text, text, text) from public, anon;
grant execute on function public.carteira_efetividade_ler(text, text, text) to authenticated, service_role;

-- ------------------------------------------- o registro individual, paginado
create or replace function public.carteira_pendencias_itens_ler(
  p_motivo   text,
  p_ano      text,
  p_semestre text default null,
  p_limite   integer default 50,
  p_offset   integer default 0
)
returns table (
  aluno_id          uuid,
  aluno_nome        text,
  cpf               text,
  titulo_id         uuid,
  documento         text,
  vencimento        date,
  safra             text,
  valor             numeric,
  motivo            text,
  motivo_rotulo     text,
  situacao_titulo   text,
  evidencia         text,
  responsavel_email text,
  desde             timestamptz,
  acao              text,
  gerado_em         timestamptz,
  total_no_motivo   bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_lim integer := least(greatest(coalesce(p_limite, 50), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  return query
  select s.aluno_id, s.aluno_nome, s.cpf, s.titulo_id, s.documento, s.vencimento, s.safra,
         s.valor, s.motivo, s.motivo_rotulo, s.situacao_titulo, s.evidencia,
         s.responsavel_email, s.desde, s.acao, s.gerado_em,
         count(*) over () as total_no_motivo
    from public.carteira_pendencias_item_snapshot s
   where s.recorte = v_recorte and s.motivo = p_motivo
   order by s.valor desc, s.documento
   limit v_lim offset v_off;
end;
$function$;

comment on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) is
  'Leitura paginada do registro individual de cada pendencia, da fotografia. E a porta '
  'que a Fila Unica usa; a consulta pesada (carteira_pendencias_itens) fica para o '
  'recalculo. `total_no_motivo` vem por window function, para a fila paginar sem uma '
  'segunda consulta.';

revoke all on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) from public, anon;
grant execute on function public.carteira_pendencias_itens_ler(text, text, text, integer, integer) to authenticated, service_role;


-- ===========================================================================
-- 5. A PRIMEIRA FOTOGRAFIA
-- ===========================================================================
-- Em bloco com tratamento de excecao de proposito: a reconstrucao e lenta
-- (~60 s nos tres recortes) e uma falha aqui NAO pode abortar a migration --
-- a estrutura e o que importa, e a rotina da hora seguinte tira a foto. Sem
-- foto, a tela diz "sem fotografia ainda" em vez de mostrar bloco vazio.
do $$
begin
  perform public.carteira_efetividade_recalcular();
exception when others then
  raise notice 'primeira fotografia da Efetividade nao foi tirada (%); a rotina horaria assume.', sqlerrm;
end $$;

-- ===========================================================================
-- 6. A ROTINA -- de hora em hora, como a do saldo historico
-- ===========================================================================
-- Mesma cadencia de `carteira_saldo_historico_hora` (:25), deslocada para :40
-- para as duas nao disputarem I/O na mesma virada de hora.
select cron.schedule('carteira_efetividade_hora', '40 * * * *',
                     $cron$select public.carteira_efetividade_recalcular();$cron$)
 where not exists (select 1 from cron.job where jobname = 'carteira_efetividade_hora');
