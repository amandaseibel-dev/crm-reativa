-- ============================================================
-- ITEM 3. `suspeitas_pagamento_duplicado` passa a ser a estrutura canonica.
-- ============================================================
-- Correcao de leitura minha: a chave dela NAO e `titulo_numero` -- e
-- `chave_grupo = numero_parcela_completo`, o boleto COMPLETO. `titulo_numero` e
-- so rotulo. Ou seja: ela sempre agrupou certo. O que faltava era a DATA e a
-- tolerancia de valor, que e o que separa duplicata de pagamento residual.
--
-- Medido: dos 20 grupos que so ela tinha, 19 eram residual legitimo -- e 12
-- deles JA foram julgados por humano como LEGITIMO. As decisoes humanas
-- existentes confirmam a regra boleto + data.
--
-- Nada de historico e perdido: so entram colunas novas.

alter table public.suspeitas_pagamento_duplicado
  add column if not exists boleto_completo text,
  add column if not exists mesma_data      boolean,
  add column if not exists diferenca_abs   numeric,
  add column if not exists diferenca_pct   numeric,
  add column if not exists confianca       text;

alter table public.suspeitas_pagamento_duplicado
  drop constraint if exists suspeitas_confianca_valida;
alter table public.suspeitas_pagamento_duplicado
  add constraint suspeitas_confianca_valida
  check (confianca is null or confianca in ('ALTA','MEDIA','BAIXA'));

comment on column public.suspeitas_pagamento_duplicado.confianca is
  'ALTA = mesmo boleto, mesma data, valor praticamente igual (assinatura de reimportacao). MEDIA = mesma data, valores distintos. BAIXA = datas diferentes (provavel pagamento residual, legitimo) ou valor zero.';

-- Enriquecimento das 29 linhas existentes. NAO toca status, motivo,
-- decidido_por_email, decidido_em nem historico_decisoes.
with m as (
  select g.numero_parcela_completo k,
         count(*) n, count(distinct g.data_pagamento) n_datas,
         max(g.valor_pago) vmax, min(g.valor_pago) vmin
    from public.pagamentos g
   where g.numero_parcela_completo is not null
     and coalesce(g.retroativo,false) = false
     and coalesce(g.valor_pago,0) > 0
     and not (coalesce(g.dados,'{}'::jsonb) ? 'estornado_em')
   group by 1 having count(*) > 1)
update public.suspeitas_pagamento_duplicado s
   set boleto_completo = m.k,
       mesma_data      = (m.n_datas = 1),
       diferenca_abs   = round(m.vmax - m.vmin, 2),
       diferenca_pct   = case when m.vmax > 0 then round((m.vmax - m.vmin) / m.vmax, 4) else 0 end,
       confianca       = case
          when m.vmin <= 0 then 'BAIXA'
          when m.n_datas > 1 then 'BAIXA'
          when (m.vmax - m.vmin) <= 1.00 or (m.vmax > 0 and (m.vmax - m.vmin)/m.vmax <= 0.01) then 'ALTA'
          when m.vmax > 0 and (m.vmax - m.vmin)/m.vmax <= 0.85 then 'MEDIA'
          else 'BAIXA' end,
       atualizado_em = now()
  from m where m.k = s.chave_grupo;

-- Deteccao futura com a regra validada. Todo o comportamento de reabertura e
-- de historico e preservado; o que entra e a classificacao.
create or replace function public.trg_detectar_suspeita_duplicidade()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
DECLARE
  v_chave text := NEW.numero_parcela_completo;
  v_qtd integer; v_datas integer; v_vmax numeric; v_vmin numeric;
  v_conf text; v_mesma boolean; v_dif numeric; v_pct numeric;
  s public.suspeitas_pagamento_duplicado%ROWTYPE;
