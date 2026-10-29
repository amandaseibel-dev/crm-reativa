-- ============================================================================
-- J3 · I2 — TRAVA DE COBERTURA PARA O BASELINE DE `TIPO=ACORDO`
--
-- NÃO APLICADO. Aguarda autorização.
--
-- ⚠️⚠️ REGRA PROVISÓRIA ⚠️⚠️
-- O piso de 50% NÃO foi calibrado contra distribuição medida de extrações
-- completas da fatia de acordo, porque **nenhuma existe**: as 9 extrações
-- `TIPO=ACORDO` capturadas até 07/10/2026 têm de 3 a 26 títulos. O número 50%
-- é herdado da trava de `TIPO=TODOS` (`20261001183516`) de propósito: reusar o
-- piso que já existe evita inventar um segundo limiar com outra justificativa.
-- Quando houver uma extração completa da fatia, este piso deve ser revisto
-- contra o que ela medir. Até então, é prudência declarada, não calibração.
--
-- O QUE ESTE ARQUIVO FAZ: dá à trava de volume que já existe em
-- `extracao_validar` um SEGUNDO caso -- o recorte `TIPO=ACORDO` -- com o
-- denominador próprio daquela população. Nada mais.
--
-- O QUE ESTE ARQUIVO NÃO FAZ:
--   · não altera os limiares globais do I1 (`provisorio-2026-10-01`): aqueles
--     são faixas de AVALIAÇÃO (queda/alta de linhas, títulos, alunos, valor);
--     este é um piso de VALIDAÇÃO, outra decisão e outro momento;
--   · não valida nem auto-valida extração nenhuma;
--   · não altera as 15 extrações existentes -- zero DML;
--   · não faz backfill;
--   · não cria baseline. O baseline de `TIPO=ACORDO` só nasce de uma extração
--     realmente completa dessa população, em frente separada e autorizada.
--     A união dos arquivos diários NÃO serve de baseline.
--
-- POR QUE PRECISA EXISTIR (medido em produção em 07/10/2026):
--   · as 9 extrações `TIPO=ACORDO` são "os acordos do dia", não a fatia:
--     3 / 12 / 26 títulos (menor / mediana / maior), 7 delas no mesmo dia;
--   · a união das 9 cobre 66 documentos distintos;
--   · o universo da fatia tem 8.563 documentos (5.022 vencidas + 3.541 a
--     vencer), 2.077 alunos, R$ 11.051.121,87;
--   · logo a MAIOR extração cobre 0,30% do universo, a mediana 0,14% e a união
--     das 9 cobre 0,77%.
--   Validar qualquer uma delas à mão a tornaria baseline da sequência, e toda
--   extração seguinte seria comparada contra 26 títulos -- produzindo ausência
--   fabricada para os outros 8.537.
--
-- O DENOMINADOR, E POR QUE É `parcelas` E NÃO `acordos_titulos`:
--   auditado em 07/10 sobre os 66 documentos de acordo já capturados:
--     · 66 de 66 existem em `parcelas.boleto`;
--     · 0 de 66 existem em `acordos_titulos.documento`.
--   A fatia `Acordo` do relatório chega como '0'+boleto (12 dígitos) e mora em
--   `parcelas.boleto` (11), por isso a normalização por
--   `extracao_documento_norm`. Dos 66, hoje 46 estão `PAGO` -- pagaram DEPOIS
--   da captura, que é exatamente o que a trilha existe para observar, e é por
--   isso que o universo exclui `PAGO` e `CANCELADA`.
--
-- BASE DE PARTIDA: `extracao_validar` como está em produção em 07/10
--   md5(pg_get_functiondef(...)) = 4ca4c512fd0b0ad74185dc50e4908913
--   length = 2.588 chars
-- Conferir esse md5 ANTES de aplicar. Todo o resto do corpo é preservado
-- literalmente: o portão de gerência, a validação da decisão, o UPDATE, a
-- exigência de `TOTAL_PENDENTE_VALIDACAO` e o retorno.
-- ============================================================================

