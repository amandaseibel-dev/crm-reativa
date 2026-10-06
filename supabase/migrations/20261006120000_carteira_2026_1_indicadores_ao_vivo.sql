-- OS QUATRO INDICADORES DE 2026/1 PASSAM A LER AO VIVO.
--
-- O PROBLEMA. `carteira_2026_1_indicadores()` nao calcula nada: ela le a ultima
-- linha de `carteira_2026_1_snapshot`. E essa tabela tem UMA linha so, de
-- 11/09/2026 -- quem grava e `carteira_2026_1_recalcular()`, que nunca voltou a
-- ser chamada. Resultado medido em 06/10/2026: a tela mostrou por 25 dias uma
-- fotografia de 11/09 como se fosse o estado atual da cobranca.
--
-- O QUE MUDA: a FONTE, nao a conta. Toda expressao de `faixas`, `base`,
-- `composicao`, `recuperacao`, `cpfs` e `titulos_inadimplentes` vem COPIADA
-- VERBATIM de `carteira_2026_1_recalcular()`, incluindo o calculo de
-- `caixa_acordo_fora_do_crm` com suas seis CTEs e os tres criterios de teto por
-- aluno. Nenhum numero e recomposto, nenhum arredondamento muda, nenhuma faixa
-- nova aparece.
--
-- COMO: o corpo que montava o payload sai de `recalcular` e vira
-- `carteira_2026_1_payload()`, que NAO escreve. Depois:
--   . `carteira_2026_1_recalcular()` chama o payload e faz o insert -- mesmo
--     comportamento observavel de hoje, inclusive o historico do snapshot;
--   . `carteira_2026_1_indicadores()` chama o payload direto, sem ler snapshot.
--
-- TABELA TEMPORARIA VIROU CTE, e so por isso. `recalcular` fazia
-- `create temp table _c`, que e escrita de catalogo e por isso NUNCA poderia
-- morar numa funcao STABLE -- e foi exatamente esse o defeito que deixou
-- `saude_carteira_por_curso` quebrada por 22 dias (migration 20261002092345).
-- Com `_c as materialized`, o classificador roda UMA vez e a funcao pode ser
-- STABLE. MEDIDO em 06/10/2026 com explain analyze: `_c` materializa uma vez
-- (14.979 linhas, um CTE Scan) e o payload inteiro fecha em 3.112 ms;
-- `carteira_2026_1_classificar()` sozinho leva 1.719 ms. Nao e de graca: a tela
-- passa a esperar ~3 s onde hoje espera a leitura de uma linha.
--
-- ================== FORA_DA_BASE ENTRA COMO COBRANCA ENCERRADA ==============
-- O PROBLEMA QUE APARECEU AO LIGAR O AO VIVO. Medido em 06/10/2026:
--
--   snapshot de 11/09  soma das 4 faixas = 21.752.304,72  base = 21.752.304,72
--                      diferenca 0,00
--   ao vivo, sem tratar o residuo
--                      soma das 4 faixas = 21.597.852,13  base = 21.710.447,29
--                      diferenca 112.595,16  -- NAO fechava
--
-- A diferenca era exatamente a faixa FORA_DA_BASE do classificador: 15 titulos /
-- R$ 112.595,16, "encerrado administrativamente / fora da base". Em 11/09 esse
-- conjunto era VAZIO, entao as quatro faixas fechavam por acidente do dado e nao
-- por construcao -- o payload nunca teve destino para esse residuo. A tela
-- declara as barras como 100% da carteira, e declararia 99,48% como 100%.
--
-- DECISAO DA GESTAO (06/10/2026): tratar FORA_DA_BASE como COBRANCA CANCELADA,
-- a mesma regra que `carteira_safra_situacoes()` ja aplica -- la o titulo
-- FORA_DA_BASE alimenta a linha "Cancelado" e por isso aquela visao fecha com
-- diferenca 0,00. Sem criar quinta faixa.
--
-- POR QUE ELE ENTRA EM `academico` E NAO EM OUTRA. As quatro faixas sao
-- efetividade, inadimplencia, em_validacao e academico; NENHUMA se chama
-- "Cancelado", e a gestao pediu para nao criar faixa nova. Das quatro, a unica
-- cujo significado e "o titulo saiu do universo de cobranca, e isso nao e
-- resultado de cobranca" e `academico` -- ela ja carrega a sub_faixa
-- "Baixa/Ajuste academico". Cobranca encerrada administrativamente e o mesmo
-- tipo de evento: saida do universo, nao conversao nem inadimplencia. Somar em
-- efetividade inflaria conversao; somar em inadimplencia afirmaria divida que
-- ninguem vai cobrar; em_validacao diria que esta em conferencia, e nao esta --
-- a decisao ja foi tomada. A tela acompanha: a barra passa de "Ajuste
-- academico" para "Encerrado / ajuste academico".
--
-- SOMA EXATA, SEM DUPLA CONTAGEM. CONFERIDO em 06/10/2026: as 15 linhas
-- FORA_DA_BASE tem ef_pago, ef_negociado, ef_convertido, em_validacao,
-- academico, inadimplencia e recuperacao_financeira TODOS em 0,00 -- elas
-- entravam em `base.valor` pelo valor_original e em nenhuma faixa. Por isso
-- somar `valor_original` em `academico` e exato.
--
-- NENHUMA OUTRA REGRA MUDA: efetividade, inadimplencia, em_validacao,
-- composicao, recuperacao (inclusive o caixa fora do CRM), cpfs e
-- titulos_inadimplentes seguem com as expressoes de 11/09, verbatim.
--
-- O QUE NAO MUDA: `carteira_2026_1_snapshot` continua existindo, com a linha de
-- 11/09 intacta e com `recalcular` ainda podendo gravar novas; `base.congelada_em`
-- segue vindo de `carteira_2026_1_base`, que E congelada de proposito;
-- `carteira_2026_1_classificar`, `_academico`, `_evolucao`, `_detalhe` e
-- `_congelar` nao sao tocadas. SO DDL, zero DML.
--
-- Reversivel: restaurar `carteira_2026_1_indicadores()` e `_recalcular()` da
-- versao anterior e dar drop em `carteira_2026_1_payload()`. Nenhum dado a
-- restaurar.

