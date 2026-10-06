-- SEIS LINHAS IGUAIS PARA TODA SAFRA -- 2024, 2025 e 2026/1 no layout que
-- `carteira_2026_2_por_vencimento()` ja usa em 2026/2.
--
-- Pedido da gestao em 05/10/2026: a Diretoria quer encontrar as MESMAS seis
-- linhas em qualquer safra -- Entrou, Pago, Negociado, Cancelado, Em aberto e
-- Pendente -- em vez de um recorte conceitual diferente por periodo (quatro
-- faixas em 2026/1, saldo residual em 2024/2025).
--
-- INVARIANTE, igual a de 2026/2:
--   Entrou = Pago + Negociado + Cancelado + Em aberto + Pendente
-- O bloco `conferencia` remede isso a cada chamada. MEDIDO em 05/10/2026, antes
-- de escrever esta funcao: diferenca 0,00 nos tres periodos.
--
-- ====================== 2026/1: DE ONDE VEM CADA LINHA ======================
-- A fonte e `carteira_2026_1_classificar()` AO VIVO, por decisao da gestao em
-- 05/10/2026. NAO e `carteira_2026_1_indicadores()`, que le
-- `carteira_2026_1_snapshot` -- e essa tabela tem UMA linha so, de 11/09/2026.
-- Medido em 05/10: o snapshot diz efetividade 11.221.306,50 e inadimplencia
-- 9.529.074,26; ao vivo da 11.602.752,42 e 9.147.393,55. Sao 24 dias de
-- cobranca que a tela nao mostrava. Esta funcao NAO escreve snapshot nenhum.
--
--   Entrou     valor_original de TODOS os titulos classificados
--   Pago       ef_pago        (= recuperacao_financeira; dinheiro atribuido)
--   Negociado  ef_negociado   (saldo nao pago de acordo)
--   Cancelado  faixa FORA_DA_BASE -- "encerrado administrativamente", que e o
--              analogo de "cobranca cancelada" desta safra
--   Em aberto  inadimplencia
--   Pendente   em_validacao + academico + ef_convertido
--
-- POR QUE `ef_convertido` CAI EM PENDENTE (R$ 946.711,07 em 05/10). Essa faixa
-- e "convertido com origem comprovada": sabemos que converteu, mas NAO sabemos
-- dizer se foi pagamento ou acordo. Somar em Pago afirmaria dinheiro que nao
-- esta provado; somar em Negociado afirmaria acordo que nao esta provado.
-- Pendente e, nos termos de 2026/2, "o que ainda nao foi classificado" -- e e
-- exatamente esse o caso. A funcao devolve o valor em `pendente_detalhe` para a
-- tela nomear a parcela, em vez de esconde-la dentro do total.
--
-- ===================== 2024/2025: DE ONDE VEM CADA LINHA ====================
-- Universo identico ao de `carteira_saldo_historico_por_ano()`: mensalidade de
-- graduacao ou pos, fora DUPLICADA e fora tipo_boleto 'Acordo', com a serie da
-- Prime (`prime_titulo_semestre.semestre`) dando o ano. CONFERIDO em 05/10: o
-- universo soma 8.469 titulos / R$ 5.159.080,84 em 2024 e 20.852 /
-- R$ 15.197.210,88 em 2025 -- iguais, ao centavo, ao bloco `carteira` daquela
-- funcao. Aqui NAO entra filtro de portador: conversao e historia, e acordo
-- quebrado devolve o titulo ao portador.
--
--   Entrou     valor_original de todos
--   Pago       com acordo: valor_original x proporcao de parcelas pagas do
--              acordo (mesma formula de `carteira_saldo_historico_por_ano`);
--              sem acordo: pagamento casado pelo numero do titulo, ou
--              liquidacao oficial da Prime
--   Negociado  saldo nao pago de acordo ATIVO
--   Cancelado  situacao CANCELADA
--   Em aberto  saldo sem acordo ativo
--   Pendente   EM_CONFIRMACAO + "PAGO sem lastro" (abaixo)
--
-- POR QUE EXISTE "PAGO SEM LASTRO" E POR QUE ELE NAO ENTRA EM PAGO.
-- MEDIDO em 05/10/2026: 41 titulos de 2024 (R$ 25.285,00 originais) e 289 de
-- 2025 (R$ 221.026,71) estao com situacao PAGO e, ao mesmo tempo, SEM acordo,
-- SEM nenhuma linha em `pagamentos` casada pelo numero do titulo e SEM
-- `origem_liquidacao`. O unico vestigio de pagamento neles e o campo de saldo
-- estar abaixo do valor original -- e `saldo_corrigido` nao e saldo atualizado
-- (ver supabase/ledger e as medicoes de 17/09: ele e IGUAL ao valor original em
-- 100% das mensalidades abertas).
--
-- `carteira_saldo_historico_por_ano()` credita esses titulos em `recebido` por
-- `valor_original - saldo`. Decomposto em 05/10, o `recebido` publicado de 2024
-- (R$ 51.380,56) e exatamente R$ 31.369,29 de rateio de acordo MAIS
-- R$ 20.011,27 desse bloco sem lastro -- ou seja, 39% do "recebido" de 2024 e
-- 50% do de 2025 nao tem prova de pagamento nenhuma. Chamar isso de Pago seria
-- afirmar dinheiro que ninguem viu entrar. Vai para Pendente, com o valor
-- aberto em `pendente_detalhe`, e a tela diz o que e.
--
-- O QUE ESTA FUNCAO NAO FAZ: nao escreve, nao corrige nenhum titulo, nao
-- reconcilia o PAGO sem lastro (isso e frente propria, com backup e reversao
-- por id, no espirito de `mensalidade_reconciliar_pago_sem_lastro`) e nao toca
-- `carteira_2026_1_snapshot`, `carteira_saldo_historico_por_ano` nem
-- `carteira_2026_2_*`. SO DDL: uma funcao nova.
--
-- Reversivel: drop function public.carteira_safra_situacoes(text, text).

