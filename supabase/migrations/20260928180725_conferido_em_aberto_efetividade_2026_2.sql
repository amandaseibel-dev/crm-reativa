-- APLICADA EM PRODUCAO em 28/09/2026 18:07:25 UTC, versao 20260928180725.
--
-- O arquivo aqui carrega a documentacao inteira; o que rodou foram os mesmos
-- comandos sem os comentarios (md5 54c49541740aa173c5eb88b4ab8408ad, 23452
-- bytes, registrado em schema_migrations). Comentario nao muda comportamento,
-- entao rodar este arquivo num ambiente novo produz o mesmo resultado.
--
-- ============================================================================
-- O PROBLEMA, medido em 28/09/2026 nos 583 titulos de 2026/2 em "Em conferencia":
--
-- A gestao consulta o titulo na tela do Prime, confirma que a divida e devida e
-- esta em aberto, sem pagamento nem negociacao -- e NAO TEM ONDE REGISTRAR ISSO
-- de um jeito que a Efetividade respeite. Duas lacunas, as duas medidas:
--
--   1. A Efetividade IGNORA a Conferencia Prime. O classificador
--      carteira_2026_2_classificar() nunca leu prime_conferencia_decisao: a
--      faixa e recalculada a cada carga a partir da extracao do Prime. Prova em
--      producao: o titulo 4429210 (R$ 18.326,82) foi REJEITADO em 28/09, esta
--      com situacao ABERTO, e CONTINUA em "Em conferencia" -- porque a extracao
--      segue dizendo liquidado em 09/09.
--
--   2. 405 dos 583 titulos (R$ 620.463,48) NAO TEM LINHA na fila da Conferencia
--      Prime. prime_conferencia_rejeitar recusa com SEM_DECISAO_PENDENTE: "so se
--      rejeita o que esta na fila". Para 69% da faixa nao existe botao nenhum.
--      E justamente os dois motivos que casam com "consultei e esta em aberto"
--      -- "paga acordo fora do CRM" (181) e "sem confirmacao do Prime" (138) --
--      tem so 5 e 4 titulos na fila.
--
-- ============================================================================
-- O QUE ESTA PROPOSTA FAZ, e o que ela deliberadamente NAO faz.
--
-- FAZ: cria um registro PROPRIO de conferencia -- "Conferido no Prime: divida
-- devida, em aberto, sem pagamento ou negociacao" -- disponivel para a gestao em
-- QUALQUER titulo da faixa, com ou sem linha na fila; e faz o classificador ler
-- esse registro, movendo o titulo para SEM_NEGOCIACAO.
--
-- NAO FAZ: nao mexe em prime_conferencia_decisao, nao reinterpreta nenhuma
-- decisao existente, nao cria baixa, cancelamento ou pagamento, nao altera
-- valor, vencimento nem saldo. O titulo continua exigivel pelo mesmo valor.
--
-- ============================================================================
-- POR QUE TABELA NOVA, e nao mais uma decisao em prime_conferencia_decisao.
--
-- Aquela tabela e a fila: tem PENDENTE/VINCULADO/REJEITADO/CONFIRMADO, com
-- semantica, gatilhos e telas proprias, e 712 linhas PENDENTE vivas. Enfiar um
-- quinto estado ali mudaria o significado de tudo que le a fila -- e o pedido e
-- explicito: nao reinterpretar as decisoes existentes. Tabela separada tambem e
-- o que permite atender os 405 sem linha na fila, sem inventar linha para eles.
--
-- ============================================================================
-- REGRA 4 -- O QUE NAO PODE VIRAR COBRANCA.
--
-- "Debito indevido", bolsa e cancelamento exigem tratamento proprio. Um titulo
-- que ja passou pela Conferencia Prime com decisao REJEITADO, CONFIRMADO ou
-- VINCULADO NAO aceita esta confirmacao -- a RPC recusa e diz o porque. O caso
-- 4429210 ("aluno possui bolsa, o debito e indevido") e exatamente o que essa
-- trava protege: ele nao pode ser reinterpretado como divida devida por um
-- fluxo novo. Titulo com linha PENDENTE continua aceito, porque PENDENTE e
-- ausencia de decisao, nao decisao.
--
-- ============================================================================
-- REGRA 5 -- QUANDO A CONFIRMACAO VALE, E QUANDO O TITULO VOLTA.
--
-- A confirmacao descreve um ESTADO conferido, nao um carimbo permanente. Ela
-- guarda a assinatura do que foi visto e so vale enquanto essa assinatura
-- continuar verdadeira. O titulo VOLTA sozinho para "Em conferencia" quando:
--
--   - aparecer acordo (acordo_id no titulo ou vinculo ativo);
--   - aparecer pagamento (situacao PAGO, ou recuperado > 0);
--   - o valor original mudar;
--   - a liquidacao no Prime mudar -- inclusive passar de nula para preenchida,
--     ou de uma data para outra. Evidencia nova de pagamento no Prime tem de
--     reabrir a conferencia, nunca ficar escondida atras da confirmacao.
--
-- Nada disso precisa de rotina: e avaliado a cada carga, no proprio
-- classificador. Se a assinatura quebra, a confirmacao deixa de ser aplicada no
-- mesmo instante -- e o registro continua no historico, com invalidada_em
-- preenchido pela funcao de leitura, para se saber que existiu e por que caiu.
--
-- ============================================================================
-- REGRA 3 -- SO SAI DA CONFERENCIA SE NAO HOUVER ACORDO NEM PAGAMENTO.
--
-- Garantido em tres lugares independentes, de proposito:
--   a) a RPC recusa no momento de salvar;
--   b) a validade (regra 5) deixa de valer se aparecerem depois;
--   c) no classificador, o ramo novo entra DEPOIS dos ramos CONVERTIDO e
--      ACADEMICO -- entao acordo, titulo PAGO com diferenca, origem comprovada
--      e ajuste academico continuam tendo precedencia.
--
-- ATENCAO, medido: existem 7 titulos EM_CONFERENCIA com situacao 'PAGO' cuja
-- diferenca (valor - saldo) e ZERO, entao eles NAO caem no ramo CONVERTIDO e
-- passariam pela ordem dos ramos. A RPC e a validade recusam situacao PAGO
-- explicitamente, sem depender da ordem.
--
-- SALDO: medido em 28/09, os 583 titulos em conferencia tem recuperado ZERO e
-- acordo ZERO. Em SEM_NEGOCIACAO o recuperado tambem e zero. Logo saldo =
-- valor_original nos dois lados: mover entre as faixas NAO altera saldo,
-- recuperado, convertido nem entradas. So muda de qual faixa o valor aparece.
--
-- ============================================================================
-- REGRA 6 -- CONFIRMAR O QUE FOI VISTO, NAO O QUE MUDOU.
--
-- A tela manda de volta o que ela EXIBIU: valor original, situacao e a
-- liquidacao do Prime. Se qualquer um tiver mudado entre abrir e salvar, a RPC
-- recusa com ESTADO_MUDOU e pede recarregar. Sem isso, alguem confirmaria "em
-- aberto, sem pagamento" sobre um titulo que acabou de ser pago -- e a
-- confirmacao nasceria descrevendo um estado que ja nao existe.
--
-- ============================================================================
-- DEPENDENCIA COM A PROPOSTA PAUSADA DO PR #542.
--
-- PROPOSTA_cancelamento_e_suspensao_no_card.sql redefine ESTE MESMO
-- classificador (DROP + CREATE, para acrescentar encerramento_tabulacao) e foi
-- escrita sobre a versao de producao de 27/09 -- que nao tem o ramo novo.
-- Aplicar aquela depois desta APAGARIA esta correcao em silencio: o classificador
-- voltaria a ignorar a confirmacao e os titulos conferidos voltariam para "Em
-- conferencia" sem ninguem mexer em nada.
--
-- ENTAO: antes de retomar o #542, a proposta dele tem de ser reescrita sobre o
-- classificador que ESTA proposta deixa -- com o ramo conferido_em_aberto e a
-- CTE de validade --, e a guarda dela passa a ter de conferir tambem que os
-- titulos conferidos continuam em SEM_NEGOCIACAO. Isto esta registrado no corpo
-- do PR e aqui, que e onde quem for aplicar vai olhar.
--
-- ============================================================================
-- ROLLBACK: recriar o classificador na forma de producao de 27/09 (guardada no
-- ledger da versao 20260927221825) e manter a tabela -- ela e historico, nao
-- estorva ninguem. Derrubar a tabela apagaria as conferencias feitas.