BEGIN
  IF v_chave IS NULL OR NEW.retroativo IS TRUE OR COALESCE(NEW.valor_pago,0) <= 0
     OR (COALESCE(NEW.dados,'{}'::jsonb) ? 'estornado_em') THEN RETURN NEW; END IF;

  SELECT count(*), count(distinct p.data_pagamento), max(p.valor_pago), min(p.valor_pago)
    INTO v_qtd, v_datas, v_vmax, v_vmin
    FROM public.pagamentos p
   WHERE p.numero_parcela_completo = v_chave AND p.retroativo = false
     AND COALESCE(p.valor_pago,0) > 0
     AND NOT (COALESCE(p.dados,'{}'::jsonb) ? 'estornado_em');
  IF v_qtd < 2 THEN RETURN NEW; END IF;

  -- A REGRA VALIDADA: a DATA separa duplicata de residuo; o valor diz o quanto
  -- a duplicata e obvia (centavos de diferenca = reimportacao).
  v_mesma := (v_datas = 1);
  v_dif   := round(coalesce(v_vmax,0) - coalesce(v_vmin,0), 2);
  v_pct   := case when coalesce(v_vmax,0) > 0 then round(v_dif / v_vmax, 4) else 0 end;
  v_conf  := case
     when coalesce(v_vmin,0) <= 0 then 'BAIXA'
     when not v_mesma            then 'BAIXA'
     when v_dif <= 1.00 or v_pct <= 0.01 then 'ALTA'
     when v_pct <= 0.85          then 'MEDIA'
     else 'BAIXA' end;

  SELECT * INTO s FROM public.suspeitas_pagamento_duplicado WHERE chave_grupo = v_chave;
  IF NOT FOUND THEN
    INSERT INTO public.suspeitas_pagamento_duplicado
      (chave_grupo, titulo_numero, status, origem_deteccao, detectado_em, ultima_deteccao_em,
       boleto_completo, mesma_data, diferenca_abs, diferenca_pct, confianca)
    VALUES (v_chave, NEW.titulo_numero, 'PENDENTE_VALIDACAO', 'TRIGGER_INSERT', now(), now(),
            v_chave, v_mesma, v_dif, v_pct, v_conf)
    ON CONFLICT (chave_grupo) DO NOTHING;
    RETURN NEW;
  END IF;

  IF s.status = 'PENDENTE_VALIDACAO' THEN
    UPDATE public.suspeitas_pagamento_duplicado
       SET ultima_deteccao_em = now(), atualizado_em = now(),
           boleto_completo = v_chave, mesma_data = v_mesma,
           diferenca_abs = v_dif, diferenca_pct = v_pct, confianca = v_conf
     WHERE id = s.id;
  ELSE
    IF NOT (COALESCE(s.pagamentos_analisados,'[]'::jsonb) ? NEW.id::text) THEN
      UPDATE public.suspeitas_pagamento_duplicado SET status = 'PENDENTE_VALIDACAO',
        historico_decisoes = COALESCE(historico_decisoes,'[]'::jsonb) || jsonb_build_object(
          'status', s.status, 'motivo', s.motivo, 'pagamento_manter_id', s.pagamento_manter_id, 'pagamento_duplicado_id', s.pagamento_duplicado_id,
          'decidido_por_email', s.decidido_por_email, 'decidido_por_nome', s.decidido_por_nome, 'decidido_em', s.decidido_em,
          'reaberto_em', now(), 'reaberto_por_pagamento', NEW.id),
        motivo = NULL, pagamento_manter_id = NULL, pagamento_duplicado_id = NULL,
        decidido_por_email = NULL, decidido_por_nome = NULL, decidido_em = NULL,
        origem_deteccao = 'TRIGGER_INSERT_REABERTURA', ultima_deteccao_em = now(), atualizado_em = now(),
        boleto_completo = v_chave, mesma_data = v_mesma,
        diferenca_abs = v_dif, diferenca_pct = v_pct, confianca = v_conf
      WHERE id = s.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- ============================================================
-- ITEM 4. Origem explicita da baixa, para eventos FUTUROS.
-- ============================================================
-- `confirmado_por_email` nao serve como evidencia: o gatilho de importacao
-- grava 'extrato_santander' ali, entao "assinatura" nao distingue humano de
-- rotina. A coluna nova diz quem baixou, com valor controlado.
--
-- O historico NAO e preenchido por suposicao: fica NULL.

alter table public.parcelas
  add column if not exists origem_baixa      text,
  add column if not exists origem_baixa_ref  text,
  add column if not exists origem_baixa_em   timestamptz;

alter table public.parcelas drop constraint if exists parcelas_origem_baixa_valida;
alter table public.parcelas add constraint parcelas_origem_baixa_valida
  check (origem_baixa is null or origem_baixa in
    ('OPERADOR','ADM','GATILHO_IMPORTACAO','BAIXA_RELATORIO','IMPORTACAO_ACORDO','AUTOMACAO'));

comment on column public.parcelas.origem_baixa is
  'Quem deu a baixa, valor controlado. NULL no historico anterior a 12/09/2026 -- nao foi preenchido por suposicao. Substitui confirmado_por_email como evidencia de autoria.';
comment on column public.parcelas.origem_baixa_ref is
  'Identificador do evento ou do usuario: e-mail do operador, id do pagamento, id da importacao.';

create index if not exists ix_parcelas_origem_baixa
  on public.parcelas (origem_baixa) where origem_baixa is not null;
