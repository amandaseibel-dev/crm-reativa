-- =============================================================================
-- TV ReATIVA — "Acordos de Hoje" no snapshot
-- -----------------------------------------------------------------------------
-- Acrescenta ao payload a chave `acordos_hoje`: quantos acordos foram fechados
-- hoje, quantos já converteram em pagamento, o valor pago e o ranking por
-- operador. Nenhum cálculo financeiro existente é tocado.
--
-- AS DUAS DEFINIÇÕES, decididas pela gestão em 08/10/2026 e medidas em produção
-- antes de escrever uma linha:
--
-- 1) ACORDO FECHADO HOJE = `acordos.criado_em` convertido para o fuso de São
--    Paulo, igual à data de hoje, com `duplicado_de is null` e status diferente
--    de CANCELADO.
--
--    NÃO é `confirmado_em`: esse campo está preenchido em 553 de 4.489 acordos
--    (12%) e em ZERO dos de hoje — é inutilizável como marco. `criado_em` está
--    em 100%. `duplicado_de` é a trava oficial contra contar a mesma negociação
--    duas vezes (26 marcados na base).
--
--    O dono é `acordos.operador_responsavel_email`, a mesma fonte de verdade
--    que carteira_acordos_por_operador já declara: "Nao usar o responsavel da
--    ficha."
--
-- 2) CONVERTIDO EM PAGAMENTO = existe linha em `public.pagamentos` cujo
--    `numero_parcela_completo` casa com o `boleto` de uma parcela do acordo, E
--    cuja `data_pagamento` é IGUAL OU POSTERIOR ao dia do acordo.
--
--    O recorte de data não é detalhe — é o que separa desempenho de artefato.
--    Medido em 45 dias: 928 acordos, 526 com algum pagamento, mas 171 deles
--    (32%) têm SÓ pagamento anterior ao acordo. São acordos registrados no CRM
--    depois que o aluno já havia pago. Contar "qualquer pagamento" mostraria
--    100% de conversão numa manhã em que ninguém converteu nada.
--
--    NÃO é `parcelas.status = 'PAGA'`: em 45 dias, 705 acordos têm parcela
--    nesse status e 174 deles não têm pagamento nenhum na tabela financeira.
--    É promessa, não dinheiro. NÃO é `baixas_pagamento` pelo mesmo motivo.
--
-- QUEM NÃO APARECE: o ranking exclui `tv_equipe_oculta`. Os TOTAIS somam todo
-- mundo — são números sem nome, e tirar alguém de lá faria o telão subnotificar
-- a operação. É a mesma divisão que a TV já faz: `v_ops` filtra a vitrine,
-- recuperado e honorários somam a base inteira.
--
-- CUSTO: medido com EXPLAIN ANALYZE em produção antes de aplicar — 26 ms, com
-- index scan em parcelas_acordo_id_idx e idx_pagamentos_numero_parcela_completo.
-- O snapshot inteiro leva ~2,8 s e tem timeout de 30 s.
--
-- PATCH ANCORADO, não CREATE OR REPLACE: tv_snapshot_atualizar já carrega o
-- filtro de tv_equipe_oculta (20261007093518) e a chave magic (20261007111401).
-- Reescrever a função apagaria os dois. A âncora é a linha do v_ms, exigida
-- em ocorrência única; sem ela o bloco ABORTA sem alterar nada.
--
-- DESFAZER: supabase/rollbacks/20261008120000_tv_acordos_de_hoje.rollback.sql
-- =============================================================================

do $patch$
declare
  v_src text; v_n int;
  v_ancora text := $a$    v_ms := round(extract(milliseconds from clock_timestamp() - v_t0));$a$;
  v_bloco  text := $a$    -- ACORDOS DE HOJE. Fechado = criado_em no fuso de São Paulo, sem duplicado
    -- e sem cancelado. Convertido = pagamento real com data >= o dia do acordo.
    v_payload := v_payload || jsonb_build_object('acordos_hoje', (
      with hoje as (select (now() at time zone 'America/Sao_Paulo')::date d),
      ac as (
        select a.id,
               lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono
          from public.acordos a, hoje
         where (a.criado_em at time zone 'America/Sao_Paulo')::date = hoje.d
           and a.duplicado_de is null
           and upper(coalesce(a.status, '')) <> 'CANCELADO'
      ),
      pg as (
        select distinct p.acordo_id, pgm.id as pag_id, pgm.valor_pago
          from public.parcelas p
          join ac on ac.id = p.acordo_id
          join public.pagamentos pgm on pgm.numero_parcela_completo = p.boleto
          cross join hoje
         where p.boleto is not null
           and pgm.data_pagamento >= hoje.d
      ),
      por_op as (
        select coalesce(u.nome, ac.dono, 'Sem responsável') as operador,
               count(distinct ac.id) as fechados,
               count(distinct pg.acordo_id) as convertidos,
               coalesce(sum(pg.valor_pago), 0) as valor_pago
          from ac
          left join public.usuarios u on lower(u.email) = ac.dono
          left join pg on pg.acordo_id = ac.id
         where ac.dono is null
            or ac.dono not in (select email from public.tv_equipe_oculta)
         group by coalesce(u.nome, ac.dono, 'Sem responsável')
      )
      select jsonb_build_object(
        'data', (select to_char(d, 'YYYY-MM-DD') from hoje),
        'fechados', (select count(*) from ac),
        'convertidos', (select count(distinct acordo_id) from pg),
        'valor_pago', (select coalesce(round(sum(valor_pago))::bigint, 0) from pg),
        'taxa_pct', (select case when (select count(*) from ac) > 0
                       then round((select count(distinct acordo_id) from pg)::numeric
                                  / (select count(*) from ac) * 100, 1) end),
        'ranking', coalesce((select jsonb_agg(jsonb_build_object(
              'operador', operador, 'fechados', fechados, 'convertidos', convertidos,
              'valor_pago', round(valor_pago)::bigint)
            order by fechados desc, valor_pago desc, operador)
          from (select * from por_op order by fechados desc, valor_pago desc limit 8) r), '[]'::jsonb))
    ));

$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;

  if position('acordos_hoje' in v_src) > 0 then
    raise notice 'chave acordos_hoje ja mesclada; nada a fazer.';
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception 'ancora do v_ms encontrada % vez(es) em tv_snapshot_atualizar (esperado 1). Nada foi alterado.', v_n;
  end if;

  -- Rede: o que já estava lá tem de continuar lá depois da troca.
  if position('tv_equipe_oculta' in v_src) = 0 or position('magic_number_mensal' in v_src) = 0 then
    raise exception 'tv_snapshot_atualizar nao tem o filtro de equipe oculta ou a chave magic -- estado inesperado. Nada foi alterado.';
  end if;

  execute replace(v_src, v_ancora, v_bloco || v_ancora);
end
$patch$;