begin;

-- ---------------------------------------------------------------------------
-- 0. FOTOGRAFIA DO ANTES -- antes de trocar o classificador.
--
-- A tabela nasce VAZIA, entao a propriedade de seguranca desta migration e
-- forte e verificavel: aplicar NAO PODE mover nenhum titulo de faixa. Qualquer
-- diferenca aqui significa que a reescrita do classificador errou alguma coisa,
-- e nada e publicado.
-- ---------------------------------------------------------------------------
create temporary table _antes_conf on commit drop as
select titulo_id, faixa, sub_faixa, recuperado, saldo, valor_original,
       liquidado_total, acordo_estado, fonte_semestre, motivo_cancelamento
  from public.carteira_2026_2_classificar();

-- ---------------------------------------------------------------------------
-- 1. O REGISTRO
-- ---------------------------------------------------------------------------
create table if not exists public.titulo_conferido_em_aberto (
  titulo_id            uuid primary key references public.acordos_titulos(id) on delete cascade,
  aluno_id             uuid,
  documento            text,
  -- justificativa e referencia da evidencia: as duas obrigatorias, as duas do
  -- tamanho minimo que obriga a escrever alguma coisa util.
  justificativa        text not null check (length(btrim(justificativa)) >= 15),
  evidencia_referencia text not null check (length(btrim(evidencia_referencia)) >= 3),
  conferido_por        text not null,
  conferido_em         timestamptz not null default now(),
  -- ASSINATURA DO QUE FOI VISTO (regra 5). E contra ela que a validade e
  -- avaliada a cada carga.
  valor_original_visto numeric not null,
  situacao_vista       text    not null,
  prime_liquidado_visto date,
  -- Historico de quedas: preenchido quando a assinatura quebra. Nao apaga nada.
  invalidada_em        timestamptz,
  invalidada_motivo    text
);

