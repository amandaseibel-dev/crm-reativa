-- PROPOSTA DE MIGRATION -- NAO APLICADA. Aguarda autorizacao de aplicacao.
--
-- Fica FORA de supabase/migrations/ de proposito: versao nao aplicada dentro
-- daquele diretorio e o que o Gate 1 esta limpando. Ao aprovar, mover para
-- supabase/migrations/ com a versao que o apply_migration registrar.
--
-- Este arquivo e EXECUTAVEL do inicio ao fim. Nao ha DROP com CREATE
-- comentado: a versao anterior desta proposta tinha exatamente esse defeito e
-- teria derrubado a tela em producao.
--
-- ============================================================================
-- O QUE E. Cancelamento e suspensao de cobranca passam a aparecer no card de
-- Cancelados da Efetividade 2026/2, ao lado do titulo com situacao CANCELADA.
--
-- NADA SAI DO SALDO. As faixas continuam EXATAMENTE como estao: os titulos
-- marcados seguem contados onde ja estao (sem negociacao, em conferencia,
-- convertido). Esta migration so ACRESCENTA uma coluna e quatro agregados;
-- nenhuma conta muda, nenhum total se move. A prova disso esta na secao
-- VALIDACAO, no fim deste arquivo.
--
-- ============================================================================
-- AS FONTES, E ELAS DIVERGEM. Medido em 28/09/2026.
--
-- O catalogo oficial (src/utils/tabulacoes.js, grupo ENCERRAMENTO) define
-- CANCELAMENTO_COBRANCA e SUSPENSAO_COBRANCA. `alunos.status_atual` guarda os
-- codigos do catalogo; `casos.status_atual` guarda tambem grafias antigas em
-- texto livre. As grafias ABAIXO nao sao suposicao -- sao as que existem hoje:
--
--   alunos.status_atual        SUSPENSAO COBRANCA ............ 89 alunos
--                              CANCELAMENTO COBRANCA ......... 12 alunos
--   casos.status_atual (vivo)  COBRANCA CANCELADA ........... 113 casos
--                              SUSPENSAO COBRANCA ............ 73 casos
--                              CANCELAMENTO COBRANCA .......... 4 casos
--                              CESSAR COBRANCA ................ 2 casos
--                              CANCELAMENTO DE COBRANCA ....... 2 casos
--                              SEM INTERESSE/CANCELAMENTO ..... 2 casos  <- FORA
--
-- SEM INTERESSE/CANCELAMENTO fica DE FORA de proposito: descreve recusa do
-- aluno, nao decisao de encerrar a cobranca. Incluir seria mudar o significado
-- do card. Se a gestao entender o contrario, entra numa migration propria.
--
-- DIVERGENCIA ENTRE AS DUAS FONTES, medida nos 2.525 titulos de 2026/2:
--   marcado pela FICHA ............ 86 titulos
--   marcado pelo CASO vivo ........ 97 titulos
--   as duas concordam ............. 82
--   so a ficha marca ............... 4
--   SO O CASO marca ............... 15 titulos / R$ 57.193,55
--   uniao ......................... 101 titulos, 68 alunos
--
-- Os 15 nao sao residuo: estao todos em caso VIVO. E marca de operador que a
-- ficha nao recebeu. Ler so a ficha perderia R$ 57.193,55. Por isso a fonte e
-- a UNIAO das duas, e a divergencia fica registrada aqui em vez de sumir.
--
-- Caso ENCERRADO fica de fora: tabulacao de caso ja encerrado nao descreve a
-- cobranca de hoje.
--
-- ============================================================================
-- O QUE A MARCA SIGNIFICA -- e o limite dela.
--
-- A marca e do ALUNO. Nao existe vinculo caso->titulo no banco: nenhuma FK de
-- `casos` para `acordos_titulos`, nenhuma tabela de ligacao, e `casos.semestre`
-- esta nulo nos alunos afetados. Logo nenhuma fonte aponta UM titulo.
--
-- CONSEQUENCIA, e ela vai escrita na tela: o que se identifica e
-- "mensalidades de alunos com registro de cancelamento/suspensao". NAO se
-- afirma que a marca alcanca todas as mensalidades daquele aluno, nem que cada
-- mensalidade listada foi cancelada. A ausencia de vinculo caso->titulo nao
-- prova abrangencia -- ela impede tanto afirmar quanto negar.
--
-- PRECEDENCIA, para nao contar duas vezes:
--   1. titulo com situacao CANCELADA -> nunca recebe tabulacao (fica null)
--   2. cancelamento definitivo tem precedencia sobre suspensao
-- As tres marcas sao exclusivas entre si por construcao.
--
-- MEDIDO em 28/09/2026 (numeros reais, nao estimativa):
--   situacao CANCELADA no titulo ....... 1 titulo  / R$  10.399,64
--   registro de cancelamento definitivo  29 titulos / R$  99.160,73
--   registro de suspensao temporaria ... 72 titulos / R$ 152.779,86
--   total sem duplicidade .............. 102 titulos / R$ 262.340,23
--
-- ============================================================================
-- TAMBEM AQUI: aluno_id no detalhe, para o botao "Abrir ficha do aluno", e os
-- dois indicadores novos, para o drill-down das duas linhas de tabulacao.
-- `aluno_id` ja circula no classificador; o detalhe so deixa de descarta-lo.
-- Nenhum dado pessoal novo e exposto: o CPF continua mascarado.
--
-- ============================================================================
-- DEPENDENCIAS. `carteira_2026_2_classificar()` muda de assinatura (coluna
-- nova no RETURNS TABLE), entao exige DROP + CREATE -- CREATE OR REPLACE nao
-- troca o tipo de retorno. As duas funcoes que a chamam sao recriadas na MESMA
-- transacao: fora dela existiria uma janela com a tela quebrada em producao.
--
-- As chamadoras usam corpo em texto, entao o DROP nao e bloqueado por
-- dependencia -- o que torna a transacao unica ainda mais necessaria, porque o
-- banco nao avisaria.
--
-- ACL: o classificador foi fechado para `authenticated` na versao
-- 20260927224458 e o DROP/CREATE APAGA essa decisao -- funcao criada por
-- postgres em `public` NASCE com EXECUTE para authenticated por causa de
-- ALTER DEFAULT PRIVILEGES. Por isso as revogacoes sao explicitas e a guarda
-- no fim CONFERE o resultado e ABORTA antes do commit. Checagem depois do
-- commit nao serve: nao impede a exposicao temporaria.
--
-- ROLLBACK: supabase/rollbacks/ -- gerar junto ao aplicar, recriando as tres
-- funcoes na forma anterior (guardada no ledger da versao 20260927221825).

