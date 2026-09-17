-- PARCELA PAGA ANTES DA EXTRACAO -- RECONSTRUCAO QUANDO O ACORDO JA EXISTE
-- 17/09/2026.
--
-- O PROBLEMA (diagnostico de 17/09/2026). O vinculo pagamento -> parcela e so
-- pelo boleto completo, e funciona quando a parcela existe. O Relatorio de
-- Titulos em Aberto so traz titulo EM ABERTO: a parcela que ja estava paga na
-- hora da extracao nao entra no CRM. Quando o acordo e parcelado e a entrada
-- ja tinha sido paga, o acordo entra sem ela, e o pagamento da entrada cai em
-- REVISAO ("o acordo esta no CRM e nao tem parcela livre para receber o
-- boleto"). Em 17/09: 72113 (boleto 50721130001, R$ 2.000,00) e 72153 (boleto
-- 50721530001, R$ 2.193,05).
--
-- O QUE ESTA MIGRATION FAZ
--   parcela_paga_antes_previa ........... SQL puro e STABLE. Confere as
--                                          evidencias e descreve a parcela e o
--                                          acordo depois. Nao escreve nada.
--   parcela_paga_antes_reconstruir ...... cria SO a parcela ausente, com o
--                                          boleto do proprio pagamento, ajusta
--                                          quantidade e total do acordo na
--                                          mesma transacao e entrega de novo ao
--                                          MOTOR, que vincula e baixa. Qualquer
--                                          desvio aborta tudo.
--   parcela_paga_antes_reconstruir_pendentes  percorre os pendentes elegiveis;
--                                          na recusa, grava codigo e descricao
--                                          curta em fila_pagamento_sem_vinculo.
--                                          motivo (o "por que caiu aqui" da
--                                          tela Pagamentos a conciliar).
--   parcela_paga_antes_apos_importar_acordos  logo depois da importacao de
--                                          acordos: motor e reconstrucao so para
--                                          os acordos que acabaram de entrar.
--   _pagamentos_baixar_lote ............. depois da reconciliacao normal da
--                                          importacao, chama a reconstrucao.
--   fluxo_pagamentos_rodar .............. etapa nova, logo depois da
--                                          reconciliacao horaria.
--   completar_parcelas_acordo ........... a parcela que nasce com o boleto do
--                                          documento do titulo nasce confiavel
--                                          quando o prefixo e o numero do acordo.
--                                          So novas importacoes.
--   importar_acordos .................... chama a funcao acima no fim, dentro
--                                          de bloco que nao derruba a importacao.
--   fluxo_pagamentos_config ............. etapa `reconstruir_parcela_paga_antes`,
--                                          DESLIGADA ao entrar.
--
-- EVIDENCIAS -- TODAS, ou nada e criado (a previa diz qual falhou):
--    1 pagamento pendente, sem estorno, sem retroativo, sem decisao na fila;
--    2 matricula + nome identificam o aluno do acordo (a mesma regra da
--      recuperacao do a vista: acordo_avista_previa, sem segunda copia);
--    3 numero do acordo no arquivo = prefixo do boleto, e um unico acordo no
--      CRM com esse numero;
--    4 todas as parcelas do acordo tem o prefixo do boleto do pagamento;
--    5 o boleto do pagamento nao existe em parcela nenhuma;
--    6 acordo ATIVO e vindo da importacao;
--    7 a importacao que trouxe o acordo e do dia do pagamento ou posterior;
--    8 estrutura importada intacta: numero de parcelas = quantidade e soma =
--      valor total;
--    9 sequencia coerente: boletos contiguos, sem buraco, vencimento crescente;
--   10 o boleto do pagamento e o imediatamente anterior ao menor importado;
--   11 o vencimento do pagamento e anterior ao da primeira parcela importada;
--   12 valor do boleto presente, e o pago dentro da faixa que o motor aceita;
--   13 nenhuma outra candidata: outro pagamento com o mesmo boleto, ou parcela
--      sem boleto em acordo do aluno;
--   14 nenhuma baixa incompativel: parcela paga sem pagamento do proprio boleto,
--      ou baixa manual registrada no acordo.
--
-- O QUE NAO MUDA: pagamento_conciliar_um (motor), a regra do boleto completo,
-- acordo_avista_previa / acordo_avista_registrar, reposicao de carteira. O
-- saldo do acordo nao e escrito aqui -- o motor tambem nao o escreve na baixa.
-- Rollback: supabase/rollbacks/20260917200000_parcela_paga_antes_da_extracao.rollback.sql