comment on table public.titulo_conferido_em_aberto is
  'Conferencia manual da gestao: "divida devida, em aberto, sem pagamento ou negociacao". NAO e a fila da Conferencia Prime (prime_conferencia_decisao) e nao a reinterpreta. So vale enquanto a assinatura vista continuar verdadeira -- ver carteira_titulo_conferido_valido().';

create index if not exists ix_conferido_em_aberto_aluno
  on public.titulo_conferido_em_aberto (aluno_id);

alter table public.titulo_conferido_em_aberto enable row level security;
-- Sem policy: ninguem le nem escreve direto. Tudo passa pelas funcoes
-- SECURITY DEFINER abaixo, que checam gestao.
revoke all on table public.titulo_conferido_em_aberto from public, anon, authenticated;
grant select, insert, update on table public.titulo_conferido_em_aberto to service_role;

-- ---------------------------------------------------------------------------
-- 2. A VALIDADE (regra 5), em um lugar so.
--
-- Fica em funcao propria para o classificador e a RPC usarem a MESMA regra --
-- duplicar isso seria criar duas verdades que divergem no primeiro ajuste.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_titulo_conferido_valido(
  p_conferido_valor numeric, p_conferido_situacao text, p_conferido_liquidado date,
  p_valor_hoje numeric, p_situacao_hoje text, p_liquidado_hoje date,
  p_acordo_id uuid, p_recuperado numeric)