create or replace function public.carteira_safra_situacoes(
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
  v_out   jsonb;
  v_ano   text := nullif(btrim(coalesce(p_ano, '')), '');
  v_sem   text := nullif(btrim(coalesce(p_semestre, '')), '');
begin
  -- Mesmo portao das outras telas de carteira: gestao, diretoria ou service_role.
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_ano is null then
    raise exception 'Informe o ano.' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------ 2026/1
  if v_ano = '2026' and v_sem = '1' then
    with c as (select * from public.carteira_2026_1_classificar()),
    -- Uma linha por (titulo, linha em que ele aparece). Aluno e titulo saem
    -- daqui por CONTAGEM, nunca por soma: o mesmo titulo pode ter valor em
    -- Pago e em Negociado ao mesmo tempo (acordo parcialmente pago), e o mesmo
    -- aluno aparece em quantas linhas tiver titulo.
    b as (
      select 'entrou'    as bucket, aluno_id, titulo_id, valor_original as valor from c
      union all
      select 'pago',      aluno_id, titulo_id, ef_pago      from c where ef_pago > 0
      union all
      select 'negociado', aluno_id, titulo_id, ef_negociado from c where ef_negociado > 0
      union all
      select 'cancelado', aluno_id, titulo_id, valor_original from c where faixa = 'FORA_DA_BASE'
      union all
      select 'em_aberto', aluno_id, titulo_id, inadimplencia from c where inadimplencia > 0
      union all
      select 'pendente',  aluno_id, titulo_id, em_validacao + academico + ef_convertido from c
        where em_validacao + academico + ef_convertido > 0
    ),
    agg as (
      select bucket,
             count(distinct aluno_id)  as alunos,
             count(distinct titulo_id) as titulos,
             round(sum(valor), 2)      as valor
        from b group by bucket
    ),
    tot as (
      select round(sum(valor_original), 2) entrou,
             round(sum(ef_pago + ef_negociado
                       + case when faixa = 'FORA_DA_BASE' then valor_original else 0 end
                       + inadimplencia
                       + em_validacao + academico + ef_convertido), 2) soma,
             round(sum(ef_convertido), 2)  convertido,
             round(sum(em_validacao), 2)   em_validacao,
             round(sum(academico), 2)      academico
        from c
    )
    select jsonb_build_object(
      'recorte',   '2026/1',
      'natureza',  'CARTEIRA_CONSOLIDADA',
      'fonte',     'carteira_2026_1_classificar() ao vivo',
      'gerado_em', now(),
      'situacoes', (select coalesce(jsonb_object_agg(bucket,
                      jsonb_build_object('alunos', alunos, 'titulos', titulos, 'valor', valor)), '{}'::jsonb)
                      from agg),
      'conferencia', (select jsonb_build_object(
                        'entrou', entrou, 'soma_das_linhas', soma,
                        'diferenca', round(entrou - soma, 2), 'fecha', round(entrou - soma, 2) = 0)
                        from tot),
      'pendente_detalhe', (select jsonb_build_object(
                        'convertido_origem_comprovada', convertido,
                        'em_validacao', em_validacao,
                        'ajuste_academico', academico,
                        'pago_sem_lastro', 0)
                        from tot)
    ) into v_out;
    return v_out;
  end if;

  -- --------------------------------------------------------------- 2024/2025
  if v_ano not in ('2024', '2025') then
    raise exception 'Safra sem regua definida: %. Use 2024, 2025 ou 2026/1.', v_ano
      using errcode = '22023';
  end if;

  with ts as (
    select regexp_replace(coalesce(boleto, ''), '\D', '', 'g') b, max(semestre) semestre
      from public.prime_titulo_semestre group by 1
  ),
  vinc as (select distinct titulo_id from public.acordo_titulo_vinculo),
  pag as (
    select regexp_replace(titulo_numero, '\D', '', 'g') b, sum(valor_pago) pago
      from public.pagamentos where coalesce(titulo_numero, '') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER', 'VENCIDA')), 0) abertas
      from public.parcelas group by 1
  ),
  ac as (
    select a.id, a.status,
           case when coalesce(p.pagas, 0) + coalesce(p.abertas, 0) > 0
                then coalesce(p.pagas, 0) / (coalesce(p.pagas, 0) + coalesce(p.abertas, 0))
                when a.status = 'QUITADO' then 1 else 0 end ratio
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  t as (
    select t.id as titulo_id, t.aluno_id, t.valor_original vo,
           upper(coalesce(t.situacao, '')) sit,
           (t.acordo_id is not null and ac.status = 'ATIVO') acordo_ativo,
           (t.acordo_id is not null) tem_acordo,
           coalesce(ac.ratio, 0) ratio,
           coalesce(pg.pago, 0) pago_direto,
           (t.origem_liquidacao is not null) liq_prime
      from public.acordos_titulos t
      left join ts on ts.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
      left join vinc v on v.titulo_id = t.id
      left join ac on ac.id = t.acordo_id
      left join pag pg on pg.b = regexp_replace(coalesce(t.documento, ''), '\D', '', 'g')
     where t.situacao <> 'DUPLICADA'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and (t.tipo_boleto ilike 'Cursos de Gradua%' or t.tipo_boleto ilike 'Cursos de P%s Gradua%')
       and left(ts.semestre, 4) = v_ano
  ),
  m as (
    select titulo_id, aluno_id, vo, acordo_ativo,
           (sit = 'CANCELADA')      as eh_cancelado,
           (sit = 'EM_CONFIRMACAO') as eh_confirm,
           (sit = 'PAGO' and not tem_acordo and not liq_prime and pago_direto = 0) as pago_sem_lastro,
           -- Teto no valor original: juros, multa e honorario NAO aumentam o
           -- recebido acima do titulo (regra da gestao de 11/09/2026).
           least(case when tem_acordo              then vo * ratio
                      when liq_prime or pago_direto > 0 then least(pago_direto, vo)
                      else 0 end, vo) as recuperado
      from t
  ),
  -- `fora` isola de uma vez as tres situacoes que nao participam do rateio
  -- pago/negociado/em aberto: cancelado, em confirmacao e pago sem lastro.
  n as (
    select *, (eh_cancelado or eh_confirm or pago_sem_lastro) as fora,
              greatest(vo - recuperado, 0) as resto
      from m
  ),
  b as (
    select 'entrou' as bucket, aluno_id, titulo_id, vo as valor from n
    union all
    select 'pago',      aluno_id, titulo_id, recuperado from n where not fora and recuperado > 0
    union all
    select 'negociado', aluno_id, titulo_id, resto      from n where not fora and acordo_ativo and resto > 0
    union all
    select 'em_aberto', aluno_id, titulo_id, resto      from n where not fora and not acordo_ativo and resto > 0
    union all
    select 'cancelado', aluno_id, titulo_id, vo         from n where eh_cancelado
    union all
    select 'pendente',  aluno_id, titulo_id, vo         from n where eh_confirm or pago_sem_lastro
  ),
  agg as (
    select bucket,
           count(distinct aluno_id)  as alunos,
           count(distinct titulo_id) as titulos,
           round(sum(valor), 2)      as valor
      from b group by bucket
  ),
  tot as (
    select round(sum(vo), 2) entrou,
           round(sum(case when fora then 0 else recuperado end)
                 + sum(case when fora then 0 when acordo_ativo then resto else 0 end)
                 + sum(case when fora then 0 when not acordo_ativo then resto else 0 end)
                 + sum(case when eh_cancelado then vo else 0 end)
                 + sum(case when eh_confirm or pago_sem_lastro then vo else 0 end), 2) soma,
           round(sum(case when pago_sem_lastro then vo else 0 end), 2) sem_lastro,
           round(sum(case when eh_confirm then vo else 0 end), 2)      confirmacao
      from n
  )
  select jsonb_build_object(
    'recorte',   v_ano,
    'natureza',  'COBERTURA_HISTORICA',
    'fonte',     'acordos_titulos + serie da Prime, ao vivo',
    'gerado_em', now(),
    'situacoes', (select coalesce(jsonb_object_agg(bucket,
                    jsonb_build_object('alunos', alunos, 'titulos', titulos, 'valor', valor)), '{}'::jsonb)
                    from agg),
    'conferencia', (select jsonb_build_object(
                      'entrou', entrou, 'soma_das_linhas', soma,
                      'diferenca', round(entrou - soma, 2), 'fecha', round(entrou - soma, 2) = 0)
                      from tot),
    'pendente_detalhe', (select jsonb_build_object(
                      'convertido_origem_comprovada', 0,
                      'em_validacao', 0,
                      'ajuste_academico', 0,
                      'pago_sem_lastro', sem_lastro,
                      'em_confirmacao', confirmacao)
                      from tot)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.carteira_safra_situacoes(text, text) is
  'Seis linhas iguais para toda safra (Entrou/Pago/Negociado/Cancelado/Em aberto/'
  'Pendente), no layout de carteira_2026_2_por_vencimento. 2026/1 vem de '
  'carteira_2026_1_classificar() AO VIVO, nao do snapshot de 11/09. 2024/2025 do '
  'mesmo universo de carteira_saldo_historico_por_ano. Invariante conferida a cada '
  'chamada em `conferencia`. PAGO sem lastro (sem acordo, sem pagamento casado e '
  'sem origem_liquidacao) vai INTEIRO para Pendente, nao para Pago -- medido em '
  '05/10/2026: 41 titulos / R$ 25.285,00 de valor original em 2024 e 289 / '
  'R$ 221.026,71 em 2025, dos quais R$ 20.011,27 e R$ 191.529,04 vinham sendo '
  'contados como recebido. SO LEITURA.';

revoke all on function public.carteira_safra_situacoes(text, text) from public, anon;
grant execute on function public.carteira_safra_situacoes(text, text) to authenticated;