-- ---------------------------------------------------------------------------
-- 1. A PREVIA -- DECIDE E DESCREVE, SEM ESCREVER NADA
-- ---------------------------------------------------------------------------
create or replace function public.parcela_paga_antes_previa(p_pagamento_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $fn$
with
pag as (
  select p.id, p.aluno_id, p.numero_parcela_completo, p.titulo_numero, p.valor_pago, p.valor_honorario,
         p.data_pagamento, p.status_conciliacao, p.operador_email,
         coalesce(p.retroativo, false) as retroativo,
         coalesce(p.dados, '{}'::jsonb) ? 'estornado_em' as estornado,
         ltrim(coalesce(p.numero_parcela_completo, ''), '0') as boleto,
         public.vencimento_do_pagamento(p.dados) as vencimento,
         case when coalesce(p.dados->>'valor_original', '') ~ '^\d+(\.\d+)?$'
              then (p.dados->>'valor_original')::numeric end as valor_original
    from public.pagamentos p
   where p.id = p_pagamento_id
),
b as (
  select pag.*,
         pag.boleto ~ '^5\d{10}$' as no_padrao,
         case when pag.boleto ~ '^5\d{10}$' then substr(pag.boleto, 2, 6) end as acordo6,
         case when pag.boleto ~ '^5\d{10}$' then substr(pag.boleto, 8, 4)::int end as sufixo,
         nullif(ltrim(regexp_replace(coalesce(pag.titulo_numero, ''), '\D', '', 'g'), '0'), '') as titulo_num
    from pag
),
-- IDENTIDADE: a regra da recuperacao do a vista (matricula e nome apontando,
-- juntos, para o mesmo aluno). Chamada, nao copiada.
ident as (
  select public.acordo_avista_previa(p_pagamento_id, null) -> 'identificacao' as j
),
acs as (
  select a.* from public.acordos a, b
   where b.acordo6 is not null and a.numero_ulbra is not null
     and lpad(a.numero_ulbra, 6, '0') = b.acordo6
     and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA')
),
ac as (
  select * from acs where (select count(*) from acs) = 1
),
parc as (
  select q.id, q.numero, q.boleto, q.valor, q.vencimento, upper(coalesce(q.status, '')) as status, q.origem_baixa_ref,
         case when q.boleto ~ '^5\d{10}$' then substr(q.boleto, 2, 6) end as acordo6,
         case when q.boleto ~ '^5\d{10}$' then substr(q.boleto, 8, 4)::int end as sufixo
    from public.parcelas q join ac on ac.id = q.acordo_id
),
est as (
  select count(*) as n,
         count(distinct sufixo) as n_sufixos,
         min(sufixo) as sufixo_min,
         max(sufixo) as sufixo_max,
         min(numero) as numero_min,
         count(*) filter (where boleto is null or sufixo is null) as sem_boleto,
         count(*) filter (where acordo6 is distinct from (select b.acordo6 from b)) as outro_prefixo,
         coalesce(sum(valor), 0) as soma,
         -- parcela ja paga so e compativel se foi paga pelo pagamento do PROPRIO boleto
         count(*) filter (where status = 'PAGO'
                            and not exists (select 1 from public.pagamentos g
                                             where g.id::text = parc.origem_baixa_ref
                                               and ltrim(coalesce(g.numero_parcela_completo, ''), '0') = parc.boleto)) as pagas_sem_prova,
         count(*) filter (where exists (select 1 from parc y
                                         where y.sufixo = parc.sufixo + 1 and y.vencimento <= parc.vencimento)) as fora_de_ordem
    from parc
),
primeira as (
  select parc.* from parc, est where parc.sufixo = est.sufixo_min limit 1
),
ctx as (
  select
    (select count(*) from acs) as acordos_com_numero,
    (select count(*) from public.parcelas q, b where q.boleto = b.boleto) as parcelas_com_o_boleto,
    (select count(*) from public.pagamentos g, b
      where g.id <> b.id
        and ltrim(coalesce(g.numero_parcela_completo, ''), '0') = b.boleto
        and not (coalesce(g.dados, '{}'::jsonb) ? 'estornado_em')) as outros_pagamentos_do_boleto,
    (select count(*) from public.parcelas q
       join public.acordos a on a.id = q.acordo_id
       join ac on ac.aluno_id = a.aluno_id
      where q.boleto is null
        and upper(coalesce(q.status, '')) not in ('PAGO', 'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO')
        and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA')) as parcelas_sem_boleto_do_aluno,
    (select count(*) from public.baixas_pagamento bx where bx.parcela_id in (select parc.id from parc)) as baixas_registradas,
    (select count(*) from public.fila_pagamento_sem_vinculo f, b
      where f.pagamento_id = b.id and f.decisao is not null) as fila_decidida
),
v as (
  select x.ordem, x.codigo, coalesce(x.ok, false) as ok, x.detalhe
    from (values
      (1, 'PAGAMENTO_PENDENTE',
          (select b.status_conciliacao is not null and b.status_conciliacao <> 'BAIXADO'
                  and not b.estornado and not b.retroativo from b)
          and (select ctx.fila_decidida = 0 from ctx),
          'estado: ' || coalesce((select b.status_conciliacao from b), '(pagamento nao encontrado ou sem estado)')
          || ' · decisao na fila: ' || (select ctx.fila_decidida::text from ctx)),
      (2, 'ALUNO_IDENTIFICADO',
          (select (ident.j ->> 'aluno_id')::uuid = ac.aluno_id
                  and (b.aluno_id is null or b.aluno_id = ac.aluno_id) from ident, ac, b),
          'matricula + nome: ' || coalesce((select ident.j ->> 'aluno_id' from ident), 'nao identificam um aluno unico')
          || ' · aluno do acordo: ' || coalesce((select ac.aluno_id::text from ac), '-')),
      (3, 'NUMERO_DO_ACORDO_CONFERE',
          (select b.titulo_num is not null and b.titulo_num = ltrim(b.acordo6, '0') from b)
          and (select ctx.acordos_com_numero = 1 from ctx),
          'numero no arquivo ' || coalesce((select b.titulo_num from b), '(ausente)')
          || ' · no boleto ' || coalesce((select ltrim(b.acordo6, '0') from b), '?')
          || ' · acordos no CRM com esse numero: ' || (select ctx.acordos_com_numero::text from ctx)),
      (4, 'PREFIXO_DO_BOLETO_CONFERE',
          (select b.no_padrao from b) and (select est.n > 0 and est.outro_prefixo = 0 from est),
          'boleto ' || coalesce((select b.boleto from b), '(sem)')
          || ' · parcelas do acordo com outro prefixo: ' || (select est.outro_prefixo::text from est)),
      (5, 'BOLETO_SEM_PARCELA',
          (select ctx.parcelas_com_o_boleto = 0 from ctx),
          'parcelas com o boleto do pagamento: ' || (select ctx.parcelas_com_o_boleto::text from ctx)),
      (6, 'ACORDO_IMPORTADO_E_ATIVO',
          (select upper(coalesce(ac.status, '')) = 'ATIVO' and ac.criado_por_email = 'importacao@sistema' from ac),
          coalesce((select 'acordo ' || coalesce(ac.status, '?') || ' criado por ' || coalesce(ac.criado_por_email, '?') from ac),
                   'nenhum acordo unico com esse numero')),
      (7, 'IMPORTADO_NO_DIA_DO_PAGAMENTO_OU_DEPOIS',
          (select (ac.criado_em at time zone 'America/Sao_Paulo')::date >= b.data_pagamento from ac, b),
          coalesce((select 'acordo importado em ' || to_char(ac.criado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
                           || ' · pagamento em ' || to_char(b.data_pagamento, 'DD/MM/YYYY') from ac, b), '-')),
      (8, 'ESTRUTURA_IMPORTADA_INTACTA',
          (select est.n >= 1 and est.n = ac.qtd_parcelas and abs(est.soma - ac.valor_total) <= 0.01 from est, ac),
          coalesce((select est.n || ' parcela(s) somando ' || est.soma || ' · acordo diz ' || ac.qtd_parcelas || ' e ' || ac.valor_total
                      from est, ac), '-')),
      (9, 'SEQUENCIA_COERENTE',
          (select est.n >= 1 and est.sem_boleto = 0 and est.n_sufixos = est.n
                  and est.sufixo_max - est.sufixo_min + 1 = est.n and est.fora_de_ordem = 0 from est),
          (select 'boletos ' || coalesce(lpad(est.sufixo_min::text, 4, '0'), '?') || ' a ' || coalesce(lpad(est.sufixo_max::text, 4, '0'), '?')
                  || ' em ' || est.n || ' parcela(s) · sem boleto: ' || est.sem_boleto
                  || ' · vencimento fora de ordem: ' || est.fora_de_ordem from est)),
      (10, 'PARCELA_IMEDIATAMENTE_ANTERIOR',
          (select b.sufixo is not null and b.sufixo >= 1 and b.sufixo = est.sufixo_min - 1 and est.numero_min >= 1 from b, est),
          'boleto do pagamento ' || coalesce((select lpad(b.sufixo::text, 4, '0') from b), '?')
          || ' · menor importado ' || coalesce((select lpad(est.sufixo_min::text, 4, '0') from est), '?')),
      (11, 'VENCIMENTO_ANTERIOR_A_PRIMEIRA',
          (select b.vencimento is not null and b.vencimento < primeira.vencimento from b, primeira),
          'vencimento do pagamento ' || coalesce((select to_char(b.vencimento, 'DD/MM/YYYY') from b), '(ausente)')
          || ' · primeira parcela importada ' || coalesce((select to_char(primeira.vencimento, 'DD/MM/YYYY') from primeira), '?')),
      (12, 'VALOR_COMPATIVEL',
          (select b.valor_original > 0 and b.valor_pago >= b.valor_original - 0.05
                  and b.valor_pago <= b.valor_original * 1.15 from b),
          'valor do boleto ' || coalesce((select b.valor_original::text from b), '(ausente)')
          || ' · pago ' || coalesce((select b.valor_pago::text from b), '?')
          || ' (a faixa que o motor aceita na baixa)'),
      (13, 'SEM_OUTRA_CANDIDATA',
          (select ctx.outros_pagamentos_do_boleto = 0 and ctx.parcelas_sem_boleto_do_aluno = 0 from ctx),
          'outros pagamentos com o boleto: ' || (select ctx.outros_pagamentos_do_boleto::text from ctx)
          || ' · parcelas sem boleto em acordos do aluno: ' || (select ctx.parcelas_sem_boleto_do_aluno::text from ctx)),
      (14, 'SEM_BAIXA_INCOMPATIVEL',
          (select est.pagas_sem_prova = 0 from est) and (select ctx.baixas_registradas = 0 from ctx),
          'parcelas pagas sem pagamento do proprio boleto: ' || (select est.pagas_sem_prova::text from est)
          || ' · baixas manuais no acordo: ' || (select ctx.baixas_registradas::text from ctx))
    ) as x(ordem, codigo, ok, detalhe)
),
-- O MOTIVO QUE VAI PARA A FILA. Um so, o primeiro por ordem de causa (o que
-- impede avaliar vem antes do que reprova), com codigo estavel e descricao curta.
diag_mapa as (
  select * from (values
    (1, 'PAGAMENTO_PENDENTE', 'PARCELA_PAGA_ANTES_PAGAMENTO_NAO_PENDENTE', 'pagamento estornado, retroativo, ja baixado ou com decisao na fila'),
    (2, 'NUMERO_DO_ACORDO_CONFERE', 'PARCELA_PAGA_ANTES_NUMERO_DIVERGENTE', 'numero do acordo no arquivo difere do boleto'),
    (3, 'ACORDO_IMPORTADO_E_ATIVO', 'PARCELA_PAGA_ANTES_ACORDO_NAO_IMPORTADO', 'acordo nao veio da importacao ou nao esta ativo'),
    (4, 'BOLETO_SEM_PARCELA', 'PARCELA_PAGA_ANTES_BOLETO_JA_TEM_PARCELA', 'o boleto do pagamento ja esta em uma parcela'),
    (5, 'PREFIXO_DO_BOLETO_CONFERE', 'PARCELA_PAGA_ANTES_PREFIXO_DIVERGENTE', 'parcela do acordo com prefixo de outro acordo'),
    (6, 'ALUNO_IDENTIFICADO', 'PARCELA_PAGA_ANTES_ALUNO_DIVERGENTE', 'matricula e nome nao identificam o aluno do acordo'),
    (7, 'IMPORTADO_NO_DIA_DO_PAGAMENTO_OU_DEPOIS', 'PARCELA_PAGA_ANTES_ACORDO_JA_EXISTIA', 'acordo importado antes do pagamento: a parcela deveria ter vindo'),
    (8, 'ESTRUTURA_IMPORTADA_INTACTA', 'PARCELA_PAGA_ANTES_ESTRUTURA_INCOMPATIVEL', 'parcelas do acordo nao batem com quantidade e total'),
    (9, 'SEQUENCIA_COERENTE', 'PARCELA_PAGA_ANTES_SEQUENCIA_INCOERENTE', 'parcelas importadas com buraco ou vencimento fora de ordem'),
    (10, 'PARCELA_IMEDIATAMENTE_ANTERIOR', 'PARCELA_PAGA_ANTES_BOLETO_NAO_SEQUENCIAL', 'boleto nao e o imediatamente anterior a primeira parcela importada'),
    (11, 'VENCIMENTO_ANTERIOR_A_PRIMEIRA', 'PARCELA_PAGA_ANTES_VENCIMENTO_INCOMPATIVEL', 'vencimento ausente ou nao anterior ao da primeira parcela importada'),
    (12, 'VALOR_COMPATIVEL', 'PARCELA_PAGA_ANTES_VALOR_INCOMPATIVEL', 'valor pago fora da faixa do valor do boleto'),
    (13, 'SEM_OUTRA_CANDIDATA', 'PARCELA_PAGA_ANTES_OUTRA_CANDIDATA', 'outro pagamento com o mesmo boleto ou parcela sem boleto no aluno'),
    (14, 'SEM_BAIXA_INCOMPATIVEL', 'PARCELA_PAGA_ANTES_BAIXA_INCOMPATIVEL', 'acordo com parcela paga por outro documento ou baixa manual')
  ) as d(prioridade, validacao, codigo, descricao)
),
diag as (
  select case when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and not coalesce((select b.no_padrao from b), false)
                then 'PARCELA_PAGA_ANTES_BOLETO_FORA_DO_PADRAO'
              when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and (select ctx.acordos_com_numero from ctx) = 0
                then 'PARCELA_PAGA_ANTES_ACORDO_AUSENTE'
              when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and (select ctx.acordos_com_numero from ctx) > 1
                then 'PARCELA_PAGA_ANTES_ACORDO_DUPLICADO'
              else m.codigo end as codigo,
         case when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and not coalesce((select b.no_padrao from b), false)
                then 'boleto fora do padrao 5 + acordo + parcela'
              when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and (select ctx.acordos_com_numero from ctx) = 0
                then 'nenhum acordo no CRM com o numero do boleto'
              when m.validacao = 'NUMERO_DO_ACORDO_CONFERE' and (select ctx.acordos_com_numero from ctx) > 1
                then 'mais de um acordo no CRM com o numero do boleto'
              else m.descricao end as descricao
    from v join diag_mapa m on m.validacao = v.codigo
   where not v.ok
   order by m.prioridade
   limit 1
)
select jsonb_build_object(
  'origem', 'PARCELA_PAGA_ANTES_DA_EXTRACAO',
  'aprovado', (select bool_and(v.ok) from v),
  'bloqueios', coalesce((select jsonb_agg(v.codigo order by v.ordem) from v where not v.ok), '[]'::jsonb),
  'diagnostico', (select jsonb_build_object('codigo', diag.codigo, 'descricao', diag.descricao) from diag),
  'validacoes', (select jsonb_agg(jsonb_build_object('codigo', v.codigo, 'ok', v.ok, 'detalhe', v.detalhe) order by v.ordem) from v),
  'pagamento', (select jsonb_build_object('id', b.id, 'boleto', b.boleto, 'titulo_numero', b.titulo_numero,
                 'data_pagamento', b.data_pagamento, 'vencimento', b.vencimento, 'valor_pago', b.valor_pago,
                 'valor_original', b.valor_original, 'operador_email', b.operador_email,
                 'status_conciliacao', b.status_conciliacao) from b),
  'acordo', (select jsonb_build_object('id', ac.id, 'numero_ulbra', ac.numero_ulbra, 'aluno_id', ac.aluno_id, 'status', ac.status,
               'qtd_parcelas', ac.qtd_parcelas, 'valor_total', ac.valor_total, 'saldo', ac.saldo, 'criado_em', ac.criado_em) from ac),
  'parcelas_atuais', (select jsonb_agg(jsonb_build_object('numero', parc.numero, 'boleto', parc.boleto, 'vencimento', parc.vencimento,
                        'valor', parc.valor, 'status', parc.status) order by parc.sufixo) from parc),
  'parcela_a_criar', (select jsonb_build_object('numero', est.numero_min - 1, 'boleto', b.boleto, 'valor', b.valor_original,
                        'vencimento', b.vencimento,
                        'status', case when b.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
                        'boleto_confiavel', true, 'is_entrada', false) from b, est),
  'acordo_depois', (select jsonb_build_object('qtd_parcelas', ac.qtd_parcelas + 1,
                      'valor_total', round(ac.valor_total + b.valor_original, 2),
                      'saldo', ac.saldo) from ac, b)
);
$fn$;

comment on function public.parcela_paga_antes_previa(uuid) is
  'Previa da reconstrucao da parcela paga antes da extracao (PARCELA_PAGA_ANTES_DA_EXTRACAO), para acordo que ja existe no CRM. SQL puro, sem DML: confere as 14 evidencias e descreve a parcela a criar e o acordo depois. A porta e parcela_paga_antes_reconstruir.';

-- ---------------------------------------------------------------------------
-- 2. A RECONSTRUCAO -- SO A PARCELA AUSENTE; A BAIXA E DO MOTOR
-- ---------------------------------------------------------------------------
create or replace function public.parcela_paga_antes_reconstruir(p_pagamento_id uuid, p_confirmar boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_previa jsonb;
  v_acordo uuid;
  v_parcela uuid;
  v_qtd int;
  v_total numeric;
  v_valor numeric;
  v_n int;
  v_soma numeric;
  v_motor jsonb;
  v_marca text;
  v_depois jsonb;
begin
  v_previa := public.parcela_paga_antes_previa(p_pagamento_id);

  if not coalesce(p_confirmar, false) then
    return v_previa || jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false);
  end if;
  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  -- O mesmo pagamento duas vezes, ou dois pagamentos do mesmo acordo, ao mesmo
  -- tempo: o segundo espera e, ao reler, e recusado (BOLETO_SEM_PARCELA ou
  -- ESTRUTURA_IMPORTADA_INTACTA).
  v_acordo := (v_previa -> 'acordo' ->> 'id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('parcela_paga_antes:pagamento:' || p_pagamento_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('parcela_paga_antes:acordo:' || v_acordo::text, 0));

  v_previa := public.parcela_paga_antes_previa(p_pagamento_id);
  if not coalesce((v_previa ->> 'aprovado')::boolean, false)
     or (v_previa -> 'acordo' ->> 'id')::uuid is distinct from v_acordo then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  v_qtd := (v_previa -> 'acordo' ->> 'qtd_parcelas')::int;
  v_total := (v_previa -> 'acordo' ->> 'valor_total')::numeric;
  v_valor := (v_previa -> 'parcela_a_criar' ->> 'valor')::numeric;
  v_marca := 'PARCELA_PAGA_ANTES_DA_EXTRACAO | pagamento ' || p_pagamento_id::text
          || ' | boleto ' || (v_previa -> 'parcela_a_criar' ->> 'boleto')
          || ' | reconstruida em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
          || ': o relatorio so traz titulo em aberto, e esta ja estava paga na extracao';

  -- A PARCELA, com o boleto do proprio pagamento (confiavel: nao foi inferido).
  insert into public.parcelas
    (acordo_id, numero, valor, vencimento, status, is_entrada, boleto, boleto_confiavel,
     observacao, criado_em, atualizado_em)
  values (v_acordo,
          (v_previa -> 'parcela_a_criar' ->> 'numero')::int,
          v_valor,
          (v_previa -> 'parcela_a_criar' ->> 'vencimento')::date,
          v_previa -> 'parcela_a_criar' ->> 'status',
          false,
          v_previa -> 'parcela_a_criar' ->> 'boleto',
          true, v_marca, now(), now())
  returning id into v_parcela;

  -- O ACORDO. A importacao gravou quantidade e total das parcelas que vieram;
  -- a parcela reconstruida entra nas duas contas. So muda se ainda estiver
  -- exatamente como a previa leu.
  update public.acordos
     set qtd_parcelas = v_qtd + 1,
         valor_total = round(v_total + v_valor, 2),
         atualizado_em = now()
   where id = v_acordo and qtd_parcelas = v_qtd and valor_total = v_total;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'RECONSTRUCAO_ABORTADA: o acordo % mudou entre a previa e a gravacao', v_acordo;
  end if;

  select count(*), coalesce(sum(valor), 0) into v_n, v_soma from public.parcelas where acordo_id = v_acordo;
  if v_n <> v_qtd + 1 or abs(v_soma - round(v_total + v_valor, 2)) > 0.01 then
    raise exception 'RECONSTRUCAO_ABORTADA: a estrutura do acordo nao fecha (% parcelas somando %)', v_n, v_soma;
  end if;

  -- A BAIXA E DO MOTOR, pelo boleto completo, como a de qualquer pagamento.
  v_motor := public.pagamento_conciliar_um(p_pagamento_id, true);

  if coalesce(v_motor ->> 'status', '') <> 'BAIXADO'
     or not exists (select 1 from public.parcelas
                     where id = v_parcela and upper(coalesce(status, '')) = 'PAGO'
                       and origem_baixa_ref = p_pagamento_id::text)
     or exists (select 1 from public.fila_pagamento_sem_vinculo
                 where pagamento_id = p_pagamento_id and decisao is null) then
    raise exception 'RECONSTRUCAO_ABORTADA: o motor nao baixou a parcela reconstruida (%)', coalesce(v_motor::text, 'null');
  end if;

  select jsonb_build_object(
    'pagamento', (select jsonb_build_object('status_conciliacao', p.status_conciliacao, 'aluno_id', p.aluno_id)
                    from public.pagamentos p where p.id = p_pagamento_id),
    'fila', (select jsonb_build_object('decisao', f.decisao, 'decidido_por', f.decidido_por)
               from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id),
    'acordo', (select jsonb_build_object('qtd_parcelas', a.qtd_parcelas, 'valor_total', a.valor_total, 'saldo', a.saldo, 'status', a.status)
                 from public.acordos a where a.id = v_acordo),
    'parcela', (select jsonb_build_object('id', q.id, 'numero', q.numero, 'boleto', q.boleto, 'status', q.status,
                                          'confirmado_por_email', q.confirmado_por_email, 'origem_baixa', q.origem_baixa)
                  from public.parcelas q where q.id = v_parcela))
    into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('conciliacao@sistema', 'RECONSTRUCAO_PARCELA_PAGA_ANTES_DA_EXTRACAO', 'parcelas', v_parcela,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'acordo_id', v_acordo, 'parcela_id', v_parcela,
                             'disparado_por', coalesce(nullif(lower(auth.email()), ''), 'rotina'),
                             'antes', v_previa, 'depois', v_depois, 'motor', v_motor));

  return v_previa || jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
                                        'parcela_id', v_parcela, 'estado_depois', v_depois);
end;
$fn$;

comment on function public.parcela_paga_antes_reconstruir(uuid, boolean) is
  'Reconstroi a parcela paga antes da extracao quando o acordo ja existe. p_confirmar=false devolve a previa. p_confirmar=true refaz a previa sob cadeado, cria so a parcela ausente com o boleto do pagamento, ajusta quantidade e total do acordo e entrega ao motor (pagamento_conciliar_um). Estado final diferente do esperado aborta tudo.';

-- ---------------------------------------------------------------------------
-- 3. OS PENDENTES ELEGIVEIS
-- ---------------------------------------------------------------------------
create or replace function public.parcela_paga_antes_reconstruir_pendentes(p_limite integer default 50, p_acordo_ids uuid[] default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_r jsonb;
  v_cod text;
  v_prefixo text;
  v_n int := 0;
  v_ok int := 0;
  v_err int := 0;
  v_bloq jsonb := '{}'::jsonb;
  v_itens jsonb := '[]'::jsonb;
begin
  for v_id in
    select g.id
      from public.pagamentos g
     where g.status_conciliacao is not null
       and g.status_conciliacao <> 'BAIXADO'
       and ltrim(coalesce(g.numero_parcela_completo, ''), '0') ~ '^5\d{10}$'
       and not exists (select 1 from public.parcelas q where q.boleto = ltrim(g.numero_parcela_completo, '0'))
       and exists (select 1 from public.acordos a
                    where a.numero_ulbra is not null
                      and lpad(a.numero_ulbra, 6, '0') = substr(ltrim(g.numero_parcela_completo, '0'), 2, 6)
                      and upper(coalesce(a.status, '')) = 'ATIVO'
                      and (p_acordo_ids is null or a.id = any(p_acordo_ids)))
       and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                        where f.pagamento_id = g.id and f.decisao is not null)
     -- o mais novo primeiro: recusa antiga parada nao segura o pagamento que acabou de chegar
     order by g.data_pagamento desc, g.id
     limit greatest(coalesce(p_limite, 50), 0)
  loop
    v_n := v_n + 1;
    begin
      v_r := public.parcela_paga_antes_reconstruir(v_id, true);
      if coalesce((v_r ->> 'gravou')::boolean, false) then
        v_ok := v_ok + 1;
        -- resolvido: sai o diagnostico de uma recusa anterior
        update public.fila_pagamento_sem_vinculo f
           set motivo = regexp_replace(f.motivo, '^PARCELA_PAGA_ANTES_[A-Z_]+: [^|]* \| ', '')
         where f.pagamento_id = v_id
           and f.motivo ~ '^PARCELA_PAGA_ANTES_[A-Z_]+: ';
      else
        v_cod := coalesce(v_r -> 'diagnostico' ->> 'codigo', 'PARCELA_PAGA_ANTES_SEM_DIAGNOSTICO');
        v_bloq := jsonb_set(v_bloq, array[v_cod], to_jsonb(coalesce((v_bloq ->> v_cod)::int, 0) + 1), true);
        -- O MOTIVO EM PAGAMENTOS A CONCILIAR: codigo estavel e descricao curta na
        -- frente do texto do motor. O motor reescreve `motivo` a cada passada; esta
        -- etapa roda sempre depois dele, e so troca o proprio prefixo.
        v_prefixo := v_cod || ': ' || coalesce(v_r -> 'diagnostico' ->> 'descricao', 'recusado pela previa') || ' | ';
        update public.fila_pagamento_sem_vinculo f
           set motivo = v_prefixo || regexp_replace(f.motivo, '^PARCELA_PAGA_ANTES_[A-Z_]+: [^|]* \| ', '')
         where f.pagamento_id = v_id
           and f.decisao is null
           and not starts_with(f.motivo, v_prefixo);
      end if;
      v_itens := v_itens || jsonb_build_array(jsonb_build_object(
        'pagamento_id', v_id, 'boleto', v_r -> 'pagamento' ->> 'boleto',
        'gravou', coalesce((v_r ->> 'gravou')::boolean, false),
        'diagnostico', v_r -> 'diagnostico' ->> 'codigo', 'bloqueios', v_r -> 'bloqueios'));
    exception when others then
      -- um pagamento nao derruba os outros; o erro fica registrado
      v_err := v_err + 1;
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('conciliacao@sistema', 'RECONSTRUCAO_PARCELA_FALHOU', 'pagamentos', v_id,
              jsonb_build_object('erro', SQLERRM));
      v_itens := v_itens || jsonb_build_array(jsonb_build_object('pagamento_id', v_id, 'erro', SQLERRM));
    end;
  end loop;

  return jsonb_build_object('avaliados', v_n, 'reconstruidas', v_ok, 'erros', v_err,
                            'recusados_por_motivo', v_bloq, 'itens', v_itens);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3b. DEPOIS DA IMPORTACAO DE ACORDOS -- O PAGAMENTO NAO ESPERA A RODADA DAS :40
-- ---------------------------------------------------------------------------
create or replace function public.parcela_paga_antes_apos_importar_acordos(p_importacao_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_liga boolean;
  v_acordos uuid[];
  v_id uuid;
  v_r jsonb;
  v_n int := 0;
  v_baixou int := 0;
begin
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes';
  if not coalesce(v_liga, false) or p_importacao_id is null then
    return jsonb_build_object('ligado', false);
  end if;

  -- os acordos que ESTA importacao criou ou completou
  select coalesce(array_agg(a.id), '{}'::uuid[]) into v_acordos
    from public.acordos a
   where a.numero_ulbra is not null
     and upper(coalesce(a.status, '')) = 'ATIVO'
     and ((a.criado_por_email = 'importacao@sistema' and a.observacao like '%' || p_importacao_id::text)
          or exists (select 1 from public._backup_completar_parcelas_lote l
                      where l.acordo_id = a.id and l.lote = 'import_' || p_importacao_id::text));
  if cardinality(v_acordos) = 0 then
    return jsonb_build_object('ligado', true, 'acordos', 0);
  end if;

  -- 1. O MOTOR recebe de novo os pagamentos que esperavam estes acordos: a
  --    mesma selecao da reconciliacao horaria, restrita a eles, e so se ela
  --    estiver ligada.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'baixa_pelo_relatorio';
  if coalesce(v_liga, false) then
    for v_id in
      select g.id
        from public.pagamentos g
       where g.status_conciliacao is not null
         and g.status_conciliacao <> 'BAIXADO'
         and ltrim(coalesce(g.numero_parcela_completo, ''), '0') ~ '^5\d{10}$'
         and exists (select 1 from public.acordos a
                      where a.id = any(v_acordos)
                        and lpad(a.numero_ulbra, 6, '0') = substr(ltrim(g.numero_parcela_completo, '0'), 2, 6))
         and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                          where f.pagamento_id = g.id and f.decisao is not null)
       order by g.data_pagamento, g.id
       limit 500
    loop
      v_r := public.pagamento_conciliar_um(v_id, true);
      v_n := v_n + 1;
      if coalesce((v_r ->> 'baixou')::boolean, false) then v_baixou := v_baixou + 1; end if;
    end loop;
  end if;

  -- 2. a parcela paga antes da extracao, so nestes acordos
  return jsonb_build_object('ligado', true, 'acordos', cardinality(v_acordos),
                            'motor_avaliados', v_n, 'motor_baixados', v_baixou,
                            'reconstrucao', public.parcela_paga_antes_reconstruir_pendentes(50, v_acordos));
end;
$fn$;

comment on function public.parcela_paga_antes_apos_importar_acordos(uuid) is
  'Chamada no fim de importar_acordos. Com a etapa reconstruir_parcela_paga_antes ligada, entrega ao motor os pagamentos pendentes dos acordos que a importacao criou ou completou (se baixa_pelo_relatorio estiver ligada) e depois roda a reconstrucao so para esses acordos. Desligada, nao faz nada.';

revoke all on function public.parcela_paga_antes_previa(uuid) from public, anon, authenticated;
revoke all on function public.parcela_paga_antes_reconstruir(uuid, boolean) from public, anon, authenticated;
revoke all on function public.parcela_paga_antes_reconstruir_pendentes(integer, uuid[]) from public, anon, authenticated;
revoke all on function public.parcela_paga_antes_apos_importar_acordos(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. _pagamentos_baixar_lote: reconcilia e depois reconstroi
-- ---------------------------------------------------------------------------
create or replace function public._pagamentos_baixar_lote()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_res jsonb; v_liga boolean;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    -- a baixa e melhoria, nao condicao: a importacao nao pode cair por causa
    -- dela. Fica o registro para alguem olhar.
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;

  -- PARCELA PAGA ANTES DA EXTRACAO (17/09/2026). So depois de o motor ter
  -- feito o que dava: o que sobrou sem parcela para o boleto, em acordo que ja
  -- existe, passa pela previa estrutural. Falha aqui tambem nao derruba a
  -- importacao.
  select ligado into v_liga from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes';
  if coalesce(v_liga, false) then
    begin
      perform public.parcela_paga_antes_reconstruir_pendentes(50);
    exception when others then
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'RECONSTRUCAO_PARCELA_LOTE_FALHOU', 'pagamentos', null,
              jsonb_build_object('erro', SQLERRM));
    end;
  end if;
  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. fluxo_pagamentos_rodar: etapa nova depois da reconciliacao
-- ---------------------------------------------------------------------------
create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    -- parcela paga antes da extracao, em acordo que ja entrou (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='reconstruir_parcela_paga_antes';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('reconstruir_parcela_paga_antes', public.parcela_paga_antes_reconstruir_pendentes(50));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. completar_parcelas_acordo: boleto do titulo nasce confiavel
-- ---------------------------------------------------------------------------
create or replace function public.completar_parcelas_acordo(
  p_limite integer default 5,
  p_dry_run boolean default true,
  p_lote text default null::text,
  p_executado_por text default 'completar_parcelas_acordo'::text)
 returns table(acordo_id uuid, numero_acordo bigint, aluno_id uuid,
               qtd_parcelas integer, valor_total numeric, acao text)
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  r record; t record;
  v_n int := 0;
  v_lote text := coalesce(p_lote, to_char(now(),'YYYYMMDDHH24MISS'));
  v_pid uuid; v_qtd int; v_soma numeric;
begin
  if not public._gate_completar_parcelas() then
    raise exception 'Acesso negado: completar_parcelas_acordo exige permissao de importacao ou gestao de acordos.' using errcode='42501';
  end if;

  for r in
    with alvo as (
      select a.id, a.aluno_id, a.numero_acordo, a.valor_total, a.numero_ulbra
      from public.acordos a
      where upper(coalesce(a.status,''))='ATIVO'
        and not exists (select 1 from public.parcelas pa where pa.acordo_id=a.id)
    ),
    qbase as (
      select t2.aluno_id,
        left(regexp_replace(t2.documento,'\D','','g'), length(regexp_replace(t2.documento,'\D','','g'))-2) as base,
        count(*) qtd, round(sum(coalesce(t2.valor_original,t2.valor_em_aberto,0)),2) soma
      from public.acordos_titulos t2
      where length(regexp_replace(coalesce(t2.documento,''),'\D','','g')) >= 10
      group by 1,2
    )
    select alvo.id, alvo.aluno_id, alvo.numero_acordo, alvo.valor_total, alvo.numero_ulbra, qb.base, qb.qtd, qb.soma
    from alvo
    join qbase qb on qb.aluno_id=alvo.aluno_id and abs(qb.soma-alvo.valor_total)<=0.02
    where (select count(*) from qbase qx where qx.aluno_id=alvo.aluno_id and abs(qx.soma-alvo.valor_total)<=0.02)=1
      and (select count(*) from public.acordos a2 where a2.aluno_id=alvo.aluno_id and abs(a2.valor_total-alvo.valor_total)<=0.02
             and upper(coalesce(a2.status,''))='ATIVO' and not exists (select 1 from public.parcelas pa where pa.acordo_id=a2.id))=1
    order by alvo.numero_acordo
  loop
    exit when v_n >= coalesce(p_limite, 2147483647);
    acordo_id:=r.id; numero_acordo:=r.numero_acordo; aluno_id:=r.aluno_id; valor_total:=r.valor_total; qtd_parcelas:=r.qtd;
    if p_dry_run then acao:='DRY_RUN'; return next; v_n:=v_n+1; continue; end if;

    v_qtd:=0; v_soma:=0;
    for t in
      select tt.id, right(regexp_replace(tt.documento,'\D','','g'),2)::int as numero,
             coalesce(tt.valor_original,tt.valor_em_aberto,0) as valor, tt.vencimento,
             -- ACRESCENTADO: o boleto da PROPRIA linha-fonte, normalizado para o
             -- formato de 11 digitos que o CRM usa. Nao deriva de numero, valor
             -- nem vencimento.
             ltrim(regexp_replace(tt.documento,'\D','','g'),'0') as boleto,
             to_jsonb(tt.*) as snap
      from public.acordos_titulos tt
      where tt.aluno_id=r.aluno_id
        and length(regexp_replace(coalesce(tt.documento,''),'\D','','g'))>=10
        and left(regexp_replace(tt.documento,'\D','','g'), length(regexp_replace(tt.documento,'\D','','g'))-2)=r.base
      order by 1
    loop
      v_pid:=gen_random_uuid();
      -- ACRESCENTADO no INSERT: a coluna `boleto`, alimentada por t.boleto.
      insert into public.parcelas(id,acordo_id,numero,valor,vencimento,status,is_entrada,boleto,boleto_confiavel,observacao,criado_em,atualizado_em)
      values(v_pid,r.id,t.numero,t.valor,t.vencimento,
             case when t.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,false,
             t.boleto,
             -- 17/09/2026: o boleto veio do documento do proprio titulo. E
             -- confiavel quando o prefixo e o numero do acordo -- a unica
             -- associacao que nao depende da soma (4 casos antigos divergem).
             (t.boleto ~ '^5\d{10}$' and r.numero_ulbra is not null
              and substr(t.boleto, 2, 6) = lpad(r.numero_ulbra, 6, '0')),
             'Gerada da importacao (lote '||v_lote||') a partir do titulo do acordo; titulo movido p/ quarentena (sem dobra).',now(),now());
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,parcela_id,executado_por)
      values(v_lote,r.id,'PARCELA_CRIADA',v_pid,p_executado_por);

      insert into public._backup_parcelas_acordo_erro_import
        (id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,tipo_boleto,dados,importacao_id,created_at,status,valor_em_aberto,competencia,motivo_ajuste,atualizado_em,acordo_id,vinculado_em,vinculado_por)
      select src.id,src.aluno_id,src.cpf,src.documento,src.vencimento,src.valor_original,src.saldo_corrigido,src.situacao,src.tipo_boleto,src.dados,src.importacao_id,src.created_at,src.status,src.valor_em_aberto,src.competencia,
             'Movido p/ quarentena ao gerar parcela do acordo (lote '||v_lote||') - evita dobra',src.atualizado_em,src.acordo_id,src.vinculado_em,src.vinculado_por
      from public.acordos_titulos src where src.id=t.id;
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,titulo_id,titulo_snapshot,executado_por)
      values(v_lote,r.id,'TITULO_QUARENTENA',t.id,t.snap,p_executado_por);
      delete from public.acordos_titulos src where src.id=t.id;

      v_qtd:=v_qtd+1; v_soma:=v_soma+coalesce(t.valor,0);
    end loop;
    if abs(v_soma-r.valor_total)>0.02 then
      raise exception 'Divergencia acordo %: soma parcelas % <> valor_total %', r.numero_acordo, v_soma, r.valor_total;
    end if;
    acao:='COMPLETADO('||v_qtd||')'; return next; v_n:=v_n+1;
  end loop;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6b. importar_acordos: no fim, o reprocessamento dos acordos que entraram
-- ---------------------------------------------------------------------------
create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180000'
as $fn$
declare v_alunos_novos int:=0; v_titulos int:=0; v_fila int:=0; v_usuario text;
        v_completados int:=0; v_dup int:=0; v_pulados int:=0; v_linhas_puladas int:=0;
        v_ja_representados int:=0;
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'SEM_PERMISSAO_IMPORTACAO_BORDERO';
  end if;

  perform set_config('reativa.importando', 'on', true);
  perform pg_advisory_xact_lock(hashtextextended(p_importacao_id::text, 0));

  v_usuario := coalesce(nullif(auth.jwt()->>'email',''), 'sistema');
  insert into public.importacoes (id,tipo,referencia,arquivo_nome,usuario,status,retroativo)
  values (p_importacao_id,'ACORDOS','Relatorio de Titulos em Aberto (Acordo)','Relatorio Titulos em Aberto',v_usuario,'Concluída',false)
  on conflict (id) do nothing;

  create temp table _imp on commit drop as
  with base as (
    select regexp_replace(coalesce(l->>'cpf',''),'\D','','g') as cpf, nullif(trim(l->>'nome'),'') as nome,
           regexp_replace(coalesce(l->>'documento',''),'\D','','g') as documento, nullif(l->>'venc','')::date as venc,
           nullif(l->>'valor','')::numeric as valor, nullif(trim(l->>'unidade'),'') as unidade, nullif(trim(l->>'situacao'),'') as situacao
    from jsonb_array_elements(p_linhas) l)
  select cpf,nome,documento,venc,valor,unidade,situacao, left(documento,greatest(length(documento)-2,1)) as acordo_base
  from base where documento <> '';
  create index on _imp(cpf);

  create temp table _pular on commit drop as
  select distinct regexp_replace(coalesce(al.cpf,''),'\D','','g') as cpf_n
  from public.casos c
  join public.alunos al on al.id = c.aluno_id
  where c.quitado_em is not null and c.quitado_em >= current_date - 7
    and exists (select 1 from public.acordos a where a.aluno_id = c.aluno_id)
    and coalesce(al.cpf,'') <> '';
  create index on _pular(cpf_n);

  select count(*) into v_linhas_puladas from _imp i join _pular p on p.cpf_n = i.cpf;
  select count(distinct i.cpf) into v_pulados from _imp i join _pular p on p.cpf_n = i.cpf;
  delete from _imp i using _pular p where p.cpf_n = i.cpf;

  create temp table _al on commit drop as select id, regexp_replace(coalesce(cpf,''),'\D','','g') as cpf_n from public.alunos;
  create index on _al(cpf_n);

  insert into public.alunos (nome,cpf,unidade,situacao_academica,status_jornada,tipo_base,origem,observacao)
  select distinct on (i.cpf) coalesce(i.nome,'(sem nome)'),i.cpf,i.unidade,i.situacao,'Em cobrança','ACORDO_IMPORTADO','IMPORT_ACORDOS',
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text
  from _imp i where i.cpf<>'' and not exists (select 1 from _al a where a.cpf_n=i.cpf) order by i.cpf;
  get diagnostics v_alunos_novos = row_count;
  insert into _al (id,cpf_n) select id, regexp_replace(coalesce(cpf,''),'\D','','g')
  from public.alunos where origem='IMPORT_ACORDOS' and observacao like '%'||p_importacao_id::text;

  -- A divida ja representada no CRM nao vira titulo de novo.
  select count(*) into v_ja_representados from _imp i
   where exists (select 1 from public.parcelas p where p.boleto = ltrim(i.documento,'0'))
      or (i.documento ~ '^\d{12}$'
          and exists (select 1 from public.acordos a
                       where a.numero_ulbra = substr(i.documento,4,5)
                         and upper(coalesce(a.status,'')) <> 'CANCELADO'));

  -- saldo_corrigido nasce junto, com o MESMO valor de valor_original e
  -- valor_em_aberto. Sem isto, o titulo fica invisivel para as cinco rotinas
  -- que leem `coalesce(saldo_corrigido, 0)` no dia em que o acordo for
  -- cancelado e ele voltar para 'em_aberto'. E o que o borderô ja faz.
  insert into public.acordos_titulos (aluno_id,cpf,documento,vencimento,valor_original,valor_em_aberto,saldo_corrigido,situacao,status,tipo_boleto,importacao_id)
  select (select a.id from _al a where a.cpf_n=i.cpf limit 1), i.cpf,i.documento,i.venc,i.valor,i.valor,i.valor,'ABERTO','vinculada','Acordo',p_importacao_id
  from _imp i
  where not exists (select 1 from public.acordos_titulos t where t.documento=i.documento)
    -- ja existe parcela com esse documento: a parcela representa a divida
    and not exists (select 1 from public.parcelas p where p.boleto = ltrim(i.documento,'0'))
    -- o acordo ja existe no CRM: as parcelas dele cobrem a divida
    and not (i.documento ~ '^\d{12}$'
             and exists (select 1 from public.acordos a
                          where a.numero_ulbra = substr(i.documento,4,5)
                            and upper(coalesce(a.status,'')) <> 'CANCELADO'));
  get diagnostics v_titulos = row_count;

  insert into public.fila_acordos_confirmar (aluno_id,cpf,nome,acordo_base,qtd_parcelas,valor_total,unidade,situacao_aluno,importacao_id)
  select (select a.id from _al a where a.cpf_n=i.cpf limit 1), i.cpf, max(i.nome), i.acordo_base, count(*), round(sum(coalesce(i.valor,0)),2), max(i.unidade), max(i.situacao), p_importacao_id
  from _imp i group by i.cpf, i.acordo_base
  on conflict (cpf,acordo_base) do nothing;
  get diagnostics v_fila = row_count;

  update public.fila_acordos_confirmar f set qtd_parcelas=a.qtd, valor_total=a.total
  from (select regexp_replace(coalesce(cpf,''),'\D','','g') cpf_n, left(documento,greatest(length(documento)-2,1)) acordo_base,
               count(*) qtd, round(sum(coalesce(valor_em_aberto,valor_original,0)),2) total
        from public.acordos_titulos where importacao_id=p_importacao_id and tipo_boleto='Acordo' group by 1,2) a
  where regexp_replace(coalesce(f.cpf,''),'\D','','g')=a.cpf_n and f.acordo_base=a.acordo_base;

  -- Acordo novo so nasce se aquele numero da Ulbra ainda nao existe no CRM.
  insert into public.acordos (aluno_id,cpf,tipo,forma_pagamento,valor_total,qtd_parcelas,status,unidade,saldo,observacao,criado_por_email,criado_por_nome,numero_ulbra,criado_em,atualizado_em)
  select f.aluno_id,f.cpf,'ACORDO','PARCELADO',f.valor_total,f.qtd_parcelas,'ATIVO',f.unidade,f.valor_total,
         'Importado do Relatorio de Titulos em Aberto (Acordo) — lote '||p_importacao_id::text,
         'importacao@sistema','Importacao Acordos', substr(f.acordo_base,4,5), now(),now()
  from public.fila_acordos_confirmar f
  where f.importacao_id=p_importacao_id
    and f.acordo_base ~ '^\d{10}$'
    and not exists (select 1 from public.acordos a where a.numero_ulbra = substr(f.acordo_base,4,5))
    and not exists (select 1 from public.acordos a where a.aluno_id=f.aluno_id
                    and a.valor_total=f.valor_total and a.observacao like '%'||p_importacao_id::text)
  on conflict do nothing;

  select count(*) into v_dup from public.acordos a
   where a.duplicado_de is not null and a.observacao like '%'||p_importacao_id::text;

  select count(*) into v_completados
  from public.completar_parcelas_acordo(
         p_limite => 100000, p_dry_run => false,
         p_lote => 'import_'||p_importacao_id::text, p_executado_por=> v_usuario);

  update public.importacoes set qtd_registros=coalesce(qtd_registros,0)+v_titulos where id=p_importacao_id;

  -- 17/09/2026: o pagamento que esperava um destes acordos nao espera a rodada
  -- das :40. Nao faz nada com a etapa reconstruir_parcela_paga_antes desligada,
  -- e falha aqui nao derruba a importacao.
  begin
    perform public.parcela_paga_antes_apos_importar_acordos(p_importacao_id);
  exception when others then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina', 'RECONSTRUCAO_POS_IMPORTACAO_ACORDOS_FALHOU', 'importacoes', p_importacao_id,
            jsonb_build_object('erro', SQLERRM));
  end;
  return json_build_object('alunos_novos',v_alunos_novos,'titulos_inseridos',v_titulos,'acordos_na_fila',v_fila,
                           'acordos_completados',v_completados,'acordos_duplicados_sinalizados',v_dup,
                           'cpfs_pulados_quitados',v_pulados,'linhas_puladas_quitados',v_linhas_puladas,
                           'linhas_ja_representadas_no_crm',v_ja_representados,
                           'importacao_id',p_importacao_id);