returns boolean language sql immutable
as $function$
  select p_conferido_valor is not null
     and p_acordo_id is null                                    -- apareceu acordo -> volta
     and coalesce(p_recuperado, 0) = 0                          -- apareceu pagamento -> volta
     and upper(coalesce(p_situacao_hoje,'')) <> 'PAGO'          -- titulo PAGO -> volta
     and round(coalesce(p_valor_hoje,0),2)
           = round(coalesce(p_conferido_valor,0),2)             -- valor mudou -> volta
     and p_liquidado_hoje is not distinct from p_conferido_liquidado;  -- Prime mudou -> volta
$function$;

comment on function public.carteira_titulo_conferido_valido is
  'Regra unica de validade da conferencia "em aberto". Falsa = o titulo volta para Em conferencia. Liquidacao nova no Prime invalida inclusive quando antes era nula: evidencia posterior de pagamento nunca fica escondida atras da confirmacao.';

revoke all on function public.carteira_titulo_conferido_valido(numeric,text,date,numeric,text,date,uuid,numeric)
  from public, anon, authenticated;
grant execute on function public.carteira_titulo_conferido_valido(numeric,text,date,numeric,text,date,uuid,numeric)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. O CLASSIFICADOR passa a LER a confirmacao.
--
-- CREATE OR REPLACE, NAO drop: a assinatura nao muda (a marca viaja em
-- `sub_faixa`, que ja e texto). Isso preserva a ACL fechada pela versao
-- 20260927224458 -- se fosse DROP + CREATE, a funcao renasceria com EXECUTE
-- para `authenticated` por causa do ALTER DEFAULT PRIVILEGES, e a correcao de
-- seguranca seria desfeita sem ninguem notar.
--
-- A unica mudanca de logica sao as duas linhas marcadas CONFERIDO. O resto e
-- identico a producao de 28/09/2026.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_2_classificar()
returns table(titulo_id uuid, aluno_id uuid, cpf text, documento text, vencimento date,
              competencia date, valor_original numeric, situacao_crm text, acordo_id uuid,
              acordo_numero text, acordo_estado text, faixa text, sub_faixa text,
              recuperado numeric, saldo numeric, liquidado_total boolean, fonte_semestre text,
              motivo_cancelamento text)
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
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-07-01' and valid_from < date '2027-01-01') confirmado
      from public.prime_contratos group by 1
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
           -- CONFERIDO (1/2): o registro da gestao, e SO se a assinatura dele
           -- ainda vale. Acordo, pagamento, valor novo ou liquidacao nova no
           -- Prime derrubam a validade na hora, sem rotina nenhuma.
           public.carteira_titulo_conferido_valido(
             co.valor_original_visto, co.situacao_vista, co.prime_liquidado_visto,
             b.vo, b.situacao, b.liq, b.acordo_id,
             case when b.situacao = 'PAGO' then greatest(b.vo - b.saldo_crm, 0) else 0 end
           ) conferido_valido
      from base b
      left join acordo ac on ac.id = b.acordo_id
      left join caixa_fora cf on cf.cpf = b.cpf
      left join academico_cpf acd on acd.cpf = b.cpf
      left join public.titulo_conferido_em_aberto co
             on co.titulo_id = b.id and co.invalidada_em is null
  ),
  classificado as (
    select m.*,
      case when m.fora_da_base then 'CANCELADO'
           when m.acordo_id is not null then 'CONVERTIDO'
           when m.situacao = 'PAGO' and greatest(m.vo - m.saldo_crm, 0) > 0 then 'CONVERTIDO'
           when m.liq_real and m.origem_provada then 'CONVERTIDO'
           when m.liq_real and m.academico then 'ACADEMICO'
           -- CONFERIDO (2/2): entra DEPOIS de CONVERTIDO e ACADEMICO, nunca
           -- antes. Acordo, pagamento e ajuste academico continuam vencendo.
           when m.conferido_valido then 'SEM_NEGOCIACAO'
           when m.liq_real then 'EM_CONFERENCIA'
           when m.tem_caixa_fora then 'EM_CONFERENCIA'
           when m.sem_linha then 'EM_CONFERENCIA'
           else 'SEM_NEGOCIACAO' end faixa,
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
         when c.conferido_valido then 'Conferido no Prime: em aberto, sem pagamento nem negociação'
         when c.liq_real then 'Liquidado no Prime, origem não comprovada'
         when c.tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         when c.sem_linha then 'Sem confirmação do Prime (título não encontrado)'
         else 'Sem pagamento e sem negociação' end,
    c.recuperado,
    case when c.fora_da_base then 0 else round(greatest(c.vo - c.recuperado, 0), 2) end,
    (not c.fora_da_base and c.recuperado >= round(c.vo,2) - 0.005),
    case when c.sem_serie then 'vencimento (sem série no Prime)' else 'série do Prime' end,
    case when c.fora_da_base
         then coalesce(nullif(c.origem_encerramento,''), 'Sem motivo registrado') end
  from classificado c;
$function$;

-- CREATE OR REPLACE preserva a ACL, entao em producao o classificador continua
-- fechado sem precisar destas linhas. Elas estao aqui mesmo assim, por dois
-- motivos concretos:
--   1. tornam a migration correta a partir de QUALQUER estado inicial -- se um
--      dia ela rodar sobre um banco onde a funcao nao foi fechada, ela fecha;
--   2. em Postgres funcao nasce com EXECUTE para PUBLIC, e PUBLIC nao aparece
--      em nenhum ALTER DEFAULT PRIVILEGES -- e o privilegio mais facil de
--      esquecer. O teste em Postgres isolado abortou exatamente por isso.
-- A guarda no fim CONFERE o resultado; estas linhas so garantem que ha o que
-- conferir.
revoke all on function public.carteira_2026_2_classificar() from public;
revoke all on function public.carteira_2026_2_classificar() from anon;
revoke all on function public.carteira_2026_2_classificar() from authenticated;
grant execute on function public.carteira_2026_2_classificar() to service_role;

-- ---------------------------------------------------------------------------
-- 4. O DETALHE passa a devolver o que a tela precisa para conferir.
--
-- CREATE OR REPLACE, assinatura igual: preserva a ACL, inclusive o EXECUTE de
-- `authenticated` sem o qual o painel morre para a propria gestao.
--
-- Tres campos novos, e todos existem por causa da regra 6: a tela so pode
-- mandar de volta o estado que ela EXIBIU se ela receber esse estado.
--   titulo_id       -> identifica o titulo na hora de salvar
--   situacao_crm    -> ja vinha do classificador, so nao era devolvido
--   prime_liquidado -> a liquidacao que a extracao mostra AGORA
--   conferido_*     -> se ja foi conferido, por quem e quando
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
  v_comp := date_trunc('month', p_competencia)::date;
  v_ind := lower(coalesce(nullif(p_indicador,''), 'entradas'));
  if v_ind not in ('entradas','recuperado','liquidados','convertido','em_conferencia',
                   'academico','sem_negociacao','cancelado','acordos_cancelados','saldo') then
    raise exception 'Indicador desconhecido: %', p_indicador using errcode = '22023';
  end if;

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
           end
  ),
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
               'fonte_semestre', z.fonte_semestre,
               -- NOVOS -- o estado que a tela devolve ao salvar (regra 6).
               'titulo_id', z.titulo_id,
               'situacao_crm', z.situacao_crm,
               'prime_liquidado', pl.liq,
               'conferido_por', co.conferido_por,
               'conferido_em', co.conferido_em
             ) order by z.valor_original desc)
        from pagina z
        left join public.alunos al on al.id = z.aluno_id
        left join lateral (
          select max(s.liquidado_em) liq from public.prime_titulo_semestre s
           where regexp_replace(coalesce(s.boleto,''), '[^0-9]', '', 'g')
               = regexp_replace(coalesce(z.documento,''), '[^0-9]', '', 'g')
             and coalesce(s.semestre,'') <> ''
        ) pl on true
        left join public.titulo_conferido_em_aberto co
               on co.titulo_id = z.titulo_id and co.invalidada_em is null
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end; $function$;