begin;

-- ---------------------------------------------------------------------------
-- 0. FOTOGRAFIA DO ANTES -- tirada DENTRO da transacao, antes do DROP.
--
-- E contra ela que a guarda do passo 4 compara titulo a titulo. Guardar a foto
-- em vez de cravar totais no arquivo e o que permite a mesma guarda valer
-- daqui a um mes: a base e viva, mas a classificacao de cada titulo tem de
-- sobreviver identica a troca da funcao.
--
-- Chama o classificador DIRETO, nao o painel: o painel exige
-- carteira_2026_1_pode_ler(), que depende de JWT e nao existe numa migration.
-- ---------------------------------------------------------------------------
create temporary table _antes_2026_2 on commit drop as
select titulo_id, faixa, sub_faixa, recuperado, saldo, valor_original,
       liquidado_total, acordo_estado, fonte_semestre, motivo_cancelamento
  from public.carteira_2026_2_classificar();

-- ---------------------------------------------------------------------------
-- 1. CLASSIFICADOR
-- ---------------------------------------------------------------------------
drop function if exists public.carteira_2026_2_classificar();

create function public.carteira_2026_2_classificar()
returns table(titulo_id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
              competencia date, valor_original numeric, situacao_crm text, acordo_id uuid,
              acordo_numero text, acordo_estado text, faixa text, sub_faixa text,
              recuperado numeric, saldo numeric, liquidado_total boolean, fonte_semestre text,
              motivo_cancelamento text, encerramento_tabulacao text)