create or replace function public.extracao_validar(
  p_escopo_id uuid, p_decisao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_estado    text;
  v_e         public.extracao_escopo;
  v_universo  bigint;
  v_recorte   text;              -- qual recorte declarado tem piso de cobertura
  v_min       numeric := 0.50;   -- piso provisorio, calibravel por migration
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'Somente a gerencia pode validar um snapshot TOTAL: a validacao cria baseline.'
      using errcode = '42501';
  end if;
  if p_decisao not in ('VALIDAR','REPROVAR') then
    raise exception 'Decisão inválida: %', p_decisao using errcode = '22023';
  end if;

  -- ===== TRAVA DE COBERTURA (so para VALIDAR, so para completude TOTAL) =====
  -- Dois recortes tem universo mensuravel, e so eles tem piso:
  --   TIPO=TODOS  -> a carteira em aberto (regra de 20261001183516, intacta)
  --   TIPO=ACORDO -> as parcelas de acordo elegiveis (regra nova, PROVISORIA)
  -- TIPO=RECORTE e qualquer outro NAO tem piso, de proposito: sem universo
  -- conhecido nao ha percentual honesto a exigir. O que impede dois recortes
  -- diferentes de se compararem nao e esta trava -- e a igualdade de conjunto
  -- de tipos contra o baseline, no `extracao_lote_fechar`.
  --
  -- REPROVAR nunca passa por aqui: reprovar um snapshot pequeno e exatamente o
  -- que se quer que a gestao possa fazer.
  if p_decisao = 'VALIDAR' then
    select * into v_e from public.extracao_escopo where id = p_escopo_id;
    if v_e.id is not null and v_e.completude = 'TOTAL' then

      if v_e.scope_key like '%TIPO=TODOS%' then
        v_recorte := 'TIPO=TODOS';
        select count(distinct t.documento) into v_universo
          from public.acordos_titulos t
         where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');

      elsif v_e.scope_key like '%TIPO=ACORDO%' then
        v_recorte := 'TIPO=ACORDO';
        -- universo da fatia de acordo: documentos distintos de parcelas.boleto
        -- com status fora de PAGO e CANCELADA, normalizados.
        select count(distinct public.extracao_documento_norm(pa.boleto))
          into v_universo
          from public.parcelas pa
         where pa.boleto is not null
           and upper(coalesce(pa.status,'')) not in ('PAGO','CANCELADA');
      end if;

      if v_recorte is not null
         and coalesce(v_e.titulos_distintos,0) < v_min * coalesce(v_universo,0) then
        raise exception
          'Cobertura incompativel com o escopo declarado %: o snapshot tem % titulos e o universo elegivel tem % (% por cento; minimo % por cento). Marque PARCIAL ou REPROVAR.',
          v_recorte,
          coalesce(v_e.titulos_distintos,0), coalesce(v_universo,0),
          round(100.0*coalesce(v_e.titulos_distintos,0)/nullif(v_universo,0), 3),
          round(100*v_min,0)
          using errcode = '22023';
      end if;
    end if;
  end if;
  -- =========================================================================

  v_estado := case p_decisao when 'VALIDAR' then 'TOTAL_VALIDADO'
                             else 'TOTAL_REPROVADO' end;
  update public.extracao_escopo
     set estado = v_estado,
         validado_por = coalesce(auth.jwt() ->> 'email','desconhecido'),
         validado_em  = now(),
         validacao_motivo = coalesce(validacao_motivo,'{}'::jsonb)
           || jsonb_build_object('decisao_humana', p_decisao, 'motivo_humano', p_motivo)
   where id = p_escopo_id and completude = 'TOTAL'
     and estado = 'TOTAL_PENDENTE_VALIDACAO';
  if not found then
    raise exception 'Escopo % não está em TOTAL_PENDENTE_VALIDACAO.', p_escopo_id
      using errcode = '22023';
  end if;
  return jsonb_build_object('escopo_id', p_escopo_id, 'estado', v_estado);
end;
$$;

comment on function public.extracao_validar(uuid,text,text) is
  'J3: decisao humana sobre um snapshot TOTAL. Portao de gerencia. '
  'TRAVA DE COBERTURA, so no VALIDAR e so para completude TOTAL: TIPO=TODOS '
  'contra a carteira em aberto, TIPO=ACORDO contra as parcelas de acordo '
  'elegiveis. Piso de 50% PROVISORIO nos dois casos -- nao calibrado contra '
  'extracao completa, que ainda nao existe para a fatia de acordo. '
  'TIPO=RECORTE nao tem piso: sem universo conhecido nao ha percentual honesto.';