-- Mesma razao do classificador: PUBLIC e o privilegio esquecido. `authenticated`
-- NAO e revogado aqui -- e sem ele o painel morre para a propria gestao.
revoke all on function public.carteira_2026_2_competencia_detalhe(date,text,integer,integer) from public;
revoke all on function public.carteira_2026_2_competencia_detalhe(date,text,integer,integer) from anon;
grant execute on function public.carteira_2026_2_competencia_detalhe(date,text,integer,integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. A RPC QUE REGISTRA. E o unico caminho de escrita.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_conferir_em_aberto(
  p_titulo_id uuid,
  p_justificativa text,
  p_evidencia text,
  p_valor_visto numeric,
  p_situacao_vista text,
  p_liquidado_visto date default null)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_t public.acordos_titulos%rowtype;
  v_acordo uuid; v_liq date; v_dec text; v_rec numeric;
begin
  -- Gestao, como o resto da Conferencia Prime. service_role para rotina.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferir titulo em aberto e decisao da gestao.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_justificativa,''))) < 15 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: escreva o que foi conferido (minimo 15 caracteres).';
  end if;
  if length(btrim(coalesce(p_evidencia,''))) < 3 then
    raise exception 'EVIDENCIA_OBRIGATORIA: informe a referencia do que foi consultado no Prime.';
  end if;

  select * into v_t from public.acordos_titulos where id = p_titulo_id for update;
  if not found then raise exception 'TITULO_NAO_ENCONTRADO'; end if;

  -- REGRA 4: quem ja passou pela Conferencia Prime tem tratamento proprio.
  -- "Debito indevido", bolsa e cancelamento NAO viram divida devida por aqui.
  select d.decisao into v_dec from public.prime_conferencia_decisao d where d.titulo_id = p_titulo_id;
  if v_dec in ('REJEITADO','CONFIRMADO','VINCULADO') then
    raise exception 'DECISAO_EXISTENTE: este titulo ja tem decisao % na Conferencia Prime. '
      'Debito indevido, bolsa e cancelamento exigem tratamento proprio e nao autorizam cobranca por aqui.', v_dec;
  end if;

  -- REGRA 3: nada de acordo, nada de pagamento.
  select coalesce(v_t.acordo_id, (select v.acordo_id from public.acordo_titulo_vinculo v
                                   where v.titulo_id = p_titulo_id and v.ativo limit 1))
    into v_acordo;
  if v_acordo is not null then
    raise exception 'TEM_ACORDO: o titulo esta ligado a um acordo -- nao e caso de "sem negociacao".';
  end if;
  if upper(coalesce(v_t.situacao,'')) = 'PAGO' then
    raise exception 'TEM_PAGAMENTO: o titulo esta PAGO no CRM.';
  end if;
  if upper(coalesce(v_t.situacao,'')) = 'CANCELADA' then
    raise exception 'CANCELADA: cobranca cancelada tem tratamento proprio.';
  end if;
  v_rec := case when v_t.situacao = 'PAGO'
                then greatest(v_t.valor_original - coalesce(v_t.saldo_corrigido, v_t.valor_em_aberto,
                                                            v_t.valor_original, 0), 0) else 0 end;
  if coalesce(v_rec,0) > 0 then
    raise exception 'TEM_PAGAMENTO: ha valor recuperado identificado neste titulo.';
  end if;

  select max(s.liquidado_em) into v_liq from public.prime_titulo_semestre s
   where regexp_replace(coalesce(s.boleto,''), '[^0-9]', '', 'g')
       = regexp_replace(coalesce(v_t.documento,''), '[^0-9]', '', 'g')
     and coalesce(s.semestre,'') <> '';

  -- REGRA 6: confirmar o que foi visto, nao o que mudou enquanto a tela estava
  -- aberta. Nao ha "confirmar mesmo assim": recarregar e olhar de novo e o
  -- caminho, porque o que mudou pode ser exatamente um pagamento.
  if round(coalesce(p_valor_visto,-1),2) <> round(coalesce(v_t.valor_original,0),2)
     or upper(coalesce(p_situacao_vista,'')) <> upper(coalesce(v_t.situacao,''))
     or v_liq is distinct from p_liquidado_visto then
    raise exception 'ESTADO_MUDOU: o titulo mudou desde que a tela carregou '
      '(valor %, situacao %, liquidacao Prime %). Recarregue e confira de novo.',
      v_t.valor_original, v_t.situacao, coalesce(v_liq::text,'nenhuma');
  end if;

  insert into public.titulo_conferido_em_aberto
    (titulo_id, aluno_id, documento, justificativa, evidencia_referencia,
     conferido_por, conferido_em, valor_original_visto, situacao_vista, prime_liquidado_visto)
  values (p_titulo_id, v_t.aluno_id, v_t.documento, btrim(p_justificativa), btrim(p_evidencia),
          v_email, now(), v_t.valor_original, v_t.situacao, v_liq)
  on conflict (titulo_id) do update
    set justificativa = excluded.justificativa,
        evidencia_referencia = excluded.evidencia_referencia,
        conferido_por = excluded.conferido_por,
        conferido_em = excluded.conferido_em,
        valor_original_visto = excluded.valor_original_visto,
        situacao_vista = excluded.situacao_vista,
        prime_liquidado_visto = excluded.prime_liquidado_visto,
        invalidada_em = null, invalidada_motivo = null;

  -- Historico na ficha. NAO muda situacao, status, valor nem saldo: o titulo
  -- continua exigivel exatamente como estava.
  if v_t.aluno_id is not null then
    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo,
       registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
    values (v_t.aluno_id::text, 'TITULO_CONFERIDO_EM_ABERTO',
            'Titulo ' || coalesce(v_t.documento,'?') || ' conferido no Prime: divida devida, em aberto, '
            || 'sem pagamento ou negociacao. Evidencia: ' || btrim(p_evidencia)
            || '. Justificativa: ' || btrim(p_justificativa),
            v_t.situacao, v_t.situacao, v_email, v_email, now(),
            round(coalesce(v_t.valor_original,0),2));
  end if;

  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id,
                            'conferido_por', v_email, 'conferido_em', now(),
                            'prime_liquidado', v_liq);