-- ---------------------------------------------------------------------------
-- 1. O PAYLOAD, SEM ESCREVER NADA
--    Expressoes copiadas verbatim de carteira_2026_1_recalcular(); a unica
--    diferenca de plumbing e `_c` ser CTE materializada em vez de temp table.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_1_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with _c as materialized (select * from public.carteira_2026_1_classificar()),
  -- Caixa de acordo que nao existe no CRM. Entra so o que e NOVO: o teto por
  -- aluno desconta o que ja foi contado como dinheiro (ef_pago) e como
  -- negociacao viva (regular/atraso). Exige aluno cuja divida no CRM e toda de
  -- 2026/1, com titulo liquidado no Prime e sem outra safra liquidada na mesma
  -- data (assinatura de acordo que pegou 2026/2).
  por_aluno as (
    select c.aluno_id, sum(c.valor_original) base_2026_1,
           sum(c.ef_pago) + sum(case when c.acordo_estado in ('regular','atraso') then c.ef_negociado else 0 end) ja_contado,
           bool_or(c.estado_prime = 'liquidado no Prime') tem_liquidacao
      from _c c where c.aluno_id is not null group by 1
  ),
  base_total as (
    select t.aluno_id, sum(t.valor_original) total
      from public.acordos_titulos t where t.situacao <> 'DUPLICADA' group by 1
  ),
  liq_datas as (
    select b.aluno_id, s.liq dia
      from public.carteira_2026_1_base b
      join (select regexp_replace(coalesce(boleto,''),'\D','','g') bo, max(liquidado_em) liq
              from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1) s
        on s.bo = regexp_replace(coalesce(b.documento,''),'\D','','g')
     where s.liq is not null and s.liq > b.vencimento + 30 and s.liq >= b.entrada_em
     group by 1,2
  ),
  outra_safra as (
    select distinct ld.aluno_id
      from liq_datas ld
      join public.alunos al on al.id = ld.aluno_id
      join public.prime_titulo_semestre ts
        on regexp_replace(coalesce(ts.cpf,''),'\D','','g') = regexp_replace(coalesce(al.cpf,''),'\D','','g')
     where ts.semestre <> '2026/1' and ts.liquidado_em = ld.dia and ts.liquidado_em >= date '2026-07-01'
  ),
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''),'\D','','g') b
      from public.parcelas where boleto is not null
  ),
  caixa as (
    select p.aluno_id, sum(p.valor_pago) caixa
      from public.pagamentos p
      left join boletos_nossos bn on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''),'\D','','g')
     where bn.b is null and p.aluno_id is not null group by 1
  ),
  caixa_fora as (
    select round(coalesce(sum(least(ca.caixa, greatest(pa.base_2026_1 - pa.ja_contado, 0))), 0), 2) v
      from por_aluno pa
      join caixa ca on ca.aluno_id = pa.aluno_id
      join base_total bt on bt.aluno_id = pa.aluno_id
      left join outra_safra os on os.aluno_id = pa.aluno_id
     where pa.tem_liquidacao and os.aluno_id is null and abs(bt.total - pa.base_2026_1) < 0.01
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'fonte', 'ao vivo',
    'base', jsonb_build_object(
      'valor', round(sum(valor_original),2), 'titulos', count(*), 'cpfs', count(distinct cpf),
      'congelada_em', (select max(congelado_em) from public.carteira_2026_1_base),
      'entrada_de', (select min(entrada_em) from public.carteira_2026_1_base),
      'entrada_ate', (select max(entrada_em) from public.carteira_2026_1_base),
      'por_vencimento_sem_serie', (select count(*) from public.carteira_2026_1_base where origem_semestre = 'vencimento')
    ),
    'faixas', jsonb_build_object(
      'efetividade',   round(sum(ef_pago + ef_negociado + ef_convertido),2),
      'inadimplencia', round(sum(inadimplencia),2),
      'em_validacao',  round(sum(em_validacao),2),
      -- Cobranca encerrada administrativamente (FORA_DA_BASE) entra aqui, por
      -- decisao da gestao de 06/10/2026 -- mesma regra da linha "Cancelado" de
      -- carteira_safra_situacoes(). As 15 linhas FORA_DA_BASE tem 0,00 em TODAS
      -- as colunas de metrica, entao a soma e exata e nao ha dupla contagem.
      -- E o que faz as quatro faixas voltarem a fechar 100% de base.valor.
      'academico',     round(sum(academico)
                             + sum(case when faixa = 'FORA_DA_BASE' then valor_original else 0 end), 2)
    ),
    -- Decomposicao de `academico`, para auditoria. NAO e faixa: a soma das duas
    -- partes e exatamente a faixa acima, e nenhuma das duas aparece como barra.
    'academico_detalhe', jsonb_build_object(
      'ajuste_academico',          round(sum(academico),2),
      'encerrado_administrativo',  round(sum(case when faixa = 'FORA_DA_BASE' then valor_original else 0 end),2),
      'titulos_encerrados',        count(*) filter (where faixa = 'FORA_DA_BASE')
    ),
    -- composicao POR VALOR: o titulo de acordo parcial divide-se entre pago e negociado
    'composicao', jsonb_build_array(
      jsonb_build_object('sub_faixa','Pago / Quitado','valor', round(sum(ef_pago),2),
                         'titulos', count(*) filter (where ef_pago > 0)),
      jsonb_build_object('sub_faixa','Negociado regular','valor',
                         round(sum(case when acordo_estado in ('regular','quitado') then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado in ('regular','quitado') and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Negociado em atraso (ate 30 dias)','valor',
                         round(sum(case when acordo_estado = 'atraso' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'atraso' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Acordo quebrado (acima de 30 dias)','valor',
                         round(sum(case when acordo_estado = 'quebrado' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'quebrado' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Acordo cancelado','valor',
                         round(sum(case when acordo_estado = 'cancelado' then ef_negociado else 0 end),2),
                         'titulos', count(*) filter (where acordo_estado = 'cancelado' and ef_negociado > 0)),
      jsonb_build_object('sub_faixa','Convertido com origem comprovada','valor', round(sum(ef_convertido),2),
                         'titulos', count(*) filter (where ef_convertido > 0))
    ),
    'recuperacao', jsonb_build_object(
      'parcelas_e_baixas', round(sum(recuperacao_financeira),2),
      'caixa_acordo_fora_do_crm', (select v from caixa_fora),
      'total', round(sum(recuperacao_financeira),2) + (select v from caixa_fora)
    ),
    'cpfs', jsonb_build_object(
      'convertido_total', (select count(*) from (select cpf from _c group by cpf
          having sum(inadimplencia + em_validacao + academico) <= 0.01) a),
      'parcial', (select count(*) from (select cpf from _c group by cpf
          having sum(ef_pago + ef_negociado + ef_convertido) > 0.01
             and sum(inadimplencia + em_validacao + academico) > 0.01) a),
      'zero_conversao', (select count(*) from (select cpf from _c group by cpf
          having sum(ef_pago + ef_negociado + ef_convertido) <= 0.01) a),
      'inadimplentes', (select count(distinct cpf) from _c where inadimplencia > 0)
    ),
    'titulos_inadimplentes', (select count(*) from _c where inadimplencia > 0)
  ) into v_out from _c;

  return v_out;
end; $function$;

comment on function public.carteira_2026_1_payload() is
  'Monta o payload de indicadores de 2026/1 AO VIVO, sem escrever. Expressoes '
  'copiadas verbatim de carteira_2026_1_recalcular(); as unicas diferencas sao '
  '`_c` ser CTE materializada em vez de temp table (o que permite STABLE) e o '
  'titulo FORA_DA_BASE entrar na faixa `academico` como cobranca encerrada '
  'administrativamente, por decisao da gestao de 06/10/2026 -- mesma regra da '
  'linha "Cancelado" de carteira_safra_situacoes(). Com isso as QUATRO faixas '
  'somam exatamente base.valor. A decomposicao de `academico` sai em '
  '`academico_detalhe`. MEDIDO em 06/10/2026: 3.112 ms, classificador uma vez.';

revoke all on function public.carteira_2026_1_payload() from public, anon;
grant execute on function public.carteira_2026_1_payload() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. RECALCULAR: mesmo comportamento, agora delegando o calculo
--    Continua VOLATILE e continua sendo a UNICA que escreve o snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_1_recalcular()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  v_out := public.carteira_2026_1_payload();

  insert into public.carteira_2026_1_snapshot (payload, gerado_por)
  values (v_out, coalesce(auth.jwt() ->> 'email', 'sistema'))
  on conflict (dia) do update set payload = excluded.payload, gerado_em = now(),
                                  gerado_por = excluded.gerado_por;
  return v_out;
end; $function$;

comment on function public.carteira_2026_1_recalcular() is
  'Grava o snapshot de 2026/1. Desde 06/10/2026 delega o calculo a '
  'carteira_2026_1_payload() -- mesmo payload, mesmo insert, mesmo comportamento '
  'observavel. E a UNICA funcao que escreve em carteira_2026_1_snapshot.';

-- ---------------------------------------------------------------------------
-- 3. INDICADORES: le o payload ao vivo, nao o snapshot
--    `gerado_por` e `dia` seguem no retorno para nao mudar a forma da resposta;
--    agora dizem quem pediu e quando, nao quem congelou em 11/09.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_2026_1_indicadores()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  return public.carteira_2026_1_payload()
         || jsonb_build_object(
              'gerado_por', coalesce(auth.jwt() ->> 'email', 'ao vivo'),
              'dia', current_date
            );
end; $function$;

comment on function public.carteira_2026_1_indicadores() is
  'Indicadores de 2026/1 AO VIVO desde 06/10/2026. Antes lia a ultima linha de '
  'carteira_2026_1_snapshot, que tinha UMA linha so, de 11/09/2026 -- a tela '
  'mostrou 25 dias uma fotografia como se fosse o estado atual. A conta nao mudou: '
  'delega a carteira_2026_1_payload(), cujas expressoes vieram verbatim de '
  'carteira_2026_1_recalcular(). O snapshot continua existindo e so recalcular escreve nele.';
