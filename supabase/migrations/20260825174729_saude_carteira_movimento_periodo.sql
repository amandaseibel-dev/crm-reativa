-- Movimento do período: separar LIQUIDOU de ENTROU de RECLASSIFICOU.
--
-- O problema que originou isto, medido em prod 2026-08-25 na janela 13/08--25/08:
--
--   ENTROU   acordos importados     R$   949.780,34  (138)
--   ENTROU   titulos importados     R$   382.112,03  (383)
--   SAIU     pagamentos baixados    R$ 1.002.914,63  (465)
--   SAIU     titulos que viraram PAGO R$ 149.340,97  (258)
--   MOVEU    titulos vinculados     R$ 2.173.960,15  (1.077)
--
-- A carteira SUBIU R$ 167.680,21 no periodo -- e a conta fecha: entrou
-- R$ 1.331.892,37 contra R$ 1.152.255,60 que saiu. Doze dias de trabalho real
-- desaparecem no numero absoluto porque a remessa repoe mais rapido do que a
-- operacao baixa. Foram 11 remessas desde 20/07.
--
-- Pior: o MAIOR volume de trabalho do periodo (R$ 2,17 mi de vinculacao) NAO
-- reduz a carteira por definicao -- a mensalidade sai do aberto e a parcela do
-- acordo entra no lugar. E saneamento (tira o caso da fila, destrava o
-- operador, mata a dupla contagem), mas nunca vai aparecer como resultado.
--
-- Sem separar as tres coisas, um mes de trabalho bom parece um mes parado.
--
-- AS TRES LINHAS:
--   liquidou      -- divida que deixou de existir. E o resultado.
--   entrou        -- divida nova por remessa. Nao depende do operador.
--   reclassificou -- mensalidade que virou acordo. Saneamento, nao resultado.
--
-- DATAS -- as duas pernas nao tem a mesma qualidade de fonte, e isso e dito na
-- resposta em `qualidade_da_data`:
--   acordo      -> `parcelas.pago_em`, data real de pagamento. Confiavel desde
--                  20260826030000, que criou o gatilho e preencheu as 144 que
--                  estavam sem data (R$ 723.433,49).
--   mensalidade -> `acordos_titulos.atualizado_em`. A tabela NAO TEM campo de
--                  data de pagamento -- nenhum. E quando o registro foi mexido,
--                  nao quando o dinheiro entrou. Aproximacao, e esta rotulada.
--
-- ESCOPO: recebe os alunos ja filtrados pelo chamador, como
-- `saude_carteira_saldo_por_origem`. Operador continua vendo so a carteira dele.
--
-- Rollback: supabase/rollbacks/20260826060000_saude_carteira_movimento_periodo.sql

create or replace function public.saude_carteira_movimento(
  p_alunos uuid[], p_de date, p_ate date
)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with
  -- LIQUIDOU: acordo. Fonte boa -- data real de pagamento.
  liq_acordo as (
    select count(*) qtd, coalesce(sum(p.valor),0) valor
    from public.parcelas p
    join public.acordos ac on ac.id = p.acordo_id
    where p.status = 'PAGO'
      and p.pago_em is not null
      and (p.pago_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and ac.aluno_id = any(p_alunos)
  ),
  -- LIQUIDOU: mensalidade. Fonte aproximada -- nao existe data de pagamento.
  liq_mensal as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    where t.situacao = 'PAGO'
      and (t.atualizado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  ),
  -- ENTROU: titulos novos.
  ent_titulo as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    where (t.created_at at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  ),
  -- ENTROU: acordos importados novos.
  ent_acordo as (
    select count(*) qtd, coalesce(sum(ac.valor_total),0) valor
    from public.acordos ac
    where (ac.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and ac.criado_por_email = 'importacao@sistema'
      and ac.aluno_id = any(p_alunos)
  ),
  -- RECLASSIFICOU: mensalidade que virou acordo. Nao reduz nada.
  recl as (
    select count(*) qtd, coalesce(sum(coalesce(t.saldo_corrigido,t.valor_original,0)),0) valor
    from public.acordos_titulos t
    join public.acordo_titulo_vinculo v on v.titulo_id = t.id
    where t.situacao = 'NEGOCIADO'
      and coalesce(v.ativo, true)
      and (v.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
      and t.aluno_id = any(p_alunos)
  )
  select jsonb_build_object(
    'de', p_de, 'ate', p_ate,
    'liquidou', jsonb_build_object(
      'acordo_valor',      (select valor from liq_acordo),
      'acordo_qtd',        (select qtd   from liq_acordo),
      'mensalidade_valor', (select valor from liq_mensal),
      'mensalidade_qtd',   (select qtd   from liq_mensal),
      'total',             (select valor from liq_acordo) + (select valor from liq_mensal)
    ),
    'entrou', jsonb_build_object(
      'titulo_valor', (select valor from ent_titulo),
      'titulo_qtd',   (select qtd   from ent_titulo),
      'acordo_valor', (select valor from ent_acordo),
      'acordo_qtd',   (select qtd   from ent_acordo),
      'total',        (select valor from ent_titulo) + (select valor from ent_acordo)
    ),
    'reclassificou', jsonb_build_object(
      'valor', (select valor from recl),
      'qtd',   (select qtd   from recl)
    ),
    'resultado_liquido',
      ((select valor from liq_acordo) + (select valor from liq_mensal))
      - ((select valor from ent_titulo) + (select valor from ent_acordo)),
    'qualidade_da_data', jsonb_build_object(
      'acordo',      'data real de pagamento (parcelas.pago_em)',
      'mensalidade', 'aproximada: a tabela nao tem data de pagamento, usa a ultima alteracao do registro'
    ),
    'calculado_em', now()
  );
$$;

comment on function public.saude_carteira_movimento(uuid[], date, date) is
  'Movimento da carteira no periodo em tres linhas: liquidou (resultado), entrou (remessa) e reclassificou (mensalidade que virou acordo, nao reduz). Recebe alunos ja filtrados pelo escopo do chamador.';

revoke all on function public.saude_carteira_movimento(uuid[], date, date) from public, anon;
grant execute on function public.saude_carteira_movimento(uuid[], date, date) to authenticated;

-- RPC publica: aplica o escopo e chama a funcao acima.
create or replace function public.saude_carteira_movimento_periodo(
  p_de date, p_ate date, p_filtros jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_alunos uuid[];
begin
  if p_de is null or p_ate is null then
    raise exception 'Informe o periodo (de e ate).' using errcode='22023';
  end if;
  if p_ate < p_de then
    raise exception 'A data final nao pode ser anterior a inicial.' using errcode='22023';
  end if;
  if p_ate - p_de > 400 then
    raise exception 'Periodo maximo de 400 dias.' using errcode='22023';
  end if;

  select array_agg(distinct v.aluno_id) into v_alunos
    from public.mv_saude_carteira v
   where v.aluno_id is not null
     and (v_estab is null or v.estabelecimento = v_estab)
     and (v_operador is null or v.operador_email is not distinct from v_operador);

  return public.saude_carteira_movimento(coalesce(v_alunos, array[]::uuid[]), p_de, p_ate)
      || jsonb_build_object('escopo', jsonb_build_object(
           'is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'));
end; $function$;

comment on function public.saude_carteira_movimento_periodo(date, date, jsonb) is
  'RPC da tela: movimento da carteira no periodo, com escopo de operador aplicado.';

revoke all on function public.saude_carteira_movimento_periodo(date, date, jsonb) from public, anon;
grant execute on function public.saude_carteira_movimento_periodo(date, date, jsonb) to authenticated;