language sql stable security definer set search_path to 'public'
as $function$
  with serie as (
    select regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b,
           max(semestre) semestre, max(liquidado_em) liq
      from public.prime_titulo_semestre
     where coalesce(semestre,'') <> ''
     group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id, a.numero_ulbra, a.status,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio,
           case when a.status = 'CANCELADO' then 'cancelado'
                when a.status = 'QUITADO'   then 'quitado'
                when coalesce(p.venc_mais30,0) > 0 then 'quebrado'
                when coalesce(p.venc_ate30,0)  > 0 then 'atraso'
                else 'regular' end estado
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  -- Boleto que É nosso (parcela de acordo do CRM). Pagamento cujo boleto não
  -- está aqui é caixa que entrou FORA do CRM.
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '[^0-9]', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro
      from public.pagamentos p
      join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '[^0-9]', '', 'g')
     where bn.b is null group by 1
  ),
  -- Ajuste acadêmico: contrato anulado/cancelado DENTRO de 2026/2 e sem
  -- confirmação no mesmo período. A janela acompanha o semestre do recorte
  -- (em 2026/1 a mesma regra usa jan–jun).
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') confirmado
      from public.prime_contratos group by 1
  ),
  -- TABULAÇÃO DE ENCERRAMENTO -- união de ficha e caso vivo. As grafias vêm
  -- medidas do banco (ver cabeçalho); normalização pela MESMA função que o
  -- resto do CRM usa, para não criar uma segunda régua.
  grafia_cancelamento as (
    select unnest(array['CANCELAMENTO COBRANCA','CANCELAMENTO DE COBRANCA',
                        'COBRANCA CANCELADA','CESSAR COBRANCA']) v
  ),
  grafia_suspensao as (
    select unnest(array['SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA']) v
  ),
  marca_ficha as (
    select a.id aluno_id,
           public.normalizar_status_acionamento(a.status_atual)
             in (select v from grafia_cancelamento) canc,
           public.normalizar_status_acionamento(a.status_atual)
             in (select v from grafia_suspensao) susp
      from public.alunos a
  ),
  marca_caso as (
    select c.aluno_id,
           bool_or(public.normalizar_status_acionamento(c.status_atual)
                     in (select v from grafia_cancelamento)) canc,
           bool_or(public.normalizar_status_acionamento(c.status_atual)
                     in (select v from grafia_suspensao)) susp
      from public.casos c
     where c.aluno_id is not null
       and public.normalizar_status_acionamento(c.status_atual) <> 'ENCERRADO'
     group by 1
  ),
  base as (
    select t.id, t.aluno_id,
           lpad(regexp_replace(coalesce(t.cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           t.documento, t.vencimento, t.valor_original vo, t.situacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo_crm,
           t.importacao_id, t.created_at::date entrada_em, t.origem_encerramento,
           coalesce(t.acordo_id, v.acordo_id) acordo_id, s.liq,
           (s.semestre is null) sem_serie,
           (upper(coalesce(t.situacao,'')) = 'CANCELADA') fora_da_base
      from public.acordos_titulos t
      left join serie s on s.b = regexp_replace(coalesce(t.documento,''), '[^0-9]', '', 'g')
      left join public.acordo_titulo_vinculo v on v.titulo_id = t.id and v.ativo
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto,'') <> 'Acordo'
       and coalesce(s.semestre,
             case when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01'
                  then '2026/2' end) = '2026/2'
  ),
  marcado as (
    select b.*, ac.numero_ulbra, ac.status acordo_status, ac.ratio, ac.estado,
           (b.liq is not null and b.liq > b.vencimento + 30 and b.liq >= b.entrada_em) liq_real,
           (b.liq is null) sem_linha,
           (cf.primeiro is not null and cf.primeiro >= b.liq - 30) origem_provada,
           (cf.cpf is not null) tem_caixa_fora,
           (coalesce(acd.anulado, false) and not coalesce(acd.confirmado, false)) academico,
           (coalesce(mf.canc,false) or coalesce(mk.canc,false)) tab_canc,
           (coalesce(mf.susp,false) or coalesce(mk.susp,false)) tab_susp
      from base b
      left join acordo ac on ac.id = b.acordo_id
      left join caixa_fora cf on cf.cpf = b.cpf
      left join academico_cpf acd on acd.cpf = b.cpf
      left join marca_ficha mf on mf.aluno_id = b.aluno_id
      left join marca_caso  mk on mk.aluno_id = b.aluno_id
  ),
  classificado as (
    select m.*,
      case when m.fora_da_base then 'CANCELADO'
           when m.acordo_id is not null then 'CONVERTIDO'
           when m.situacao = 'PAGO' and greatest(m.vo - m.saldo_crm, 0) > 0 then 'CONVERTIDO'
           when m.liq_real and m.origem_provada then 'CONVERTIDO'
           when m.liq_real and m.academico then 'ACADEMICO'
           when m.liq_real then 'EM_CONFERENCIA'
           when m.tem_caixa_fora then 'EM_CONFERENCIA'
           when m.sem_linha then 'EM_CONFERENCIA'
           else 'SEM_NEGOCIACAO' end faixa,
      -- Recuperado: MESMA fórmula que a tela de Efetividade já mostra como
      -- "Valor recebido" -- rateio do valor original pelo % de parcelas PAGAS
      -- do acordo, ou (valor original - saldo) quando o próprio título é PAGO.
      -- Teto no valor original de propósito: juros, multa e honorário não
      -- aumentam a carteira recuperada.
      case when m.fora_da_base then 0
           when m.acordo_id is not null then round(m.vo * coalesce(m.ratio,0), 2)
           when m.situacao = 'PAGO' then round(greatest(m.vo - m.saldo_crm, 0), 2)
           else 0 end recuperado
    from marcado m
  )
  select
    c.id, c.aluno_id, c.cpf, c.documento, c.vencimento,
    date_trunc('month', c.vencimento)::date,
    round(c.vo,2), c.situacao,
    c.acordo_id, c.numero_ulbra, coalesce(c.estado, 'sem_acordo'),
    c.faixa,
    case when c.fora_da_base then 'Cobrança cancelada'
         when c.acordo_id is not null then
           case when coalesce(c.ratio,0) >= 1 then 'Pago / Quitado'
                when c.estado = 'regular'   then 'Negociado regular'
                when c.estado = 'atraso'    then 'Negociado em atraso'
                when c.estado = 'quebrado'  then 'Acordo quebrado'
                when c.estado = 'cancelado' then 'Acordo cancelado'
                else 'Negociado regular' end
         when c.situacao = 'PAGO' and greatest(c.vo - c.saldo_crm, 0) > 0 then 'Pago / Quitado'
         when c.liq_real and c.origem_provada then 'Convertido com origem comprovada'
         when c.liq_real and c.academico then 'Baixa / ajuste acadêmico'
         when c.liq_real then 'Liquidado no Prime, origem não comprovada'
         when c.tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         when c.sem_linha then 'Sem confirmação do Prime (título não encontrado)'
         else 'Sem pagamento e sem negociação' end,
    c.recuperado,
    case when c.fora_da_base then 0 else round(greatest(c.vo - c.recuperado, 0), 2) end,
    (not c.fora_da_base and c.recuperado >= round(c.vo,2) - 0.005),
    case when c.sem_serie then 'vencimento (sem série no Prime)' else 'série do Prime' end,
    case when c.fora_da_base
         then coalesce(nullif(c.origem_encerramento,''), 'Sem motivo registrado') end,
    -- COLUNA NOVA. Não entra em nenhuma conta: é rótulo.
    case when c.fora_da_base then null
         when c.tab_canc then 'CANCELAMENTO'
         when c.tab_susp then 'SUSPENSAO' end
  from classificado c;
$function$;

-- A funcao NASCE com EXECUTE para authenticated (ALTER DEFAULT PRIVILEGES).
-- Fechar aqui mantem a decisao da versao 20260927224458.
revoke all on function public.carteira_2026_2_classificar() from public;
revoke all on function public.carteira_2026_2_classificar() from anon;
revoke all on function public.carteira_2026_2_classificar() from authenticated;
grant execute on function public.carteira_2026_2_classificar() to service_role;

-- ---------------------------------------------------------------------------
-- 2. PAINEL. Assinatura igual (jsonb), entao CREATE OR REPLACE -- que PRESERVA
-- a ACL existente, inclusive o EXECUTE de authenticated que a tela precisa.
-- As quatro chaves novas entram no agregado; `to_jsonb(a)` leva todas elas
-- para cada competencia automaticamente, e a chave passa a EXISTIR sempre --
-- e isso que a tela usa para decidir se mostra o bloco.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_competencias()
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with c as (select * from public.carteira_2026_2_classificar()),
  agregado as (
    select
      competencia,
      min(vencimento) vencimento_de,
      max(vencimento) vencimento_ate,
      count(distinct vencimento) datas_de_vencimento,
      count(*) titulos,
      count(distinct aluno_id) alunos,
      round(sum(valor_original),2) valor_original,
      round(sum(recuperado),2) recuperado,
      count(*) filter (where recuperado > 0) titulos_com_pagamento,
      count(*) filter (where liquidado_total) titulos_liquidados,
      count(*) filter (where faixa = 'CONVERTIDO') convertido_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'CONVERTIDO'),0),2) convertido_valor,
      count(*) filter (where faixa = 'EM_CONFERENCIA') conferencia_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'EM_CONFERENCIA'),0),2) conferencia_valor,
      count(*) filter (where faixa = 'ACADEMICO') academico_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'ACADEMICO'),0),2) academico_valor,
      count(*) filter (where faixa = 'SEM_NEGOCIACAO') sem_negociacao_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'SEM_NEGOCIACAO'),0),2) sem_negociacao_valor,
      count(*) filter (where faixa = 'CANCELADO') cancelado_titulos,
      round(coalesce(sum(valor_original) filter (where faixa = 'CANCELADO'),0),2) cancelado_valor,
      count(distinct acordo_id) filter (where acordo_estado = 'cancelado') acordos_cancelados,
      round(coalesce(sum(valor_original) filter (where acordo_estado = 'cancelado'),0),2) acordos_cancelados_valor,
      count(*) filter (where saldo > 0) saldo_titulos,
      round(coalesce(sum(saldo),0),2) saldo_valor,
      count(*) filter (where fonte_semestre <> 'série do Prime') fallback_titulos,
      round(coalesce(sum(valor_original) filter (where fonte_semestre <> 'série do Prime'),0),2) fallback_valor,
      -- NOVOS. Não entram em nenhum outro agregado: são leitura paralela.
      count(*) filter (where encerramento_tabulacao = 'CANCELAMENTO') tab_cancelamento_titulos,
      round(coalesce(sum(valor_original) filter (where encerramento_tabulacao = 'CANCELAMENTO'),0),2) tab_cancelamento_valor,
      count(*) filter (where encerramento_tabulacao = 'SUSPENSAO') tab_suspensao_titulos,
      round(coalesce(sum(valor_original) filter (where encerramento_tabulacao = 'SUSPENSAO'),0),2) tab_suspensao_valor
    from c group by 1
  ),
  -- Cancelamento de COBRANÇA por motivo. Não confundir com acordo cancelado,
  -- que tem campo próprio em cada bloco.
  motivos as (
    select motivo_cancelamento motivo, count(*) titulos,
           round(sum(valor_original),2) valor
      from c where faixa = 'CANCELADO' group by 1
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'semestre', '2026/2',
    'atualizado_em', jsonb_build_object(
      'prime_coletado_em', (select max(coletado_em) from public.prime_titulo_semestre),
      'ultima_entrada',    (select max(t.created_at)::date from public.acordos_titulos t
                             where t.id in (select titulo_id from c)),
      'titulo_mexido_em',  (select max(t.atualizado_em) from public.acordos_titulos t
                             where t.id in (select titulo_id from c))
    ),
    'total', (
      select jsonb_build_object(
        'competencias', count(*),
        'titulos', sum(titulos), 'alunos', (select count(distinct aluno_id) from c),
        'vencimento_de', min(vencimento_de), 'vencimento_ate', max(vencimento_ate),
        'valor_original', round(sum(valor_original),2),
        'recuperado', round(sum(recuperado),2),
        'titulos_com_pagamento', sum(titulos_com_pagamento),
        'titulos_liquidados', sum(titulos_liquidados),
        'convertido_titulos', sum(convertido_titulos), 'convertido_valor', round(sum(convertido_valor),2),
        'conferencia_titulos', sum(conferencia_titulos), 'conferencia_valor', round(sum(conferencia_valor),2),
        'academico_titulos', sum(academico_titulos), 'academico_valor', round(sum(academico_valor),2),
        'sem_negociacao_titulos', sum(sem_negociacao_titulos),
        'sem_negociacao_valor', round(sum(sem_negociacao_valor),2),
        'cancelado_titulos', sum(cancelado_titulos), 'cancelado_valor', round(sum(cancelado_valor),2),
        'acordos_cancelados', (select count(distinct acordo_id) from c where acordo_estado = 'cancelado'),
        'acordos_cancelados_valor', round(sum(acordos_cancelados_valor),2),
        'saldo_titulos', sum(saldo_titulos), 'saldo_valor', round(sum(saldo_valor),2),
        'fallback_titulos', sum(fallback_titulos), 'fallback_valor', round(sum(fallback_valor),2),
        'tab_cancelamento_titulos', sum(tab_cancelamento_titulos),
        'tab_cancelamento_valor', round(sum(tab_cancelamento_valor),2),
        'tab_suspensao_titulos', sum(tab_suspensao_titulos),
        'tab_suspensao_valor', round(sum(tab_suspensao_valor),2)
      ) from agregado
    ),
    'cancelados_por_motivo', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'motivo', motivo, 'titulos', titulos, 'valor', valor) order by valor desc), '[]'::jsonb)
        from motivos
    ),
    'competencias', (
      select coalesce(jsonb_agg(to_jsonb(a) order by a.competencia desc), '[]'::jsonb)
        from agregado a
    )
  ) into v_out;

  return v_out;