end; $function$;

revoke all on function public.carteira_conferir_em_aberto(uuid,text,text,numeric,text,date)
  from public, anon;
grant execute on function public.carteira_conferir_em_aberto(uuid,text,text,numeric,text,date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. GUARDA -- ANTES do commit, na mesma transacao. Conferir depois nao adianta.
-- ---------------------------------------------------------------------------
do $guarda$
declare v_acl aclitem[]; v_quem text; n int;
begin
  -- 6.1 aplicar com a tabela vazia NAO pode mover ninguem de faixa.
  select count(*) into n from _antes_conf a
    full join public.carteira_2026_2_classificar() d on d.titulo_id = a.titulo_id
   where a.titulo_id is null or d.titulo_id is null
      or a.faixa           is distinct from d.faixa
      or a.sub_faixa       is distinct from d.sub_faixa
      or a.recuperado      is distinct from d.recuperado
      or a.saldo           is distinct from d.saldo
      or a.valor_original  is distinct from d.valor_original
      or a.liquidado_total is distinct from d.liquidado_total;
  if n <> 0 then
    raise exception 'ABORTADO: % titulo(s) mudaram de faixa com a tabela vazia -- a reescrita errou', n;
  end if;

  select count(*) into n from public.carteira_2026_2_classificar();
  if n <> (select count(*) from _antes_conf) then
    raise exception 'ABORTADO: o classificador passou de % para % linhas',
      (select count(*) from _antes_conf), n;
  end if;

  if (select count(*) from public.titulo_conferido_em_aberto) <> 0 then
    raise exception 'ABORTADO: a tabela devia nascer vazia';
  end if;

  -- 6.2 o classificador continua FECHADO. CREATE OR REPLACE preserva a ACL,
  -- mas confirmar e barato e a versao 20260927224458 depende disso.
  select proacl into v_acl from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'carteira_2026_2_classificar';
  if v_acl is null then
    raise exception 'ABORTADO: proacl nulo no classificador -- isso E o default e da EXECUTE a PUBLIC';
  end if;
  for v_quem in
    select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC')
      from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE'
  loop
    if v_quem in ('PUBLIC','anon','authenticated') then
      raise exception 'ABORTADO: % ainda tem EXECUTE no classificador', v_quem;
    end if;
  end loop;

  -- 6.3 o detalhe TEM de continuar aberto para authenticated, senao o painel
  -- morre para a gestao; e a RPC de escrita tambem, senao o botao nao funciona.
  -- Em nenhuma das duas anon ou PUBLIC entram.
  for v_quem in select unnest(array['carteira_2026_2_competencia_detalhe',
                                    'carteira_conferir_em_aberto'])
  loop
    select proacl into v_acl from pg_proc
     where pronamespace = 'public'::regnamespace and proname = v_quem limit 1;
    if v_acl is null then
      raise exception 'ABORTADO: proacl nulo em % -- PUBLIC teria EXECUTE', v_quem;
    end if;
    if not exists (select 1 from aclexplode(v_acl) a
                    where a.privilege_type='EXECUTE' and a.grantee::regrole::text='authenticated') then
      raise exception 'ABORTADO: authenticated sem EXECUTE em %', v_quem;
    end if;
    if exists (select 1 from aclexplode(v_acl) a
                where a.privilege_type='EXECUTE'
                  and coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') in ('PUBLIC','anon')) then
      raise exception 'ABORTADO: PUBLIC ou anon com EXECUTE em %', v_quem;
    end if;
  end loop;

  -- 6.4 a tabela nao pode ser legivel direto: o CPF e o historico saem pelas
  -- funcoes, com o portao da gestao.
  if exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='titulo_conferido_em_aberto'
                and grantee in ('PUBLIC','anon','authenticated')) then
    raise exception 'ABORTADO: titulo_conferido_em_aberto exposta a anon/authenticated';
  end if;
end
$guarda$;

commit;

-- ============================================================================
-- VALIDACAO.
--
-- 1. POSTGRES ISOLADO, no CI (servico do GitHub Actions, container descartavel,
--    sem segredo, sem producao, sem servico pago). O job
--    "proposta conferido em aberto (postgres isolado)" monta o ambiente,
--    recria o classificador de producao, aplica ESTE arquivo inteiro e roda
--    supabase/tests/conferido_em_aberto/03_casos.sql. Todos os casos passaram:
--      0. 8 titulos, um por ramo, saldo 36.000,00
--      1. gestao registra: grava autor, data, justificativa e evidencia,
--         auditoria na ficha, SO o titulo esperado muda, saldo identico
--      2. sem permissao: 42501 e nenhum rastro gravado
--      3. recusa pagamento, acordo, decisao REJEITADO, valor desatualizado,
--         liquidacao desatualizada, justificativa curta e evidencia vazia
--      4. liquidacao nova, acordo, pagamento e valor novo derrubam a
--         confirmacao; o registro sobrevive como historico
--      5. classificador fechado, RPC so para authenticated, tabela fechada
--    A primeira execucao ABORTOU em "PUBLIC ainda tem EXECUTE no classificador"
--    -- a guarda funcionou e o fixture e que estava mais folgado que producao.
--    Dai vieram os revokes explicitos de PUBLIC acima.
--
-- 2. SOMENTE LEITURA contra producao, nada criado nem escrito: a logica antes e
--    a depois rodaram INLINE, no mesmo instante e sobre o mesmo snapshot --
--    2.525 linhas dos dois lados, ZERO diferenca com a tabela vazia; com tres
--    conferencias simuladas, exatamente tres titulos saem de EM_CONFERENCIA
--    para SEM_NEGOCIACAO; com a assinatura quebrada, nenhum sai. Saldo total
--    identico nos tres cenarios.
--
-- O QUE NAO FOI EXERCITADO: o volume de producao. O teste isolado usa 8 titulos,
-- nao 2.525 -- ele prova comportamento, nao desempenho.
-- ============================================================================