end; 
$fn$;

-- ---------------------------------------------------------------------------
-- 7. A ETAPA NASCE DESLIGADA
-- ---------------------------------------------------------------------------
insert into public.fluxo_pagamentos_config (etapa, ligado, observacao, alterado_em, alterado_por)
values ('reconstruir_parcela_paga_antes', false,
        'DESLIGADA ao entrar (17/09/2026). Recria a parcela paga antes da extracao quando o acordo ja existe no CRM e as 14 evidencias da previa fecham; a baixa continua do motor. Com ela ligada, importacao de pagamentos, importacao de acordos e rodada das :40 usam o mesmo mecanismo. Ligar so por decisao da gestao, depois da validacao dos acordos 72113 e 72153.',
        now(), 'migration_20260917200000')
on conflict (etapa) do nothing;

-- ---------------------------------------------------------------------------
-- PROVA. Qualquer divergencia aborta a migration inteira.
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_src text;
begin
  -- o motor e a recuperacao do a vista nao foram tocados
  if md5((select prosrc from pg_proc where oid = 'public.pagamento_conciliar_um(uuid,boolean)'::regprocedure)) <> 'fa3d64add73e0e73e587e16f0c0624d1' then
    raise exception 'PROVA: o motor de baixa nao e o de producao de 17/09/2026';
  end if;
  if md5((select prosrc from pg_proc where oid = 'public.acordo_avista_previa(uuid,uuid[])'::regprocedure)) <> '9e062e7600cd7b04a17fb9db65469bfe' then
    raise exception 'PROVA: a previa da recuperacao do a vista mudou';
  end if;

  -- a previa nova e SQL puro, STABLE e nao e porta de entrada
  if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = 'public.parcela_paga_antes_previa(uuid)'::regprocedure) <> 'sql'
     or (select provolatile from pg_proc where oid = 'public.parcela_paga_antes_previa(uuid)'::regprocedure) <> 's' then
    raise exception 'PROVA: parcela_paga_antes_previa deixou de ser SQL puro e STABLE';
  end if;
  if has_function_privilege('authenticated', 'public.parcela_paga_antes_previa(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.parcela_paga_antes_reconstruir(uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.parcela_paga_antes_reconstruir_pendentes(integer,uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.parcela_paga_antes_apos_importar_acordos(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.parcela_paga_antes_reconstruir(uuid,boolean)', 'EXECUTE') then
    raise exception 'PROVA: funcao da reconstrucao chamavel de fora';
  end if;

  -- a reconstrucao nao baixa por conta propria
  select prosrc into v_src from pg_proc where oid = 'public.parcela_paga_antes_reconstruir(uuid,boolean)'::regprocedure;
  if v_src ~* 'update\s+public\.(parcelas|pagamentos|fila_pagamento_sem_vinculo)'
     or v_src not like '%public.pagamento_conciliar_um(p_pagamento_id, true)%'
     or v_src not like '%public.parcela_paga_antes_previa(p_pagamento_id)%' then
    raise exception 'PROVA: parcela_paga_antes_reconstruir escreve baixa por fora do motor';
  end if;

  -- a importacao continua reconciliando primeiro
  select prosrc into v_src from pg_proc where oid = 'public._pagamentos_baixar_lote()'::regprocedure;
  if position('baixa_pelo_relatorio_pagamento' in v_src) = 0
     or position('parcela_paga_antes_reconstruir_pendentes' in v_src) < position('baixa_pelo_relatorio_pagamento' in v_src) then
    raise exception 'PROVA: _pagamentos_baixar_lote nao reconcilia antes de reconstruir';
  end if;
  select prosrc into v_src from pg_proc where oid = 'public.fluxo_pagamentos_rodar(text)'::regprocedure;
  if position('parcela_paga_antes_reconstruir_pendentes' in v_src) < position('baixa_pelo_relatorio_pagamento' in v_src) then
    raise exception 'PROVA: fluxo_pagamentos_rodar nao reconcilia antes de reconstruir';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.completar_parcelas_acordo(integer,boolean,text,text)'::regprocedure;
  if v_src not like '%is_entrada,boleto,boleto_confiavel,observacao%' then
    raise exception 'PROVA: completar_parcelas_acordo nao grava boleto_confiavel';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.importar_acordos(jsonb,uuid)'::regprocedure;
  if position('parcela_paga_antes_apos_importar_acordos' in v_src) < position('completar_parcelas_acordo' in v_src) then
    raise exception 'PROVA: importar_acordos nao completa as parcelas antes de reprocessar';
  end if;

  if not exists (select 1 from public.fluxo_pagamentos_config where etapa = 'reconstruir_parcela_paga_antes') then
    raise exception 'PROVA: etapa reconstruir_parcela_paga_antes ausente';
  end if;
end;
$prova$;