end; $function$;

-- ---------------------------------------------------------------------------
-- 3. DETALHE. Assinatura igual, entao CREATE OR REPLACE preserva a ACL.
-- Ganha `aluno_id` em cada linha e os dois indicadores novos, para o
-- drill-down das duas linhas de tabulacao.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_competencia_detalhe(
  p_competencia date default null::date, p_indicador text default 'entradas'::text,
  p_limite integer default 200, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_out jsonb; v_ind text; v_comp date;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  p_limite := least(greatest(coalesce(p_limite,200),1), 500);
  p_offset := greatest(coalesce(p_offset,0), 0);
  -- Aceita qualquer dia do mês e normaliza: quem chama manda a competência
  -- como veio do painel, e o dia 1 é detalhe de representação, não contrato.
  v_comp := date_trunc('month', p_competencia)::date;
  v_ind := lower(coalesce(nullif(p_indicador,''), 'entradas'));
  if v_ind not in ('entradas','recuperado','liquidados','convertido','em_conferencia',
                   'academico','sem_negociacao','cancelado','acordos_cancelados','saldo',
                   'tab_cancelamento','tab_suspensao') then
    raise exception 'Indicador desconhecido: %', p_indicador using errcode = '22023';
  end if;

  -- Um único CTE alimenta a contagem e a página: o classificador roda uma vez.
  with filtrado as (
    select c.* from public.carteira_2026_2_classificar() c
     where (v_comp is null or c.competencia = v_comp)
       and case v_ind
             when 'entradas'           then true
             when 'recuperado'         then c.recuperado > 0
             when 'liquidados'         then c.liquidado_total
             when 'convertido'         then c.faixa = 'CONVERTIDO'
             when 'em_conferencia'     then c.faixa = 'EM_CONFERENCIA'
             when 'academico'          then c.faixa = 'ACADEMICO'
             when 'sem_negociacao'     then c.faixa = 'SEM_NEGOCIACAO'
             when 'cancelado'          then c.faixa = 'CANCELADO'
             when 'acordos_cancelados' then c.acordo_estado = 'cancelado'
             when 'saldo'              then c.saldo > 0
             when 'tab_cancelamento'   then c.encerramento_tabulacao = 'CANCELAMENTO'
             when 'tab_suspensao'      then c.encerramento_tabulacao = 'SUSPENSAO'
           end
  ),
  -- O total do rodapé soma a MESMA grandeza do card clicado, nunca outra.
  resumo as (
    select count(*) titulos,
           round(coalesce(sum(case v_ind when 'recuperado' then recuperado
                                         when 'saldo'      then saldo
                                         else valor_original end),0),2) valor
      from filtrado
  ),
  pagina as (
    select * from filtrado order by valor_original desc limit p_limite offset p_offset
  )
  select jsonb_build_object(
    'indicador', v_ind,
    'competencia', v_comp,
    'total_titulos', (select titulos from resumo),
    'total_valor',   (select valor   from resumo),
    'limite', p_limite, 'offset', p_offset,
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'aluno', coalesce(al.nome, '(sem nome)'),
               -- aluno_id: só o identificador interno, para abrir a ficha.
               -- Nenhum dado pessoal novo -- o CPF segue mascarado abaixo.
               'aluno_id', z.aluno_id,
               'cpf', case when length(z.cpf) = 11
                           then substr(z.cpf,1,3) || '.***.' || substr(z.cpf,7,3) || '-**' else '***' end,
               'documento', z.documento,
               'vencimento', z.vencimento,
               'competencia', z.competencia,
               'valor_original', z.valor_original,
               'acordo', coalesce(z.acordo_numero, '(sem número)'),
               'acordo_estado', z.acordo_estado,
               'situacao', z.sub_faixa,
               'recuperado', z.recuperado,
               'saldo', z.saldo,
               'motivo_cancelamento', z.motivo_cancelamento,
               'encerramento_tabulacao', z.encerramento_tabulacao,
               'fonte_semestre', z.fonte_semestre
             ) order by z.valor_original desc)
        from pagina z left join public.alunos al on al.id = z.aluno_id
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end; $function$;

-- ---------------------------------------------------------------------------
-- 4. GUARDA DE PERMISSOES -- ANTES do commit, dentro da mesma transacao.
--
-- Conferir depois do commit nao adianta: a exposicao ja teria existido. Aqui,
-- qualquer acesso indevido ABORTA e nada e publicado.
--
-- proacl NULO nao e "sem privilegio": em Postgres significa o DEFAULT, que
-- inclui EXECUTE para PUBLIC. Por isso ele e recusado explicitamente --
-- aclexplode(null) nao devolve linha nenhuma e passaria batido.
-- ---------------------------------------------------------------------------
do $guarda$
declare
  v_acl aclitem[];
  v_quem text;
  n int;
begin
  -- 4.1 as tres funcoes tem de existir
  select count(*) into n from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('carteira_2026_2_classificar','carteira_2026_2_competencias',
                     'carteira_2026_2_competencia_detalhe');
  if n <> 3 then
    raise exception 'ABORTADO: esperadas 3 funcoes, encontradas %', n;
  end if;

  -- 4.2 o classificador NAO pode estar aberto
  select proacl into v_acl from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'carteira_2026_2_classificar';
  if v_acl is null then
    raise exception 'ABORTADO: proacl nulo no classificador -- isso e o DEFAULT e da EXECUTE a PUBLIC';
  end if;
  for v_quem in
    select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC')
      from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE'
  loop
    if v_quem in ('PUBLIC','anon','authenticated') then
      raise exception 'ABORTADO: % ainda tem EXECUTE no classificador', v_quem;
    end if;
  end loop;
  if not exists (
    select 1 from aclexplode(v_acl) a
     where a.privilege_type = 'EXECUTE' and a.grantee::regrole::text = 'service_role') then
    raise exception 'ABORTADO: service_role perdeu EXECUTE no classificador';
  end if;

  -- 4.3 as duas funcoes da tela PRECISAM continuar abertas para authenticated,
  -- senao o painel morre para a propria gestao. anon nunca.
  for v_quem in
    select p.proname from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('carteira_2026_2_competencias','carteira_2026_2_competencia_detalhe')
  loop
    select proacl into v_acl from pg_proc
     where pronamespace = 'public'::regnamespace and proname = v_quem;
    if v_acl is null then
      raise exception 'ABORTADO: proacl nulo em % -- PUBLIC teria EXECUTE', v_quem;
    end if;
    if not exists (select 1 from aclexplode(v_acl) a
                    where a.privilege_type = 'EXECUTE'
                      and a.grantee::regrole::text = 'authenticated') then
      raise exception 'ABORTADO: authenticated perdeu EXECUTE em % -- a tela quebraria', v_quem;
    end if;
    if exists (select 1 from aclexplode(v_acl) a
                where a.privilege_type = 'EXECUTE'
                  and coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') in ('PUBLIC','anon')) then
      raise exception 'ABORTADO: PUBLIC ou anon tem EXECUTE em %', v_quem;
    end if;
  end loop;

  -- 4.4 NENHUM titulo pode ter mudado de classificacao.
  --
  -- Comparacao linha a linha contra a fotografia do passo 0, no mesmo instante
  -- e na mesma transacao. NAO se cravam totais aqui de proposito: a base e viva
  -- -- parcela que e paga, acordo que muda de status, coleta nova do Prime --
  -- e um numero escrito a mao hoje reprovaria amanha sem haver defeito nenhum.
  -- O que tem de ser igual e a classificacao de cada titulo, nao o total do dia.
  select count(*) into n from _antes_2026_2 a
    full join public.carteira_2026_2_classificar() d on d.titulo_id = a.titulo_id
   where a.titulo_id is null or d.titulo_id is null
      or a.faixa               is distinct from d.faixa
      or a.sub_faixa           is distinct from d.sub_faixa
      or a.recuperado          is distinct from d.recuperado
      or a.saldo               is distinct from d.saldo
      or a.valor_original      is distinct from d.valor_original
      or a.liquidado_total     is distinct from d.liquidado_total
      or a.acordo_estado       is distinct from d.acordo_estado
      or a.fonte_semestre      is distinct from d.fonte_semestre
      or a.motivo_cancelamento is distinct from d.motivo_cancelamento;
  if n <> 0 then
    raise exception 'ABORTADO: % titulo(s) mudaram de classificacao -- a coluna nova devia ser so rotulo', n;
  end if;

  -- 4.5 a contagem nao pode crescer. Os dois LEFT JOIN novos sao por aluno; se
  -- um deles devolvesse mais de uma linha por aluno, os titulos se
  -- multiplicariam em silencio e os totais da tela inflariam.
  select count(*) into n from public.carteira_2026_2_classificar();
  if n <> (select count(*) from _antes_2026_2) then
    raise exception 'ABORTADO: o classificador passou de % para % linhas',
      (select count(*) from _antes_2026_2), n;
  end if;

  -- 4.6 a marca tem de ser EXCLUSIVA da situacao CANCELADA: se um titulo
  -- CANCELADO carregasse tabulacao, o card somaria a mesma mensalidade duas
  -- vezes e o "total sem duplicidade" seria mentira.
  select count(*) into n from public.carteira_2026_2_classificar()
   where faixa = 'CANCELADO' and encerramento_tabulacao is not null;
  if n <> 0 then
    raise exception 'ABORTADO: % titulo(s) CANCELADO com tabulacao -- haveria duplicidade no card', n;
  end if;
end
$guarda$;

commit;

-- ============================================================================
-- VALIDACAO -- o que foi feito, e o que NAO foi possivel fazer.
--
-- FEITO, em 28/09/2026, SOMENTE LEITURA contra producao -- nada criado, nada
-- escrito. A logica ANTES e a logica DEPOIS foram executadas INLINE, como
-- consulta, no MESMO instante e sobre o MESMO snapshot, e comparadas titulo a
-- titulo:
--
--     linhas antes ............ 2.525
--     linhas depois ........... 2.525
--     linhas com diferenca .......... 0   (faixa, recuperado e valor original)
--     titulos so de um lado ......... 0
--     com tabulacao ............... 101
--
-- Comparar com os totais de ONTEM nao provaria nada: a base e viva e os
-- indicadores mudam sozinhos de um dia para o outro. A prova util e esta --
-- mesma foto, duas logicas, zero diferenca.
--
-- NAO FOI POSSIVEL: rodar isto num banco isolado. Esta maquina nao tem Docker
-- nem Postgres local, e criar branch/projeto Supabase e proibido por custo.
-- Entao NAO foram exercitados: o DROP/CREATE em si, a ACL resultante, a guarda
-- deste arquivo e o comportamento transacional. Eles estao escritos para
-- falhar fechado -- abortam em vez de publicar --, mas nao foram executados.
-- Quem aplicar deve estar pronto para um ROLLBACK imediato se a guarda disparar.
--
-- A normalizacao das grafias foi validada com o corpo de
-- normalizar_status_acionamento copiado inline (a funcao nao e executavel pelo
-- usuario somente-leitura). O corpo usa '[_\-]+' e a validacao usou '[-_]+' --
-- classes de caractere equivalentes.
-- ============================================================================
